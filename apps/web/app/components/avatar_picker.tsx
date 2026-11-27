'use client'

import { IDENTICON_DEFAULT_BG, IDENTICON_PRESETS } from '../lib/identicon'
import { useStore } from '../lib/store'
import type { ReactNode } from 'react'
import type { AvatarKind } from '../lib/types'
import { ColorField } from './color_field'
import { Row, Stack } from './layout'
import { UserAvatar } from './user_avatar'

interface Props {
  username: string
  kind: AvatarKind
  color: string
  onKind: (kind: AvatarKind) => void
  onColor: (color: string) => void
  background?: string | null
  onBackground?: (color: string | null) => void
  // Draws a choice in place of the account avatar (a P2P identity's picture comes from its key).
  avatar?: (kind: AvatarKind, color: string | null) => ReactNode
  disabled?: boolean
}

export function AvatarPicker({
  username,
  kind,
  color,
  onKind,
  onColor,
  background = null,
  onBackground,
  avatar,
  disabled = false,
}: Props) {
  const theme = useStore(s => s.theme)
  const option = (value: AvatarKind, label: string) => (
    <button
      type="button"
      title={`${label} avatar`}
      aria-pressed={kind === value}
      disabled={disabled}
      onClick={() => onKind(value)}
      className={`flex flex-1 flex-col items-center gap-2 rounded-2xl border p-3 transition-colors ${
        kind === value
          ? 'border-primary bg-primary-container/30'
          : 'border-outline-variant hover:bg-surface-container-high'
      }`}
    >
      {avatar ? (
        avatar(value, value === 'color' ? color : background)
      ) : (
        <UserAvatar
          username={username.trim().toLowerCase() || 'preview'}
          avatarKind={value}
          avatarColor={value === 'color' ? color : background}
          size={48}
        />
      )}
      <span className="text-xs text-on-surface-variant">{label}</span>
    </button>
  )
  return (
    <Stack gap="sm">
      <span className="text-sm text-on-surface-variant">Avatar</span>
      <Row gap="md" align="stretch">
        {option('identicon', 'Identicon')}
        {option('color', 'Color')}
      </Row>
      {kind === 'color' && (
        <Row as="label" gap="md">
          <span className="text-sm text-on-surface-variant">Background color</span>
          <input
            type="color"
            value={color}
            disabled={disabled}
            onChange={e => onColor(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded bg-transparent"
          />
        </Row>
      )}
      {kind === 'identicon' && onBackground && (
        <Stack gap="xs">
          <span className="text-sm text-on-surface-variant">Identicon background</span>
          <ColorField
            label="Identicon background"
            value={background}
            shown={background ?? IDENTICON_DEFAULT_BG[theme]}
            onChange={onBackground}
            presets={IDENTICON_PRESETS}
            defaultNote="Default"
            resetLabel="Use default"
          />
        </Stack>
      )}
    </Stack>
  )
}
