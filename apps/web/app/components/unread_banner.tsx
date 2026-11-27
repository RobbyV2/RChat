'use client'

import { Check } from 'lucide-react'
import { useMotionPlays } from '../lib/motion/use_motion'
import { unreadBannerText, type UnreadSummary } from '../lib/unread_banner'

// The bar at the top of a list with unread messages: how many and since when (jumps to the first
// one), and Mark as read.
export function UnreadBanner({
  unread,
  onJump,
  onMarkRead,
}: {
  unread: UnreadSummary
  onJump: () => void
  onMarkRead: () => void
}) {
  const moves = useMotionPlays()
  return (
    <div
      data-unread-banner
      className={`absolute inset-x-3 top-2 z-10 flex items-center gap-1 rounded-xl bg-primary py-0.5 pr-1 pl-3.5 text-sm text-on-primary shadow-elevation-2 ${moves ? 'animate-banner-in' : ''}`}
    >
      <button
        onClick={onJump}
        title="Jump to the first unread message"
        className="min-h-9 min-w-0 flex-1 truncate text-left font-medium pointer-coarse:min-h-11"
      >
        {unreadBannerText(unread)}
      </button>
      <button
        onClick={onMarkRead}
        title="Mark as read"
        aria-label="Mark as read"
        className="flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 font-medium hover:bg-on-primary/10 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <span className="max-sm:hidden">Mark as read</span>
        <Check size={16} aria-hidden />
      </button>
    </div>
  )
}

// The line above the first unread message, ending in a NEW tag.
export function UnreadDivider() {
  return (
    <div
      data-divider
      role="separator"
      aria-label="New messages"
      className="my-2 flex items-center px-4 select-none"
    >
      <div className="h-px flex-1 bg-danger/80" />
      <span className="shrink-0 rounded-[4px] bg-danger px-1.5 py-0.5 text-3xs leading-none font-bold tracking-wider text-on-danger uppercase">
        New
      </span>
    </div>
  )
}
