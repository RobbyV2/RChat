'use client'

import { createContext } from 'react'
import { CAN_ALL, type ChannelCan } from '../channel_perms'
import type { Place } from './place'
import { useWatch } from './react'
import { channelCanIn, type ChannelKey } from './rights'

// What you hold in a channel of a hosted server or a P2P room.
export function useChannelCan(place: Place | null, channel: ChannelKey | null): ChannelCan {
  return useWatch(() => channelCanIn(place, channel), [place, channel])
}

// What the viewer holds in the channel a message list shows, for its rows and menus. A list
// outside a channel (a DM) holds nothing back.
export const ChannelCanContext = createContext<ChannelCan>(CAN_ALL)
