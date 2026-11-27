import { CAN_ALL, canOf, p2pMask, type ChannelCan } from '../channel_perms'
import { channelMask } from '../selectors'
import { defineFeature, featureAt, isUnsupported } from './feature'
import { constant, derived, fromStore, type Live } from './live'
import type { Place } from './place'

// A channel as its place keys it: a number in a hosted server, a string in a P2P room.
export type ChannelKey = number | string

// What you hold in the channels of a place, for the composer, reactions, polls, threads, pins
// and voice controls. Both sides answer from a channel mask in the canonical bits.
export interface Rights {
  can: (channel: ChannelKey) => Live<ChannelCan>
}

const all = constant(CAN_ALL)
// A place without channel permissions (a DM) holds nothing back.
const open: Rights = { can: () => all }

export const rights = defineFeature<Rights>('rights', {
  hostedServer: ({ account, server }) => ({
    can: channel =>
      derived(
        fromStore(account.store, s =>
          channelMask(s, server, typeof channel === 'number' ? channel : null)
        ),
        canOf
      ),
  }),
  // Our identity holds nothing unless it is joined, and nothing is held back while the room or
  // the channel is not loaded here.
  p2pRoom: ({ app, room }) => ({
    can: channel =>
      derived(
        fromStore(app.useP2p, s => p2pMask(s.servers[room], String(channel))),
        mask => (mask === null ? CAN_ALL : canOf(mask))
      ),
  }),
  hostedDm: () => open,
  p2pDm: () => open,
})

// What you hold in `channel` of `place`. Without a place or a channel nothing is held back.
export const channelCanIn = (place: Place | null, channel: ChannelKey | null): Live<ChannelCan> => {
  const here = place === null || channel === null ? null : featureAt(rights, place)
  return here === null || channel === null || isUnsupported(here) ? all : here.can(channel)
}
