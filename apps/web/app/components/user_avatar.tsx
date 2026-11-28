'use client'

import { useMemo } from 'react'
import { User } from 'lucide-react'
import { identiconBackground, identiconSvg } from '../lib/identicon'
import type { Person } from '../lib/people'

interface Props {
  person: Person
  size?: number
}

// The picture of an account, as the person given is drawn.
export function UserAvatar({ person, size = 32 }: Props) {
  const { username, avatar_kind: avatarKind, avatar_color: avatarColor } = person
  const background = identiconBackground(avatarKind, avatarColor)
  const src = useMemo(
    () =>
      avatarKind === 'identicon'
        ? `data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(username, background))}`
        : null,
    [username, avatarKind, background]
  )
  return src ? (
    <img
      src={src}
      alt={username}
      width={size}
      height={size}
      style={background ? { background } : undefined}
      className="shrink-0 rounded-full bg-surface-container-highest"
    />
  ) : (
    <span
      style={{ width: size, height: size, background: avatarColor ?? undefined }}
      className="flex shrink-0 items-center justify-center rounded-full bg-avatar text-on-avatar"
    >
      <User size={Math.round(size * 0.6)} strokeWidth={2.25} />
    </span>
  )
}
