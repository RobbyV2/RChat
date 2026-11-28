import { hasBit, maskOr } from './perms'
import { ChannelPermBit, Perm, type Channel, type ServerDetail } from './types'

// A channel as an event or an update answer carries it has no `my_perms`: what you hold there
// only comes with the server's details, so the known value stays until they load again.
export const keepMyPerms = (known: Channel | undefined, next: Channel): Channel =>
  next.my_perms === undefined && known?.my_perms !== undefined
    ? { ...next, my_perms: known.my_perms }
    : next

// `channels` with `next` in place of the channel it updates.
export const withChannel = (channels: Channel[], next: Channel): Channel[] =>
  channels.map(c => (c.id === next.id ? keepMyPerms(c, next) : c))

// The composer's answer to a first thread reply without Start threads.
export const NO_THREADS_TEXT = 'You do not have permission to start threads in this channel.'

// What you hold in one channel, as the controls ask for it.
export interface ChannelCan {
  send: boolean
  react: boolean
  attach: boolean
  embed: boolean
  polls: boolean
  threads: boolean
  pin: boolean
  // Deleting other members' messages and closing their polls.
  manage: boolean
  mention: boolean
  connect: boolean
  speak: boolean
  video: boolean
  bypassSlowmode: boolean
}

const NAMES: Record<keyof ChannelCan, number> = {
  send: ChannelPermBit.SendMessages,
  react: ChannelPermBit.AddReactions,
  attach: ChannelPermBit.AttachFiles,
  embed: ChannelPermBit.EmbedLinks,
  polls: ChannelPermBit.CreatePolls,
  threads: ChannelPermBit.StartThreads,
  pin: ChannelPermBit.PinMessages,
  manage: Perm.DeleteMessages,
  mention: Perm.MentionEveryone,
  connect: ChannelPermBit.Connect,
  speak: ChannelPermBit.Speak,
  video: ChannelPermBit.Video,
  bypassSlowmode: ChannelPermBit.BypassSlowmode,
}

// The answers of a channel mask. Without View channels it holds nothing.
export const canOf = (mask: number): ChannelCan => {
  const seen = hasBit(mask, ChannelPermBit.ViewChannels)
  const out = {} as ChannelCan
  for (const key of Object.keys(NAMES) as (keyof ChannelCan)[])
    out[key] = seen && hasBit(mask, NAMES[key])
  return out
}

const every = (on: boolean): ChannelCan => {
  const out = {} as ChannelCan
  for (const key of Object.keys(NAMES) as (keyof ChannelCan)[]) out[key] = on
  return out
}
// A place without channel permissions (a DM), and one that isn't loaded or isn't yours.
export const CAN_ALL = every(true)
export const CAN_NONE = every(false)

const BASE_BITS: number[] = [
  ChannelPermBit.ViewChannels,
  ChannelPermBit.ReadHistory,
  ChannelPermBit.Connect,
  ChannelPermBit.Speak,
  ChannelPermBit.Video,
  ChannelPermBit.ViewMembers,
]
const SEND_BITS: number[] = [
  ChannelPermBit.SendMessages,
  ChannelPermBit.AddReactions,
  ChannelPermBit.AttachFiles,
  ChannelPermBit.EmbedLinks,
  ChannelPermBit.CreatePolls,
  ChannelPermBit.StartThreads,
]
const MOD_BITS: number[] = [
  Perm.DeleteMessages,
  Perm.MentionEveryone,
  ChannelPermBit.PinMessages,
  ChannelPermBit.BypassSlowmode,
]
const maskOf = (bits: number[]) => bits.reduce((mask, bit) => maskOr(mask, bit), 0)

// The mask of a hosted channel whose details carry no `my_perms`, from a server that reports
// none: what its read-only mark and your server permissions say, with Manage messages also
// pinning and skipping slow mode.
export const legacyMask = (readOnly: boolean, perms: number): number => {
  const messages = hasBit(perms, Perm.DeleteMessages)
  return maskOf([
    ...BASE_BITS,
    ...(readOnly ? [] : SEND_BITS),
    ...(messages ? [Perm.DeleteMessages] : []),
    ...(messages || hasBit(perms, Perm.PinMessages) ? [ChannelPermBit.PinMessages] : []),
    ...(hasBit(perms, Perm.MentionEveryone) ? [Perm.MentionEveryone] : []),
    ...(messages || hasBit(perms, Perm.ManageChannels) || hasBit(perms, Perm.BypassSlowmode)
      ? [ChannelPermBit.BypassSlowmode]
      : []),
  ])
}

// The mask of a hosted channel without rules of its own (a channel just created), from the
// server permissions `bits` the server reports for you (`ServerDetail.my_perms`): its private
// and read-only marks take View and the sending permissions, Manage channels gives every base
// permission and Bypass slow mode back, and without View it holds nothing.
export const unruledMask = (
  channel: Pick<Channel, 'restrict_view' | 'restrict_send'>,
  readOnly: boolean,
  bits: number
): number => {
  const closed: number[] = [
    ...(channel.restrict_view === true ? [ChannelPermBit.ViewChannels] : []),
    ...(channel.restrict_send === true || readOnly ? SEND_BITS : []),
  ]
  const own = [...BASE_BITS, ...SEND_BITS, ...MOD_BITS].filter(
    bit => hasBit(bits, bit) && !closed.includes(bit)
  )
  const pass = hasBit(bits, Perm.ManageChannels)
    ? [...BASE_BITS, ...SEND_BITS, ChannelPermBit.BypassSlowmode]
    : []
  const mask = maskOf([...own, ...pass])
  return hasBit(mask, ChannelPermBit.ViewChannels) ? mask : 0
}

// The mask the viewer holds in the hosted channel `channelId`, with their server permissions
// `perms`. The channel's own answer counts for a member of the server (`member`); a channel
// without one follows the server permissions the server reports (`ServerDetail.my_perms`). For
// anyone else, and on a server that reports neither, its read-only mark and `perms` decide.
export const hostedMask = (
  detail: ServerDetail | undefined,
  channelId: number | null,
  perms: number,
  member: boolean
): number => {
  const channel = detail?.channels.find(c => c.id === channelId)
  const marked = channelId !== null && (detail?.read_only?.includes(channelId) ?? false)
  if (member && channel?.my_perms !== undefined) return channel.my_perms
  if (member && channel && detail?.my_perms !== undefined)
    return unruledMask(channel, marked, detail.my_perms)
  return legacyMask(marked, perms)
}

// The mask our identity holds in channel `ch` of a P2P room: 0 unless we are joined, and null
// while the room or the channel is not loaded here.
export const p2pMask = (
  room: { me: string | null; channels: { id: string; perms: number }[] } | undefined,
  ch: string
): number | null => {
  if (!room) return null
  if (room.me !== 'join') return 0
  return room.channels.find(c => c.id === ch)?.perms ?? null
}
