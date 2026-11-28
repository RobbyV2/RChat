// Viewing choices belong to the local profile. Only the shared channel label comes from its host.
import { create } from 'zustand'
import { client } from './client/client'
import { readLocal, writeLocal, type InstanceConnection } from './instances'
import type { WsEvent } from './types'
import type { RChatState } from './store_types'

type Profile = Pick<RChatState, 'me' | 'guest'>
type ViewingInstance = Pick<InstanceConnection, 'origin' | 'scoped'>
export type ViewingTarget = {
  key: string
  kind: 'channel' | 'app'
  name: string
  sensitive: boolean
}

const guestProfiles = new Map<string, string>()
const guestKey = (connection: ViewingInstance) => connection.scoped('rchat_viewing_guest_v1')
const guestId = (connection: ViewingInstance) => {
  const key = guestKey(connection)
  const stored = readLocal(key)
  if (stored) return stored
  const cached = guestProfiles.get(key)
  if (cached) return cached
  const id = crypto.randomUUID()
  guestProfiles.set(key, id)
  writeLocal(key, id)
  return id
}

export const viewingKey = (
  account: string | null,
  parts: readonly (string | number)[],
  connection: ViewingInstance = client.homeInstance()
) =>
  connection.scoped(
    'rchat_viewing_v1:' +
      JSON.stringify([
        connection.origin,
        account === null ? ['guest', guestId(connection)] : ['account', account],
        ...parts,
      ])
  )

export const channelTarget = (
  account: string | null,
  transport: 'instance' | 'p2p',
  server: string,
  channel: { id: string | number; name?: string; sensitive?: boolean },
  connection: ViewingInstance = client.homeInstance()
): ViewingTarget => ({
  kind: 'channel',
  key: viewingKey(account, [transport, server, channel.id], connection),
  name: channel.name ?? `Channel ${channel.id}`,
  sensitive: channel.sensitive === true,
})

export const instanceTarget = (
  s: Profile &
    Pick<RChatState, 'servers'> &
    Partial<Pick<RChatState, 'channelLabelEpoch' | 'channelLabelEpochs'>>,
  server: string,
  id: number,
  connection: ViewingInstance = client.homeInstance()
) => {
  if ((s.channelLabelEpochs?.[server] ?? 0) !== (s.channelLabelEpoch ?? 0)) return null
  const channel = s.servers[server]?.channels.find(c => c.id === id)
  return channel
    ? channelTarget(s.me?.username ?? null, 'instance', server, channel, connection)
    : null
}

const minted = Symbol('view pass')

// Consent to view one target, given by this device's profile: the target is not marked, its
// choice is remembered, or its prompt was answered for this visit. Only `canView` and
// `requestViewing` make one.
export class ViewPass {
  constructor(
    key: typeof minted,
    readonly target: string
  ) {
    if (key !== minted) throw new TypeError('a view pass comes from the viewing consent')
  }
}

// The one screen that shows the prompt and answers it. `release` gives the place up.
export interface PromptHost {
  // Answers `prompt` while it is still the one asking.
  answer(prompt: { target: ViewingTarget }, open: boolean, remember: boolean): void
  release(): void
}

