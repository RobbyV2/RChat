'use client'

import type { AvatarKind } from '../lib/types'
import { UserAvatar } from './user_avatar'

interface Props {
  username: string
  kind: AvatarKind
  color: string
  onKind: (kind: AvatarKind) => void
  onColor: (color: string) => void
}

export function AvatarPicker({ username, kind, color, onKind, onColor }: Props) {
  const option = (value: AvatarKind, label: string) => (
    <button
      type="button"
      title={`${label} avatar`}
      onClick={() => onKind(value)}
      className={`flex flex-1 flex-col items-center gap-2 rounded-2xl border p-3 transition-colors ${
        kind === value
          ? 'border-primary bg-primary-container/30'
          : 'border-outline-variant hover:bg-surface-container-high'
      }`}
    >
      <UserAvatar
        username={username.trim().toLowerCase() || 'preview'}
        avatarKind={value}
        avatarColor={color}
        size={48}
      />
      <span className="text-xs text-on-surface-variant">{label}</span>
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-on-surface-variant">Avatar</span>
      <div className="flex gap-3">
        {option('identicon', 'Identicon')}
        {option('color', 'Color')}
      </div>
      {kind === 'color' && (
        <label className="flex items-center gap-3 text-sm text-on-surface-variant">
          Background color
          <input
            type="color"
            value={color}
            onChange={e => onColor(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded bg-transparent"
          />
        </label>
      )}
    </div>
  )
}
