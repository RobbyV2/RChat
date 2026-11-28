'use client'

import { useMemo } from 'react'
import { User } from 'lucide-react'
import { builtIn } from '../lib/avatar_setting'
import { identiconBackground, identiconSvg } from '../lib/identicon'
import type { Person } from '../lib/people'
import { useAccountPicture, useAvatarView } from '../lib/avatar_view'
import { PictureOver } from './avatar_picture'

interface Props {
  person: Person
  size?: number
  // A picture streamer mode hides: the viewer's own, outside a chat.
  covered?: boolean
}

// The picture of an account, as the person given is drawn: the built-in avatar, and their
// uploaded picture over it where this device shows pictures.
export function UserAvatar({ person, size = 32, covered = false }: Props) {
  const view = useAvatarView()
  const { username } = person
  const { kind: avatarKind, color: avatarColor } = builtIn(person, view.mode)
  const picture = useAccountPicture(person.avatar_image ?? null, size, view)
  const background = identiconBackground(avatarKind, avatarColor)
  const src = useMemo(
    () =>
      avatarKind === 'identicon'
        ? `data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(username, background))}`
        : null,
    [username, avatarKind, background]
  )
  return (
    <PictureOver src={picture} size={size}>
      {src ? (
        <img
          src={src}
          alt={view.streamer ? '' : username}
          width={size}
          height={size}
          style={background ? { background } : undefined}
          className={`${covered ? 'streamer ' : ''}shrink-0 rounded-full bg-surface-container-highest`}
        />
      ) : (
        <span
          style={{ width: size, height: size, background: avatarColor ?? undefined }}
          className={`${covered ? 'streamer ' : ''}flex shrink-0 items-center justify-center rounded-full bg-avatar text-on-avatar`}
        >
          <User size={Math.round(size * 0.6)} strokeWidth={2.25} />
        </span>
      )}
    </PictureOver>
  )
}
