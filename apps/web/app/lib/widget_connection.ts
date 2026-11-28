import { revokeOnLeaving } from './own_loads'
import { clientOnly } from './instances'
import { ApiError, createApi } from './api'
import { guestSessionHeaders, postGuest } from './guest_chat'
import { readLocal, writeLocal } from './instances'
import { findMessageLinks } from './message_links'
import { RtcManager, JoinAborted } from './rtc'
import { voiceStatus, voiceStatusText, type SeatAudio } from './voice_status'
import type { MessageLocation, VoiceMsg, WsEvent } from './types'
import { parentOrigin, type WidgetMode, type WidgetRoom, type WidgetRoomMetadata } from './widgets'
import { sameSecret, Secret, TO_REQUEST } from './secret'
import { readToken, writeToken } from './client/credentials'
import { time } from './platform/time'
import { readJson } from './api/masks'
import { decode } from './api/gen'
import { arr, obj, opt, str, tagged, type Infer, type Parsed } from './schema'
import type { Cancel } from './clock'
import { cleanServers } from './ice'

// The widget socket's own frames, besides the realtime events it passes on.
const WIDGET_FRAME = tagged('type', {
  widget_ready: obj({ name: str() }),
  widget_refresh: obj({}),
  widget_mutes: obj({ users: arr(str()), staff: opt(arr(str())) }),
})

type Event = WsEvent | Infer<typeof WIDGET_FRAME>

const readEvent = (text: string): Parsed<Event> => {
  const value = readJson(text)
  const tag =
    typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : null
  return typeof tag === 'string' && tag.startsWith('widget_')
    ? WIDGET_FRAME.parse(value)
    : decode.WsEvent.parse(value)
}

const roomRevision = (room: WidgetRoomMetadata) => ({
  'X-Widget-Room-Revision': room.channel_id + '.' + (room.sensitive ? '1' : '0'),
})

const roomChanged = (error: unknown) => error instanceof ApiError && error.status === 412

const OPEN = 1

export class WidgetConnection {
  private api = createApi(location.origin + '/api', 'omit')
  private socket: WebSocket | null = null
  private ticket = ''
  private parent = parentOrigin()
  private readonly storageKey: string
  private token: Secret | null
  private grant: Secret | null
  private draftChannel: number | null = null
  private heldDraft: {
    channel: number
    account: string | null
    text: string
    expired: boolean
  } | null = null
  draft = { text: '' }
  account: string | null = null
  private stopped = false
  private sequence = 0
  private interval: Cancel | null = null
  private ice: RTCConfiguration = { iceServers: [] }
  readonly rtc = new RtcManager({ send: msg => this.signal(msg), ice: () => this.ice })
  readonly hideSend = new URLSearchParams(location.search).get('send') === 'off'
  metadata: WidgetRoomMetadata | null = null
  room: WidgetRoom | null = null
  linkCards = new Map<number, MessageLocation>()
  mode: WidgetMode | null = null
  name = ''
  error = ''
  loaded = false
  storage = true
  joining = false
  inVoice = false
  userMuted = false
  silenced: string[] = []
  // Of those, whom staff muted (the rest are timed out).
  staffMuted: string[] = []
  // What people in the call say about their own mic and sound, when not the default.
  audio: Record<string, SeatAudio> = {}

