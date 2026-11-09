'use client'

import type { CSSProperties } from 'react'
import { Settings } from 'lucide-react'
import { GEAR_CHIP_CSS, headerColors } from '../lib/server_colors'
import { Masked, useOwnServer } from './ui'

const gearCls =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-offset-2 focus-visible:outline-2'

export function ServerHeader({
  server,
  displayName,
  bannerColor,
  nameColor,
  onSettings,
  preview = false,
  showGear = true,
}: {
  server: string
  displayName: string
  bannerColor: string | null | undefined
  nameColor: string | null | undefined
  onSettings?: () => void
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
    ? `${gearCls} bg-(--gear-chip) text-on-surface shadow-elevation-1 hover:bg-surface-container-highest focus-visible:outline-(--hdr-gear)`
    : `${gearCls} text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-primary`
  const gearIcon = <Settings size={18} />
  return (
    <header
      style={style}
      className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-outline-variant px-4"
    >
      {server === 'rchat' ? (
        <img src="/rchat_logo.png" alt="RChat" className="h-8 w-auto" />
      ) : (
        <span
          style={colors?.fg ? { color: colors.fg } : undefined}
          className="streamer truncate font-medium"
        >
          <Masked text={displayName} own={own} />
        </span>
      )}
      {preview
        ? showGear && (
            <span aria-hidden style={chip} className={gear}>
              {gearIcon}
            </span>
          )
        : onSettings && (
            <button
              title="Server settings"
              aria-label="Server settings"
              onClick={onSettings}
              style={chip}
              className={gear}
            >
              {gearIcon}
            </button>
          )}
    </header>
  )
}
