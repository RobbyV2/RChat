'use client'

import { CardButton, IconButton } from './controls'
import { Name } from './name'
import type { CSSProperties } from 'react'
import { Settings, UserPlus } from 'lucide-react'
import { GEAR_CHIP_CSS, headerColors } from '../lib/server_colors'
import { longPress } from './context_menu'
import { Inset, Row } from './layout'
import { StoredLock } from './storage_settings'
import { P2pBadge } from './p2p/p2p_badge'
import type { Channels, PlaceHead } from '../lib/place/channels'
import { useLive } from '../lib/place/react'

const gearCls =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-offset-2 focus-visible:outline-2'

// The header of a server's sidebar, whichever place the server is: its name (which opens the
// server's menu), what it is, and the ways into its invites and settings. `preview` draws it
// as a picture of itself, with nothing to press.
export function ServerHeader({
  head,
  onSettings,
  onInvite,
  onMenu,
  preview = false,
}: {
  head: PlaceHead
  onSettings?: () => void
  onInvite?: () => void
  // Opens the server's menu at a point: a click, a right-click or a long press on the name.
  onMenu?: (x: number, y: number) => void
  preview?: boolean
}) {
  const colors = headerColors(head.banner, head.nameColor)
  const style: CSSProperties | undefined = colors?.bg
    ? ({
        background: colors.bg,
        borderColor: `color-mix(in srgb, ${colors.bg} 78%, ${colors.gear})`,
        '--hdr-gear': colors.gear,
      } as CSSProperties)
    : undefined
  // On a banner the controls sit on a chip of the theme's surface so they read on any color.
  const chip = colors?.bg ? ({ '--gear-chip': GEAR_CHIP_CSS } as CSSProperties) : undefined
  const gear = chip
    ? `${gearCls} bg-gear-chip text-on-surface shadow-elevation-1 hover:bg-surface-container-highest focus-visible:outline-hdr-gear`
    : `${gearCls} text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary`
  const named = (
    <span className="flex min-w-0 flex-col items-start">
      <Row as="span" gap="xs" place="w-full">
        {head.logo ? (
          <img src="/rchat_logo.png" alt="RChat" className="h-8 w-auto" />
        ) : (
          <Name
            data-server-name
            of={head.name}
            color={colors?.fg || undefined}
            look="truncate font-medium"
          />
        )}
        {head.peer && <P2pBadge />}
        {head.stored && !preview && <StoredLock />}
      </Row>
      {head.line !== null && (
        <span data-server-line className="truncate text-xs text-on-surface-variant">
          {head.line}
        </span>
      )}
    </span>
  )
  return (
    <header style={style} className="h-14 shrink-0 border-b border-outline-variant">
      <Inset row pad="md" inset="sides" gap="sm" justify="between" place="h-full">
        {onMenu && !preview ? (
          <CardButton
            {...longPress(onMenu)}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              onMenu(r.left + 12, r.bottom)
            }}
            place="min-w-0 flex-1"
            pad="sm"
          >
            {named}
          </CardButton>
        ) : (
          <Inset pad="sm" place="min-w-0 flex-1">
            {named}
          </Inset>
        )}
        {preview
          ? head.canSet && (
              <span aria-hidden style={chip} className={gear}>
                <Settings size={18} />
              </span>
            )
          : (onInvite || onSettings) && (
              <span style={chip} className="flex shrink-0">
                <Row as="span" gap="3xs">
                  {onInvite && (
                    <IconButton
                      icon={UserPlus}
                      label="Invite people"
                      tone={chip ? 'banner' : 'plain'}
                      onClick={onInvite}
                    />
                  )}
                  {onSettings && (
                    <IconButton
                      icon={Settings}
                      label="Server settings"
                      tone={chip ? 'banner' : 'plain'}
                      onClick={onSettings}
                    />
                  )}
                </Row>
              </span>
            )}
      </Inset>
    </header>
  )
}

// The header of the server whose channels `channels` lists.
export function PlaceHeader({ channels }: { channels: Channels }) {
  const head = useLive(channels.head)
  if (!head) return null
  return (
    <ServerHeader
      head={head}
      onMenu={channels.headMenu}
      onInvite={head.canInvite ? channels.invite : undefined}
      onSettings={head.canSet ? channels.openSettings : undefined}
    />
  )
}
