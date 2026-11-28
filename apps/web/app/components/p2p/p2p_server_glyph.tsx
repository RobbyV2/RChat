'use client'

import { useRef, type ReactNode } from 'react'
import { useAvatarView, usePlays } from '../../lib/avatar_view'
import { useP2pAnimated, useP2pAnimation, useP2pServerPicture } from '../../lib/client/p2p_picture'
import type { P2pPic } from '../../lib/p2p/pictures'
import { PictureOver } from '../avatar_picture'

// A P2P server's icon with its uploaded picture over it, where this device shows pictures.
export function P2pServerGlyph({
  pic,
  animate = false,
  children,
}: {
  pic: P2pPic | undefined
  // Plays an animated picture without a pointer over it (a server's about page).
  animate?: boolean
  children: ReactNode
}) {
  const view = useAvatarView()
  const src = useP2pServerPicture(pic, view)
  const box = useRef<HTMLSpanElement>(null)
  const plays = usePlays(box, useP2pAnimated(pic, view), animate)
  const animation = useP2pAnimation(pic, plays)
  return (
    <PictureOver src={src} moving={animation} boxRef={box} size="fill">
      {children}
    </PictureOver>
  )
}
