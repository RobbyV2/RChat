'use client'

import type { ReactNode } from 'react'
import { useAvatarView } from '../../lib/avatar_view'
import { useP2pServerPicture } from '../../lib/client/p2p_picture'
import type { P2pPic } from '../../lib/p2p/pictures'
import { PictureOver } from '../avatar_picture'

// A P2P server's icon with its uploaded picture over it, where this device shows pictures.
export function P2pServerGlyph({
  pic,
  children,
}: {
  pic: P2pPic | undefined
  children: ReactNode
}) {
  const src = useP2pServerPicture(pic, useAvatarView())
  return (
    <PictureOver src={src} size="fill">
      {children}
    </PictureOver>
  )
}
