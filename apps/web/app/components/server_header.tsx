'use client'

import { IconButton } from './controls'
import { Name } from './name'
import { serverCalled } from '../lib/names'
import type { CSSProperties } from 'react'
import { Settings } from 'lucide-react'
import { GEAR_CHIP_CSS, headerColors } from '../lib/server_colors'
import { longPress } from './context_menu'
import { useOwnServer } from './ui'
import { Inset } from './layout'

const gearCls =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-offset-2 focus-visible:outline-2'

export function ServerHeader({
  server,
  displayName,
  bannerColor,
  nameColor,
  onSettings,
  onMenu,
  preview = false,
  showGear = true,
}: {
  server: string
  displayName: string
  bannerColor: string | null | undefined
  nameColor: string | null | undefined
  onSettings?: () => void
  // Opens the server's menu at a point: a right-click or a long press on the name.
  onMenu?: (x: number, y: number) => void
  preview?: boolean
  showGear?: boolean
}) {
  const own = useOwnServer(server)
  const colors = headerColors(bannerColor, nameColor)
  const style: CSSProperties | undefined = colors?.bg
    ? ({
        background: colors.bg,
        borderColor: `color-mix(in srgb, ${colors.bg} 78%, ${colors.gear})`,
        '--hdr-gear': colors.gear,
      } as CSSProperties)
    : undefined
  // On a banner the gear sits on a chip of the theme's surface so it reads on any color.
  const chip = colors?.bg ? ({ '--gear-chip': GEAR_CHIP_CSS } as CSSProperties) : undefined
  const gear = chip
    ? `${gearCls} bg-gear-chip text-on-surface shadow-elevation-1 hover:bg-surface-container-highest focus-visible:outline-hdr-gear`
    : `${gearCls} text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary`
  const gearIcon = <Settings size={18} />
  return (
    <header style={style} className="h-14 shrink-0 border-b border-outline-variant">
      <Inset row pad="lg" inset="sides" gap="sm" justify="between" place="h-full">
        {server === 'rchat' ? (
          <img src="/rchat_logo.png" alt="RChat" className="h-8 w-auto" />
        ) : (
          <Name
            of={serverCalled(displayName, own)}
            {...(onMenu ? longPress(onMenu) : {})}
            color={colors?.fg || undefined}
            look="truncate font-medium"
          />
        )}
        {preview
          ? showGear && (
              <span aria-hidden style={chip} className={gear}>
                {gearIcon}
              </span>
            )
          : onSettings && (
              <span style={chip} className="flex shrink-0">
                <IconButton
                  icon={Settings}
                  label="Server settings"
                  tone={chip ? 'banner' : 'plain'}
                  onClick={onSettings}
                />
              </span>
            )}
      </Inset>
    </header>
  )
}
