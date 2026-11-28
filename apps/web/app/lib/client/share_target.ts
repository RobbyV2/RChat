import type { AccountSession } from './session'
import type { P2pApp } from '../p2p/app/runtime'
import { chatKey } from '../p2p/app/store'
import { dmRoomId } from '../p2p/dm'
import { displayName } from '../p2p/contacts'
import { LIMITS } from '../p2p/content'
import { limitsOf } from '../instance_limits'
import { startMode } from '../attachments'
import { readOnly } from '../reactions'
import { sourceAccess } from '../forward_viewing'
import { client } from './client'
import { allowsAccountOrigin } from './hosted_policy'
import { time } from '../platform/time'
import {
  labelWith,
  p2pName,
  personCalled,
  roomName,
  serverName,
  unnamed,
  type NameLabel,
  type NameLabeller,
  notAName,
} from '../names'

// Keep a one-use worker ticket through the normal signed-out startup redirect.
export function shareLoginHref(href: string, search: string) {
  const ticket = new URLSearchParams(search).get('receive-share')
  if (!ticket) return href
  const target = new URL(href, 'https://local.invalid')
  target.searchParams.set('receive-share', ticket)
  return target.pathname + target.search
}

export type SharedContent = { text: string; files: File[] }
export type ShareOwner = { account: AccountSession; identity: P2pApp | null }
type Room =
  | { kind: 'dm'; id: number }
  | { kind: 'channel'; server: string; id: number }
  | { kind: 'peer'; ik: string }
  | { kind: 'peer_channel'; server: string; id: string }
export type ShareRoom = Room & { label: string; key: string; reason: string | null }

export function shareRooms(
  { account, identity }: ShareOwner,
  files: readonly File[],
  // Makes the labels. Without it, or in streamer mode on this device or that account, a room is
  // called by its kind and a number.
  say: NameLabeller | null = null,
  streamer = client.device.streamer
): ShareRoom[] {
  const s = account.store.getState()
  if (!s.me || s.guest || !allowsAccountOrigin(account.conn.origin)) return []
  const rooms: ShareRoom[] = []
  const counts = { dm: 0, channel: 0, peer: 0, peer_channel: 0 }
  const names = {
    dm: 'Direct message',
    channel: 'Channel',
    peer: 'Peer contact',
    peer_channel: 'Peer channel',
  }
  const add = (room: Room, named: (say: NameLabeller) => NameLabel, reason: string | null) => {
    const numbered = notAName(names[room.kind] + ' ' + ++counts[room.kind])
    const label = say === null || s.streamer || streamer ? numbered : named(say)
    rooms.push({ ...room, key: JSON.stringify(room), label, reason })
  }
  if (!identity) {
    const maximum = limitsOf(s.instance).upload_bytes
    const attach = (key: string, textOnly = false) => {
      if (!files.length) return null
      if (textOnly) return 'This channel allows text only.'
      if (s.pending[key]) return 'This draft already has an attachment.'
      const mode = startMode(s.settings, files[0].size, maximum)
      if (!mode || (mode === 'server' && files[0].size > maximum))
        return 'This attachment is unavailable here.'
      return null
    }
    for (const dm of s.dms)
      if (!dm.closed && !s.blocked[dm.other.username])
        add(
          { kind: 'dm', id: dm.id },
          say =>
            dm.is_self
              ? unnamed('Notes to yourself')
              : say(personCalled(dm.other.display_name, dm.other.username)),
          attach('d' + dm.id)
        )
    for (const member of s.me.servers) {
      const detail = s.servers[member.name]
      if (!detail || (member.timed_out_until ?? 0) * 1000 > time().now()) continue
      for (const c of detail.channels)
        if (
          c.kind === 'text' &&
          !readOnly(detail, c.id) &&
          sourceAccess(
            s,
            { kind: 'channel', id: c.id, server: member.name },
            c.sensitive,
            account
          ) === 'open'
        )
          add(
            { kind: 'channel', server: member.name, id: c.id },
            say => labelWith`${say(serverName(member))} / #${say.covered(c.name, 'channel')}`,
            attach('c' + c.id, c.text_only)
          )
    }
    return rooms
  }
  if (!s.settings.p2p || account.identities.get(identity.localId) !== identity) return []
  const peer = identity.useP2p.getState()
  if (
    !peer.enabled ||
    !peer.me ||
    peer.reader ||
    peer.elsewhere ||
    peer.status === 'moved' ||
    peer.movingAt !== null
  )
    return []
  const attach = (key: string, textOnly = false) =>
    !files.length
      ? null
      : textOnly || (!s.settings.asset_uploads && !s.settings.p2p_attachments)
        ? 'Only text can be shared here.'
        : (peer.attaching[key]?.length ?? 0) + files.length > LIMITS.att
          ? 'Too many attachments for this draft.'
          : null
  for (const c of peer.contacts)
    if (c.state === 'mutual' && !c.ignored) {
      const room = dmRoomId(peer.me, c.ik)
      if (!peer.rooms[room]?.full)
        add({ kind: 'peer', ik: c.ik }, say => say(p2pName(displayName(c))), attach(room))
    }
  for (const server of Object.values(peer.servers))
    if (server.me === 'join' && !server.readOnly && !server.upgraded && !server.full) {
      for (const c of server.channels)
        if (
          c.kind === 'text' &&
          c.send &&
          sourceAccess(
            s,
            { kind: 'p2p', identity: identity.localId, room: server.id, ch: c.id },
            c.sensitive,
            account
          ) === 'open'
        )
          add(
            { kind: 'peer_channel', server: server.id, id: c.id },
            say => labelWith`${say(roomName(server.name))} / #${say.covered(c.name, 'channel')}`,
            attach(chatKey({ room: server.id, ch: c.id }), c.text_only)
          )
    }
  return rooms
}

