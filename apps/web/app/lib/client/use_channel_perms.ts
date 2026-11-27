'use client'

import { createContext, useMemo } from 'react'
import { CAN_ALL, canOf, p2pMask, type ChannelCan, type PermPlace } from '../channel_perms'
import { channelMask } from '../selectors'
import { useStore } from '../store'
import { useP2p } from './p2p_react'

// What you hold in a channel, for the composer, reactions, polls, threads, pins and voice
// controls: your permissions in a hosted channel, or our identity's in a P2P channel. A place
// without channel permissions, or a P2P channel that is not loaded, holds nothing back.
export function useChannelPerms(place: PermPlace) {
  const hosted = place !== null && 'server' in place ? place : null
  const peer = place !== null && 'p2pRoom' in place ? place : null
  const hostedHeld = useStore(s => (hosted ? channelMask(s, hosted.server, hosted.channelId) : 0))
  const peerHeld = useP2p(s => (peer ? p2pMask(s.servers[peer.p2pRoom], peer.ch) : null))
  const mask = hosted ? hostedHeld : peerHeld
  return useMemo(() => (mask === null ? CAN_ALL : canOf(mask)), [mask])
}

// What the viewer holds in the channel a message list shows, for its rows and menus. A list
// outside a channel (a DM) holds nothing back.
export const ChannelCanContext = createContext<ChannelCan>(CAN_ALL)
