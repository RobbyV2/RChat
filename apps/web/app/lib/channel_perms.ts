import type { Channel, ChannelPerm, ChannelPermInput } from './types'

// A channel as an event or an update answer carries it has no `my_perms`: what you hold there
// only comes with the server's details, so the known value stays until they load again.
export const keepMyPerms = (known: Channel | undefined, next: Channel): Channel =>
  next.my_perms === undefined && known?.my_perms !== undefined
    ? { ...next, my_perms: known.my_perms }
    : next

// `channels` with `next` in place of the channel it updates.
export const withChannel = (channels: Channel[], next: Channel): Channel[] =>
  channels.map(c => (c.id === next.id ? keepMyPerms(c, next) : c))

export type RuleFlag = 'can_view' | 'can_send' | 'can_read_history'

// A rule as listed with one flag turned over. It keeps the masks and mode it was listed with, so
// the server changes only that flag's permissions and refuses it if the rule changed meanwhile.
export const toggledRule = (perm: ChannelPerm, flag: RuleFlag): ChannelPermInput => ({
  ...perm,
  [flag]: !perm[flag],
})
