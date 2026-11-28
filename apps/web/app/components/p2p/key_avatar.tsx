'use client'

import { useMemo } from 'react'
import { minidenticon } from 'minidenticons'
import { identiconInk } from '../../lib/identicon'
import { validColor } from '../../lib/profile'
import { builtIn } from '../../lib/avatar_setting'
import { useAvatarView } from '../../lib/avatar_view'
import { useP2pPicture } from '../../lib/client/p2p_picture'
import { PictureOver } from '../avatar_picture'
import type { Person } from '../../lib/people'

// Identicons come from the identity key, so a look-alike name never gets the same picture. A
// member's own background sits behind it; a color avatar is a disc of that color with the key
// identicon as a mark in its corner, so the key-derived picture always shows. Their uploaded
// picture lies over it where this device shows pictures.
export function KeyAvatar({
  person,
  size = 36,
  covered = false,
}: {
  person: Person
  size?: number
  // A picture streamer mode hides: the viewer's own, outside a chat.
  covered?: boolean
}) {
  const mark = covered ? 'streamer ' : ''
  const view = useAvatarView()
  const { username: ik } = person
  const { kind, color: bg } = builtIn(person, view.mode)
  const shade = validColor(bg) ? bg.toLowerCase() : null
  const disc = kind === 'color' && shade !== null
  const src = useMemo(() => {
    const svg =
      shade && !disc
        ? minidenticon(ik, 95, 45).replace(/fill="[^"]*"/, `fill="${identiconInk(ik, shade)}"`)
        : minidenticon(ik, 95, 45)
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }, [ik, shade, disc])
  const picture = useP2pPicture(ik, person.avatar_pic, size, view)
  const dot = Math.max(12, Math.round(size * 0.45))
  return (
    <PictureOver src={picture} size={size}>
      {disc ? (
        <span
          className={`${mark}relative inline-block shrink-0 rounded-full`}
          style={{ width: size, height: size, backgroundColor: shade }}
        >
          <img
            src={src}
            alt=""
            width={dot}
            height={dot}
            draggable={false}
            className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface-container-highest ring-2 ring-surface-container-low"
          />
        </span>
      ) : (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className={`${mark}shrink-0 rounded-full bg-surface-container-highest`}
          style={shade ? { backgroundColor: shade } : undefined}
        />
      )}
    </PictureOver>
  )
}
