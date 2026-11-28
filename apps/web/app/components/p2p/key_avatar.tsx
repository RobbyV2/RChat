'use client'

import { useMemo } from 'react'
import { minidenticon } from 'minidenticons'
import { identiconInk } from '../../lib/identicon'
import { validColor } from '../../lib/profile'
import type { Person } from '../../lib/people'

// Identicons come from the identity key, so a look-alike name never gets the same picture. A
// member's own background sits behind it; a color avatar is a disc of that color with the key
// identicon as a mark in its corner, so the key-derived picture always shows.
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
  const { username: ik, avatar_kind: kind, avatar_color: bg } = person
  const shade = validColor(bg) ? bg.toLowerCase() : null
  const disc = kind === 'color' && shade !== null
  const src = useMemo(() => {
    const svg =
      shade && !disc
        ? minidenticon(ik, 95, 45).replace(/fill="[^"]*"/, `fill="${identiconInk(ik, shade)}"`)
        : minidenticon(ik, 95, 45)
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  }, [ik, shade, disc])
  if (disc) {
    const dot = Math.max(12, Math.round(size * 0.45))
    return (
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
    )
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={`${mark}shrink-0 rounded-full bg-surface-container-highest`}
      style={shade ? { backgroundColor: shade } : undefined}
    />
  )
}