type Choice = { personal: boolean; remember: boolean }
const clean: Choice = { personal: false, remember: false }
export function createViewing(connection: ViewingInstance | (() => ViewingInstance)) {
  const instance = typeof connection === 'function' ? connection : () => connection
  const memory = new Map<string, Choice>()
  const choice = (key: string): Choice => {
    const cached = memory.get(key)
    if (cached) return cached
    let value = clean
    try {
      const saved = JSON.parse(readLocal(key) ?? 'null')
      if (saved?.v === 1)
        value = { personal: saved.personal === true, remember: saved.remember === true }
    } catch {
      /* Invalid choices use the defaults. */
    }
    memory.set(key, value)
    return value
  }

  // What the store shows of an open prompt. Its answer is not here: only the prompt's host
  // holds it.
  interface Prompt {
    target: ViewingTarget
  }
  let answer: ((open: boolean, remember: boolean) => void) | null = null
  let hosted = false
  const registerPromptHost = (): PromptHost | null => {
    if (hosted) return null
    hosted = true
    let held = true
    return {
      answer: (prompt, open, remember) => {
        if (held && useViewing.getState().prompt === prompt) answer?.(open, remember)
      },
      release: () => {
        if (held) hosted = false
        held = false
      },
    }
  }
  const useViewing = create<{ prompt: Prompt | null; revision: number }>(() => ({
    prompt: null,
    revision: 0,
  }))
  const changed = () => useViewing.setState(s => ({ revision: s.revision + 1 }))
  const save = (key: string, value: Choice) => {
    memory.set(key, value)
    writeLocal(key, value.personal || value.remember ? JSON.stringify({ v: 1, ...value }) : null)
  }

  const visits = new Set<string>()
  let appVisit: string | null = null
  const leaveAppVisit = () => {
    if (appVisit !== null) {
      appVisit = null
      changed()
    }
  }
  const personallyMarked = (t: ViewingTarget) => choice(t.key).personal
  const needsWarning = (t: ViewingTarget) => t.kind === 'app' || t.sensitive || personallyMarked(t)
  const canView = (t: ViewingTarget): ViewPass | null =>
    !needsWarning(t) ||
    choice(t.key).remember ||
    (t.kind === 'app' ? appVisit === t.key : visits.has(t.key))
      ? new ViewPass(minted, t.key)
      : null
  // Turns the open prompt down: `of` to do so only while it is the one asking about that target.
  const cancelViewing = (of?: ViewingTarget) => {
    if (!of || useViewing.getState().prompt?.target === of) answer?.(false, false)
  }
  const leaveVisit = (next?: string) => {
    const left = [...visits].filter(key => key !== next)
    for (const key of left) visits.delete(key)
    if (left.length) changed()
  }

  const forgetViewing = (t: ViewingTarget) => {
    visits.delete(t.key)
    if (appVisit === t.key) appVisit = null
    save(t.key, { ...choice(t.key), remember: false })
    changed()
  }

  const markPersonally = (t: ViewingTarget, personal: boolean) => {
    visits.delete(t.key)
    save(t.key, { personal, remember: false })
    changed()
  }

  const approveAppVisit = (target: ViewingTarget, remember: boolean) => {
    appVisit = target.key
    if (remember) save(target.key, { ...choice(target.key), remember: true })
    changed()
  }

  const requestViewing = (
    target: ViewingTarget,
    afterAppChoice?: (remember: boolean) => void
  ): Promise<ViewPass | null> => {
    cancelViewing()
    const held = canView(target)
    if (held) return Promise.resolve(held)
    return new Promise(resolve => {
      const prompt: Prompt = { target }
      const decide = (open: boolean, remember: boolean) => {
        if (useViewing.getState().prompt !== prompt) return
        answer = null
        if (open) {
          if (target.kind === 'app' && afterAppChoice) {
            appVisit = target.key
            afterAppChoice(remember)
          } else if (remember) save(target.key, { ...choice(target.key), remember: true })
          else if (target.kind === 'app') appVisit = target.key
          else visits.add(target.key)
        }
        useViewing.setState(s => ({ prompt: null, revision: s.revision + 1 }))
        resolve(open ? new ViewPass(minted, target.key) : null)
      }
      answer = decide
      useViewing.setState({ prompt })
    })
  }

  const endViewing = (endGuest = false) => {
    cancelViewing()
    leaveVisit()
    leaveAppVisit()
    memory.clear()
    if (endGuest) {
      const key = guestKey(instance())
      writeLocal(key, null)
      guestProfiles.delete(key)
    }
  }

  const syncViewingStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith('rchat_viewing_')) return
    if (event.key === null) {
      memory.clear()
      visits.clear()
      appVisit = null
    } else {
      memory.delete(event.key)
      visits.delete(event.key)
      if (appVisit === event.key) appVisit = null
    }
    changed()
  }

  return {
    useViewing,
    leaveAppVisit,
    personallyMarked,
    needsWarning,
    canView,
    cancelViewing,
    leaveVisit,
    forgetViewing,
    markPersonally,
    approveAppVisit,
    requestViewing,
    registerPromptHost,
    endViewing,
    syncViewingStorage,
    instanceTarget: (s: Parameters<typeof instanceTarget>[0], server: string, id: number) =>
      instanceTarget(s, server, id, instance()),
    get connection(): ViewingInstance {
      return instance()
    },
  }
}
// The home session shares viewing choices with the standalone widget and historical hooks.
export const defaultViewing = createViewing(() => client.homeInstance())
export const {
  useViewing,
  leaveAppVisit,
  personallyMarked,
  needsWarning,
  canView,
  cancelViewing,
  leaveVisit,
  forgetViewing,
  markPersonally,
  approveAppVisit,
  requestViewing,
  registerPromptHost,
  endViewing,
  syncViewingStorage,
} = defaultViewing
export const eventRoom = (ev: WsEvent) => {
  if (ev.type === 'ping' && ev.ping.scope.startsWith('c') && ev.ping.server)
    return { server: ev.ping.server, id: Number(ev.ping.scope.slice(1)) }
  if (
    ('dm_id' in ev || ev.type === 'message_updated') &&
    'server' in ev &&
    typeof ev.server === 'string' &&
    'channel_id' in ev &&
    typeof ev.channel_id === 'number'
  )
    return { server: ev.server, id: ev.channel_id }
  return null
}

// Removal notifications carry only IDs needed to discard files, including for closed rooms.
export const cleanupRemoval = (ev: WsEvent, forget: (id: number) => void) => {
  if (ev.type === 'media_removed') forget(ev.message_id)
  else if (ev.type === 'message_deleted') forget(ev.id)
  else if (ev.type === 'messages_deleted') ev.ids.forEach(forget)
  else return false
  return true
}