  constructor(
    private id: string,
    private redraw: () => void,
    private canView: (room: WidgetRoomMetadata, account: string | null) => boolean = () => true
  ) {
    this.rtc.onChange = redraw
    this.rtc.heardMuted = user => this.audio[user]?.muted === true
    this.storageKey = 'rchat_widget:' + id + ':' + this.parent
    this.token = readToken(this.storageKey)
    this.grant = readToken(this.storageKey + ':grant')
    const storageKey = 'rchat_widget_storage'
    this.storage = writeLocal(storageKey, '1') && readLocal(storageKey) === '1'
    if (this.storage) writeLocal(storageKey, null)
  }
  private get path() {
    return '/widgets/' + encodeURIComponent(this.id)
  }
  private get scope() {
    return { 'X-Widget-Session': this.ticket, 'X-Widget-Parent': this.parent ?? '' }
  }
  private get headers() {
    return {
      ...this.scope,
      ...(!this.token && this.metadata
        ? guestSessionHeaders({ api: this.api }, this.metadata.server, this.storageKey)
        : {}),
    }
  }
  get signedIn() {
    return this.account !== null
  }
  private changed() {
    if (!this.stopped) this.redraw()
  }
  async start() {
    try {
      if (clientOnly() || !this.parent || !/^[a-f0-9]{32}$/.test(this.id)) throw Error()
      const key = new URLSearchParams(location.hash.slice(1)).get('key')
      const session = await this.api.req<{ ticket: string; mode: WidgetMode }>(
        'POST',
        this.path + '/session',
        { parent: this.parent, read_key: key }
      )
      if (this.stopped) return
      this.ticket = session.ticket
      this.mode = session.mode
      this.api.setToken(this.token)
      this.api.setGrants(this.grant ? { widget: this.grant } : {})
      await this.refresh()
      if (!this.stopped) this.interval = time().every(30000, () => void this.refresh())
    } catch {
      if (!this.stopped) {
        this.loaded = true
        this.error = 'This widget is unavailable.'
        this.changed()
      }
    }
  }
  // Re-evaluate when local viewing settings change. Only authorized room metadata reaches
  // canView. A blocked room has no view request, live subscription or media connection.
  async refresh(reconnect = true, retryRevision = true) {
    const seq = ++this.sequence
    const token = this.token
    if (this.metadata && !this.canView(this.metadata, this.account)) this.hideContent()
    try {
      if (token && !this.account) {
        const me = await this.api.me()
        if (this.stopped || this.sequence !== seq) return
        this.account = me.username
        if (!this.mayRestore(me.username)) this.heldDraft = null
      }
      const metadata = await this.api.req<WidgetRoomMetadata>(
        'GET',
        this.path + '/room',
        undefined,
        this.scope
      )
      if (this.stopped || this.sequence !== seq) return
      this.metadata = metadata
      this.loaded = true
      if (!this.canView(metadata, this.account)) {
        this.hideContent()
        return
      }
      const room = await this.api.req<WidgetRoom>('GET', this.path + '/view', undefined, {
        ...this.headers,
        ...roomRevision(metadata),
      })
      if (this.stopped || this.sequence !== seq) return
      const confirmed = {
        server: room.server,
        channel_id: room.channel_id,
        kind: room.kind,
        sensitive: room.sensitive,
      }
      this.metadata = confirmed
      if (!this.canView(confirmed, this.account)) {
        this.hideContent()
        return
      }
      if (this.draftChannel !== room.channel_id) this.draft = { text: '' }
      this.draftChannel = room.channel_id
      if (this.heldDraft && this.heldDraft.channel !== room.channel_id) this.heldDraft = null
      if (this.room?.channel_id !== room.channel_id) this.linkCards = new Map()
      this.room = room
      void this.loadLinkCards(room, confirmed, seq, retryRevision)
      if (!this.token && !room.participate && (this.inVoice || this.joining)) this.release()
      if (reconnect && !this.socket) this.connect()
    } catch (error) {
      if (this.stopped || this.sequence !== seq || this.expired(token, error)) return
      const rediscover = retryRevision && roomChanged(error)
      const retry =
        error instanceof ApiError &&
        (error.status === 0 || error.status === 429 || error.status >= 500)
      await this.resetView(seq, reconnect, rediscover, retry || rediscover)
      return
    }
    this.changed()
  }
  // A changed room label closes the content and discovers the room once more.
  private async resetView(seq: number, reconnect: boolean, rediscover: boolean, keepDraft = false) {
    if (this.stopped || this.sequence !== seq) return
    this.metadata = null
    this.loaded = true
    this.hideContent(keepDraft)
    if (rediscover) await this.refresh(reconnect, false)
  }
  // Notices that arrive during a refresh lead to one more once it ends.
  private live: Promise<void> | null = null
  private liveAgain = false
  private liveRefresh() {
    if (this.live) {
      this.liveAgain = true
      return
    }
    this.live = this.refresh().finally(() => {
      this.live = null
      if (!this.liveAgain || this.stopped) return
      this.liveAgain = false
      this.liveRefresh()
    })
  }
  private async loadLinkCards(
    room: WidgetRoom,
    metadata: WidgetRoomMetadata,
    seq: number,
    retryRevision: boolean
  ) {
    const token = this.token
    const ids = new Set<number>()
    for (const message of room.messages) {
      if (message.no_previews) continue
      for (const { id, place } of findMessageLinks(message.content, [location.origin])) {
        if (
          place.kind === 'channel' &&
          place.server === room.server &&
          place.channelId === room.channel_id
        )
          ids.add(id)
      }
    }
    const pending = [...ids]
    // The previews shown keep their place until the new answer replaces them all.
    const cards = new Map<number, MessageLocation>()
    for (let i = 0; i < pending.length; i += 50) {
      if (this.stopped || this.sequence !== seq || !this.canView(metadata, this.account)) return
      try {
        const found = await this.api.req<MessageLocation[]>(
          'POST',
          this.path + '/locations',
          { ids: pending.slice(i, i + 50) },
          { ...this.scope, ...roomRevision(metadata) }
        )
        if (this.stopped || this.sequence !== seq || !this.canView(metadata, this.account)) return
        for (const card of found) cards.set(card.id, card)
      } catch (error) {
        if (this.sequence !== seq || this.expired(token, error)) return
        if (roomChanged(error)) await this.resetView(seq, true, retryRevision, true)
        return // The link remains usable when its preview is unavailable.
      }
    }
    this.linkCards = cards
    this.changed()
  }
  updateViewing() {
    if (!this.metadata || this.stopped) return
    if (!this.canView(this.metadata, this.account)) {
      this.sequence++
      this.hideContent()
    } else if (!this.room) void this.refresh()
  }
  private hideContent(keepDraft = false) {
    if (!keepDraft) {
      this.draft = { text: '' }
      this.draftChannel = null
    }
    this.room = null
    this.linkCards = new Map()
    this.closeSocket()
    this.release()
    this.changed()
  }
  private connect() {
    const url = new URL('/api/v1/ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('widget', this.id)
    const ws = this.api.socket(url.href)
    this.socket = ws
    ws.onopen = () => {
      if (this.socket !== ws) return
      ws.send(
        JSON.stringify({
          ticket: this.ticket,
          parent: this.parent,
          token: this.token?.reveal(TO_REQUEST) ?? null,
          grant: this.token ? null : (this.grant?.reveal(TO_REQUEST) ?? null),
        })
      )
    }
    ws.onmessage = e => {
      if (this.socket !== ws) return
      const read = readEvent(e.data as string)
      if (!read.ok) return
      const event = read.value
      switch (event.type) {
        case 'widget_ready':
          this.name = event.name
          // Catch room and permission changes between the first view and the live subscription.
          void this.refresh(false)
          break
        case 'widget_refresh':
          this.liveRefresh()
          return
        case 'voice_state':
          if (!this.room || event.channel_id !== this.room.channel_id) return
          this.room = { ...this.room, users: event.users }
          this.audio = Object.fromEntries(
            Object.entries(this.audio).filter(([u]) => event.users.includes(u))
          )
          if (this.joining && this.rtc.active() && event.users.includes(this.name)) {
            this.inVoice = true
            this.joining = false
          }
          if (this.inVoice) this.rtc.sync(event.users)
          break
        case 'rtc_signal':
          void this.rtc.onSignal(event.from, event.payload, {
            channelId: event.channel_id,
            dmId: event.dm_id,
          })
          return
        case 'widget_mutes':
          this.staffMuted = Array.isArray(event.staff) ? event.staff : []
          this.updateMutes(event.users)
          break
        case 'voice_muted':
          this.staffMuted = [
            ...this.staffMuted.filter(u => u !== event.username),
            ...(event.muted && event.staff === true ? [event.username] : []),
          ]
          this.updateMutes([
            ...this.silenced.filter(u => u !== event.username),
            ...(event.muted ? [event.username] : []),
          ])
          break
        case 'voice_audio': {
          if (!this.room || event.channel_id !== this.room.channel_id) return
          const { [event.username]: _was, ...rest } = this.audio
          const audio = { muted: event.muted === true, deafened: event.deafened === true }
          this.audio = audio.muted || audio.deafened ? { ...rest, [event.username]: audio } : rest
          this.rtc.noteMuted(event.username, audio.muted)
          break
        }
        case 'error':
          this.error = event.message
          break
      }
      this.changed()
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = null
      this.name = ''
      if (this.inVoice || this.joining) {
        this.error ||= 'Voice disconnected.'
        this.release()
      }
      // Recheck discovery and local viewing settings on disconnect. The timer retries the socket.
      void this.refresh(false)
      this.changed()
    }
  }
  private signal(msg: VoiceMsg) {
    if (this.socket?.readyState !== OPEN) return false
    this.socket.send(JSON.stringify(msg))
    return true
  }
  private updateMutes(users: string[]) {
    this.silenced = users
    if (this.rtc.active() && this.rtc.muted !== (this.userMuted || users.includes(this.name)))
      this.rtc.setMuted(this.userMuted || users.includes(this.name))
  }
  async join() {
    const room = this.room,
      ws = this.socket
    if (
      !room?.participate ||
      room.kind !== 'voice' ||
      !this.name ||
      this.joining ||
      this.inVoice ||
      !ws
    )
      return
    this.joining = true
    this.error = ''
    this.changed()
    try {
      const policyDocument = document as Document & {
        permissionsPolicy?: { allowsFeature: (feature: string) => boolean }
        featurePolicy?: { allowsFeature: (feature: string) => boolean }
      }
      const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy
      if (policy && !policy.allowsFeature('microphone'))
        throw Error('The host page must allow microphone access for this voice frame.')
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error(
          'Microphone access requires a secure connection and permission from the host page.'
        )
      await this.rtc.join(this.name, { channelId: room.channel_id })
      // Fetch the instance ICE policy before accepting or sending negotiation frames.
      const info = await this.api.discovery()
      const iceServers: RTCIceServer[] = info.ice?.stun?.length ? [{ urls: info.ice.stun }] : []
      if (this.token && info.ice?.turn) {
        const turn = await this.api.p2pIce()
        iceServers.push(...cleanServers(turn.ice_servers))
      }
      if (this.socket !== ws || !this.joining || !this.rtc.active()) return
      this.ice = { iceServers }
      const audio = { muted: this.userMuted, deafened: false }
      if (!this.signal({ type: 'voice_join', channel_id: room.channel_id, ...audio }))
        throw Error('Voice disconnected.')
    } catch (e) {
      if (this.socket !== ws || e instanceof JoinAborted) return
      this.error = e instanceof Error ? e.message : 'Could not join voice.'
      this.release()
      this.changed()
    }
  }
  mute() {
    if (!this.inVoice || this.silenced.includes(this.name)) return
    this.userMuted = !this.userMuted
    this.rtc.setMuted(this.userMuted)
    this.signal({ type: 'voice_audio', muted: this.userMuted, deafened: false })
    this.changed()
  }
  private release() {
    this.inVoice = false
    this.joining = false
    this.userMuted = false
    this.silenced = []
    this.staffMuted = []
    this.audio = {}
    this.rtc.leave()
  }
  // What the list in the frame says about someone's mic and sound.
  statusOf(user: string): string[] {
    const own = user === this.name
    const peer = own ? undefined : this.rtc.peer(user)
    const { mic, sound } = voiceStatusText(
      voiceStatus({
        self: own && this.inVoice,
        selfAudio: { muted: this.userMuted, deafened: false, restoreMute: false },
        live: peer ? { muted: peer.muted } : null,
        roster: this.audio[user] ?? null,
        forced: this.staffMuted.includes(user)
          ? 'staff'
          : this.silenced.includes(user)
            ? 'timeout'
            : null,
      }),
      own
    )
    return [mic, sound].filter((t): t is string => t !== null)
  }
  private closeSocket() {
    const ws = this.socket
    this.socket = null
    this.name = ''
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
  }
  leave() {
    this.closeSocket()
    this.release()
    void this.refresh()
  }
  get canPost() {
    return this.room?.kind === 'text' && this.room.participate && !this.hideSend
  }
  replyTarget(id: number) {
    return this.canPost
      ? this.room?.messages.find(m => m.id === id && m.kind === 'user')
      : undefined
  }
  async send(content: string, reply?: number) {
    const room = this.room
    if (!room || !this.canPost) throw Error('Posting is unavailable.')
    const token = this.token
    const body = { content, reply_to: reply }
    try {
      if (token) await this.api.req('POST', this.path + '/messages', body, this.headers)
      else
        await postGuest(
          { api: this.api },
          room.server,
          this.path + '/messages',
          body,
          this.scope,
          this.storageKey
        )
    } catch (error) {
      this.expired(token, error)
      throw error
    } finally {
      if (sameSecret(this.token, token) && !this.stopped) await this.refresh()
    }
  }
  async unlock(password: string) {
    const { grant } = await this.api.req<{ grant: string | null }>(
      'POST',
      this.path + '/guest-access',
      { password },
      this.headers
    )
    this.grant = Secret.from(grant)
    writeToken(this.storageKey + ':grant', this.grant)
    this.api.setGrants(this.grant ? { widget: this.grant } : {})
    await this.refresh()
  }
  async login(username: string, password: string) {
    const previous = this.token
    const { token: issued, user } = await this.api.login({ username, password })
    if (this.stopped || !sameSecret(this.token, previous)) return
    const token = Secret.of(issued)
    writeToken(this.storageKey, token)
    if (!this.mayRestore(user.username)) this.heldDraft = null
    await this.useSession(token, user.username)
  }
  logout() {
    const token = this.token
    this.heldDraft = null
    if (sameSecret(readToken(this.storageKey), token)) writeToken(this.storageKey, null)
    void this.useSession(null, null)
    if (token)
      void revokeOnLeaving(
        time(),
        () => this.api.logout(token),
        line => {
          this.error = line
          this.changed()
        }
      )
  }
  // Other copies of this widget under the same embedding origin share its saved sign-in.
  syncLogin = (event: StorageEvent) => {
    if (!this.storage || (event.key !== this.storageKey && event.key !== null)) return
    const saved = readToken(this.storageKey)
    if (this.stopped || sameSecret(saved, this.token)) return
    if (event.key === null) this.heldDraft = null
    else this.holdDraft(false)
    return this.useSession(saved, null)
  }
  private expired(token: Secret | null, error: unknown) {
    if (
      !token ||
      this.stopped ||
      !token.same(this.token) ||
      !(error instanceof ApiError && error.status === 401 && error.message === 'Unauthorized')
    )
      return false
    const saved = readToken(this.storageKey)
    this.holdDraft(true)
    if (saved && !saved.same(token)) {
      void this.useSession(saved, null)
      return true
    }
    if (token.same(saved)) writeToken(this.storageKey, null)
    void this.useSession(null, null)
    return true
  }
  // Unsent text survives a sign-in change it did not ask for until the person restores or
  // discards it. Another account never gets it.
  private holdDraft(expired: boolean) {
    if (this.draftChannel === null || !this.draft.text.trim()) return
    this.heldDraft = {
      channel: this.draftChannel,
      account: this.account,
      text: this.draft.text,
      expired,
    }
  }
  private mayRestore(account: string | null) {
    const held = this.heldDraft?.account ?? null
    return held === null || account === null || held === account
  }
  get canRestoreDraft() {
    return (
      this.canPost &&
      this.heldDraft !== null &&
      this.room?.channel_id === this.heldDraft.channel &&
      this.mayRestore(this.account)
    )
  }
  get draftExpired() {
    return !!this.heldDraft?.expired
  }
  // What the frame says while it holds text it cannot send here.
  get heldNotice() {
    if (!this.heldDraft || this.canRestoreDraft) return null
    return (
      (this.heldDraft.expired ? 'Your sign-in expired.' : 'Your sign-in changed.') +
      ' Sign in again to send your unsent text.'
    )
  }
  recoverDraft(restore: boolean) {
    if (!this.canRestoreDraft || !this.heldDraft) return
    this.draft = { text: restore ? this.heldDraft.text : '' }
    this.heldDraft = null
    this.changed()
  }
  private useSession(token: Secret | null, account: string | null) {
    this.token = token
    this.account = account
    // A queued guest send keeps the credentials it started with.
    this.api = createApi(location.origin + '/api', 'omit')
    this.api.setToken(token)
    this.api.setGrants(this.grant ? { widget: this.grant } : {})
    this.metadata = null
    this.hideContent()
    if (this.ticket) return this.refresh()
  }
  destroy() {
    this.stopped = true
    this.interval?.()
    this.rtc.onChange = () => {}
    this.closeSocket()
    this.release()
  }
}
