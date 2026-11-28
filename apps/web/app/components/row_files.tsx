'use client'

import { isHosted, type P2pDm, type P2pRoom } from '../lib/place/place'
import { useLive, usePlace } from '../lib/place/react'
import { shownOf } from '../lib/place/shown'
import type { Message } from '../lib/types'
import { useVouchedFiles } from './forwards'
import { AttachmentList } from './p2p/p2p_files'

function ListFiles({
  m,
  place,
  canFetch,
}: {
  m: Message
  place: P2pRoom | P2pDm
  canFetch: boolean
}) {
  const shown = useLive(shownOf(place))
  const vouched = useVouchedFiles(m.forward?.p2p)
  const id = shown.idOf(m.id)
  const p = id === null ? undefined : shown.message(id)
  if (!p) return null
  return (
    <AttachmentList
      att={vouched ?? p.fwd?.att ?? p.att}
      canFetch={canFetch}
      own={!p.fwd && p.sender === shown.me}
      message={p.id}
    />
  )
}

// The files a place keeps with a message itself, under the message's text.
export function RowFiles({ m, canFetch }: { m: Message; canFetch: boolean }) {
  const place = usePlace()
  return place && !isHosted(place) ? <ListFiles m={m} place={place} canFetch={canFetch} /> : null
}