// Only stage content after navigation and a fresh owner, room and permission check.
export async function attachShare(
  owner: ShareOwner,
  key: string,
  payload: SharedContent,
  current: () => boolean
) {
  const { account, identity } = owner
  if (!identity && payload.files.length > 1) return false
  const epoch = account.lifetime.sessionMark()
  const room = shareRooms(owner, payload.files).find(r => r.key === key)
  if (!current() || !room || room.reason || !client.live().includes(account)) return false
  if (identity) account.identities.show(identity)
  if (!client.show(account)) return false
  if (identity) client.accounts.reconcile()
  else account.identities.viewed()?.p2p.closeHome()
  const intent = client.actorSelectionMark()
  const selected = () =>
    current() &&
    client.canWritePage(account) &&
    client.actorSelectionMark() === intent &&
    account.lifetime.sessionMark() === epoch &&
    (!identity || account.identities.viewed() === identity)
  const s = account.store.getState()
  if (room.kind === 'dm') await s.openDm(room.id)
  else if (room.kind === 'channel')
    await s.openChannel(room.server, room.id, 'push', undefined, undefined, selected)
  else if (room.kind === 'peer') await identity!.p2pDm.openDm(room.ik, 'home', selected)
  else await identity!.p2pServer.open(room.server, room.id, selected)
  if (!selected() || !shareRooms(owner, payload.files).some(r => r.key === key && !r.reason))
    return false
  const append = (draft: string | undefined) => [draft, payload.text].filter(Boolean).join('\n')
  if (identity) {
    if (account.identities.viewed() !== identity) return false
    const peer = identity.useP2p.getState(),
      chat = peer.chat
    if (!chat || !peer.me) return false
    if (
      room.kind === 'peer'
        ? chat.ch || chat.room !== dmRoomId(peer.me, room.ik)
        : room.kind !== 'peer_channel' || chat.room !== room.server || chat.ch !== room.id
    )
      return false
    const target = chatKey(chat)
    if (payload.text) identity.p2pDm.setDraft(target, append(peer.drafts[target]))
    if (payload.files.length) identity.p2pFiles.add(target, payload.files)
  } else {
    const state = account.store.getState(),
      view = state.view
    if (
      room.kind === 'dm'
        ? view?.kind !== 'dm' || view.dmId !== room.id
        : room.kind !== 'channel' ||
          view?.kind !== 'channel' ||
          view.server !== room.server ||
          view.channelId !== room.id
    )
      return false
    if (room.kind !== 'dm' && room.kind !== 'channel') return false
    const target = (room.kind === 'dm' ? 'd' : 'c') + room.id
    if (payload.text) state.setDraft(target, append(state.drafts[target]))
    if (payload.files.length) state.uploadFile(target, payload.files[0])
  }
  return true
}
