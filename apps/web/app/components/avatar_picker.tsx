'use client'

import { pictured } from '../lib/people'
import { IDENTICON_DEFAULT_BG, IDENTICON_PRESETS } from '../lib/identicon'
import { useStore } from '../lib/store'
import type { ReactNode } from 'react'
import type { AvatarKind } from '../lib/types'
import { ColorField } from './color_field'
import { Row, Stack } from './layout'
import { UserAvatar } from './user_avatar'
import { CardButton } from './controls'
import { notAName } from '../lib/names'

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
    <CardButton
      title={notAName(`${label} avatar`)}
      disabled={disabled}
      onClick={() => onKind(value)}
      tone="outlined"
      column
      pad="md"
      pressed={kind === value}
      place="flex-1"
    >
      {avatar ? (
        avatar(value, value === 'color' ? color : background)
      ) : (
        <UserAvatar
          person={pictured(
            username.trim().toLowerCase() || 'preview',
            { kind: value, color: value === 'color' ? color : background },
            'editor'
          )}
          size={48}
        />
      )}
      <span className="text-xs text-on-surface-variant">{label}</span>
    </CardButton>
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
