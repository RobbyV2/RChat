'use client'

import { useMemo } from 'react'
import { User } from 'lucide-react'
import { identiconBackground, identiconSvg } from '../lib/identicon'
import type { AvatarKind } from '../lib/types'

interface Props {
  username: string
  avatarKind: AvatarKind
  avatarColor: string | null
  size?: number
}

export function UserAvatar({ username, avatarKind, avatarColor, size = 32 }: Props) {
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
