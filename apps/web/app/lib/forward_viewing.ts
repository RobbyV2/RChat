import { locatedNow, type Located } from './forward_locate'
import {
  hostedSourceNames,
  p2pSourceNames,
  type ForwardClip,
  type ForwardSource,
  type SourceNames,
} from './forward'
import type { AccountSession } from './client/session'
import type { RChatState } from './store_types'
import type { ForwardRef, Message } from './types'
import { canView, channelTarget, type ViewingTarget } from './viewing'

export type SourceAccess = 'open' | 'hidden' | 'unknown'

export const sourceServer = (s: RChatState, id: number) =>
  Object.values(s.servers).find(d => d.channels.some(c => c.id === id))?.name

// The channel a copy names, decided by the label it carries. Copies from direct messages
// and from rooms the copy doesn't name have nothing to decide.
export const carriedTarget = (
  fwd: Pick<ForwardRef, 'origin_dm' | 'origin_channel_id' | 'origin_sensitive'>,
  account: string | null,
  server: string,
  connection?: Parameters<typeof channelTarget>[4]
): ViewingTarget | null =>
  fwd.origin_dm || fwd.origin_channel_id == null
    ? null
    : channelTarget(
        account,
        'instance',
        server,
        { id: fwd.origin_channel_id, sensitive: fwd.origin_sensitive === true },
        connection
      )

// A frame shows a copy from its own room, and from another room open in its profile.
export const frameCopyTarget = (
  fwd: Pick<ForwardRef, 'origin_dm' | 'origin_channel_id' | 'origin_sensitive'>,
  room: { server: string; channel_id: number },
  account: string | null,
  connection: Parameters<typeof channelTarget>[4]
) =>
  fwd.origin_channel_id === room.channel_id
    ? null
    : carriedTarget(fwd, account, room.server, connection)

export const frameCopyOpen = (...args: Parameters<typeof frameCopyTarget>) => {
  const target = frameCopyTarget(...args)
  return !target || canView(target)
}

// `label`: the source's shared label as a copy carries it, used for servers this client
// hasn't loaded.
export const sourceTarget = (
  s: RChatState,
  source: ForwardSource | undefined,
  label: boolean | undefined,
  account: AccountSession
): ViewingTarget | null => {
  const { viewing } = account
  if (source?.kind === 'p2p') {
    const app = account.identities.get(source.identity)
    return app?.isCurrent()
      ? (app.peerTarget(app.useP2p.getState(), source.room, source.ch) ?? null)
      : null
  }
  if (source?.kind !== 'channel') return null
  const server = sourceServer(s, source.id) ?? source.server
  if (!server) return null
  return !s.servers[server] && label !== undefined
    ? channelTarget(
        s.me?.username ?? null,
        'instance',
        server,
        { id: source.id, sensitive: label },
        viewing.connection
      )
    : viewing.instanceTarget(s, server, source.id)
}

export const sourceAccess = (
  s: RChatState,
  source: ForwardSource | undefined,
  label: boolean | undefined,
  account: AccountSession
): SourceAccess => {
  if (source?.kind === 'direct')
    return !source.identity || account.identities.get(source.identity)?.isCurrent()
      ? 'open'
      : 'unknown'
  const target = sourceTarget(s, source, label, account)
  return target ? (account.viewing.canView(target) ? 'open' : 'hidden') : 'unknown'
}

export const clipAllowed = (s: RChatState, clip: ForwardClip, account: AccountSession) =>
  sourceAccess(s, clip.source, undefined, account) === 'open' &&
  (!clip.quoted || sourceAccess(s, clip.quoted, undefined, account) === 'open')

export function clearHiddenForward(account: AccountSession, s = account.store.getState()) {
  const clip = s.forwardClip
  if (
    clip &&
    [clip.source, clip.quoted].some(
      source => sourceAccess(s, source, undefined, account) === 'hidden'
    )
  )
    s.clearForward()
}

// Only same-server public origins carry a channel label. Other copies can locate their
// original through the viewer's authorized metadata lookup.
export const quoteSource = (
  s: RChatState,
  m: Pick<Message, 'forward' | 'channel_id'>,
  destination?: string
): ForwardSource | undefined => {
  const f = m.forward
  if (!f) return undefined
  if (f.origin_dm || f.origin === 'Direct message') return { kind: 'direct' }
  const server = destination ?? (m.channel_id == null ? undefined : sourceServer(s, m.channel_id))
  if (f.origin_channel_id) return { kind: 'channel', id: f.origin_channel_id, server }
  const name = f.origin_channel ?? /^#(.+?) (?:-|·) /.exec(f.origin ?? '')?.[1]
  const channel = server && s.servers[server]?.channels.find(c => c.name === name)
  return channel ? { kind: 'channel', server, id: channel.id } : undefined
}

// A delivered snapshot survives the removal of an original or access to it: a copy that can't
// be traced reads like one from a direct message.
export const locatedQuote = (found: Located): ForwardSource =>
  found.kind === 'channel'
    ? { kind: 'channel', server: found.server, id: found.id }
    : { kind: 'direct' }

// Where a clip is from, as its sender sees it now: a P2P room as the identity holds it, an
// instance channel as the server answered its lookup (null until it has).
export const clipSourceNames = (
  account: AccountSession,
  clip: Pick<ForwardClip, 'source' | 'id'>
): SourceNames | null => {
  const source = clip.source
  if (source?.kind === 'p2p') {
    const app = account.identities.get(source.identity)
    return p2pSourceNames(app?.useP2p.getState().servers[source.room], source.ch)
  }
  if (source?.kind !== 'channel') return null
  const found = locatedNow(account, clip.id)
  return found?.kind === 'channel' ? hostedSourceNames(found.shown) : null
}
