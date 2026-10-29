'use client'

import type { CSSProperties } from 'react'
import { Settings } from 'lucide-react'
import { THEME_BACKDROP_CSS, headerColors } from '../lib/server_colors'

const gearCls = 'group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full'

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
  const colors = headerColors(bannerColor, nameColor)
  const style: CSSProperties = colors?.bg
    ? ({
        background: colors.bg,
        borderColor: `color-mix(in srgb, ${colors.bg} 78%, ${colors.gear})`,
        '--hdr-gear': colors.gear,
        '--hdr-backdrop': colors.backdrop,
      } as CSSProperties)
    : ({
        '--hdr-gear': 'var(--color-on-surface)',
        '--hdr-backdrop': THEME_BACKDROP_CSS,
      } as CSSProperties)
  const backdrop = (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-2.5 rounded-full"
        style={{
          background: 'radial-gradient(circle closest-side, var(--hdr-backdrop) 60%, transparent)',
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--hdr-gear)_18%,transparent)] opacity-0 group-hover:opacity-100 group-active:opacity-100"
      />
    </>
  )
  const gearIcon = <Settings size={18} className="relative" />
  const gear = colors?.bg
    ? `${gearCls} text-[var(--hdr-gear)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--hdr-gear)]`
    : `${gearCls} text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`
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
          {displayName}
        </span>
      )}
      {preview
        ? showGear && (
            <span aria-hidden className={gear}>
              {backdrop}
              {gearIcon}
            </span>
          )
        : onSettings && (
            <button
              title="Server settings"
              aria-label="Server settings"
              onClick={onSettings}
              className={gear}
            >
              {backdrop}
              {gearIcon}
            </button>
          )}
    </header>
  )
}
