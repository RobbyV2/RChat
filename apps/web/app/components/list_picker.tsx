'use client'

import { chat } from '../lib/place/chat'
import { featureAt, isUnsupported } from '../lib/place/feature'
import { isHosted, type P2pDm, type P2pRoom } from '../lib/place/place'
import { useLive, usePlace } from '../lib/place/react'
import { reactPickOf } from '../lib/place/shown'
import { EmojiPicker } from './emoji_picker'

function PeerPicker({ place }: { place: P2pRoom | P2pDm }) {
  const picking = reactPickOf(place)
  const pick = useLive(picking)
  if (!pick) return null
  return (
    <EmojiPicker
      anchor={pick.anchor?.isConnected ? pick.anchor : null}
      side="top"
      align="end"
      label="Add reaction"
      onPick={emoji => {
        const here = featureAt(chat, place)
        if (!isUnsupported(here)) here.toggleReaction(pick.m, emoji, false)
      }}
      onClose={() => picking.set(null)}
    />
  )
}

// The reaction picker of the list around it, in a place whose lists each hold their own.
export function ListReactPicker() {
  const place = usePlace()
  return place && !isHosted(place) ? <PeerPicker place={place} /> : null
}
