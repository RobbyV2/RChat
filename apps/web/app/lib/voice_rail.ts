import type { RChatState } from './store_types'
import { channelTarget, type createViewing } from './viewing'

// The rail's voice badge: how many people are in the voice channels a server lists for this
// viewer, leaving out rooms closed by a viewing choice on this device. A hosted server counts
// only while its channel list is from the current label epoch. Pure.

type Viewing = Pick<ReturnType<typeof createViewing>, 'canView' | 'connection'>
type Hosted = Pick<
  RChatState,
  'servers' | 'voiceUsers' | 'voiceServers' | 'channelLabelEpoch' | 'channelLabelEpochs'
>
type Room = {
  channels: readonly { id: string; kind: string }[]
  voice: Record<string, readonly unknown[]>
}

// People in the listed voice channels that `open` lets this device show.
export const listedVoiceCount = <K extends string | number, C extends { id: K; kind: string }>(
  channels: readonly C[] | undefined,
  rosters: Partial<Record<K, readonly unknown[]>>,
  open: (c: C) => boolean
) => {
  let n = 0
  for (const c of channels ?? []) {
    const people = c.kind === 'voice' ? rosters[c.id] : undefined
    if (people?.length && open(c)) n += people.length
  }
  return n
}

const listCurrent = (s: Omit<Hosted, 'voiceUsers' | 'voiceServers'>, server: string) =>
  !!s.servers[server] && (s.channelLabelEpochs[server] ?? 0) === s.channelLabelEpoch

const rosterServers = (s: Pick<Hosted, 'voiceServers'>) => new Set(Object.values(s.voiceServers))

// The hosted servers with people in voice, by name.
export const hostedVoiceCounts = (s: Hosted, account: string | null, viewing: Viewing) => {
  const counts: Record<string, number> = {}
  for (const server of rosterServers(s)) {
    if (!listCurrent(s, server)) continue
    const n = listedVoiceCount(s.servers[server].channels, s.voiceUsers, c =>
      viewing.canView(channelTarget(account, 'instance', server, c, viewing.connection))
    )
    if (n) counts[server] = n
  }
  return counts
}

// Hosted servers with people in voice whose current channel list the rail needs.
export const voiceListsWanted = (s: Hosted) =>
  [...rosterServers(s)].filter(server => !listCurrent(s, server)).sort()

// The P2P rooms with people in voice, by room.
export const p2pVoiceCounts = (
  rooms: Record<string, Room>,
  visible: (room: string, ch: string) => boolean
) => {
  const counts: Record<string, number> = {}
  for (const [room, v] of Object.entries(rooms)) {
    const n = listedVoiceCount(v.channels, v.voice, c => visible(room, c.id))
    if (n) counts[room] = n
  }
  return counts
}

// A value worked out again only when one of its inputs is a different value.
export const memoLast = <R>() => {
  let inputs: readonly unknown[] | null = null
  let value: R | undefined
  return (next: readonly unknown[], compute: () => R): R => {
    if (inputs?.length !== next.length || !inputs.every((x, i) => Object.is(x, next[i]))) {
      inputs = next
      value = compute()
    }
    return value as R
  }
}

// One account's hosted counts, worked out again only when its rosters, channel lists, epochs or
// viewing choices (`revision`) change.
export const hostedVoiceCounter = (viewing: Viewing) => {
  const memo = memoLast<Record<string, number>>()
  return (s: Hosted & Pick<RChatState, 'me'>, revision: number) => {
    const account = s.me?.username ?? null
    return memo(
      [
        s.voiceUsers,
        s.voiceServers,
        s.servers,
        s.channelLabelEpoch,
        s.channelLabelEpochs,
        account,
        revision,
      ],
      () => hostedVoiceCounts(s, account, viewing)
    )
  }
}

// One P2P identity's counts, worked out again only when its rooms or viewing choices change.
export const p2pVoiceCounter = <S extends { servers: Record<string, Room>; account: unknown }>(
  visible: (s: S, room: string, ch: string) => boolean
) => {
  const memo = memoLast<Record<string, number>>()
  return (s: S, revision: number) =>
    memo([s.servers, s.account, revision], () =>
      p2pVoiceCounts(s.servers, (room, ch) => visible(s, room, ch))
    )
}

// The sum of the counts for the servers named.
export const voiceSum = (counts: Record<string, number>, names: readonly string[]) =>
  names.reduce((n, name) => n + (counts[name] ?? 0), 0)

// "3 in voice", or "Voice active" in streamer mode.
export const voiceBadgeTitle = (count: number, streamer: boolean) =>
  streamer ? 'Voice active' : `${count} in voice`

// What a tile's label says about voice.
export const voiceLabel = (count: number) => (count > 0 ? ', voice active' : '')
