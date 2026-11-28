'use client'

import { Check } from 'lucide-react'
import { Inset, Row, Surface } from './layout'
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
    <Surface
      data-unread-banner
      pad="2xs"
      gap="2xs"
      row
      tone="plain"
      radius="lg"
      elevation={2}
      text="sm"
      look={`bg-primary text-on-primary ${moves ? 'animate-banner-in' : ''}`}
      place="absolute inset-x-3 top-2 z-raised"
    >
      <Inset
        onClick={onJump}
        title="Jump to the first unread message"
        as="button"
        pad="sm"
        inset="sides"
        row
        look="min-h-9 text-left font-medium pointer-coarse:min-h-11"
        place="min-w-0 flex-1"
      >
        <span className="truncate">{unreadBannerText(unread)}</span>
      </Inset>
      <Surface
        as="button"
        onClick={onMarkRead}
        title="Mark as read"
        aria-label="Mark as read"
        pad="sm"
        inset="sides"
        gap="xs"
        row
        tone="plain"
        radius="md"
        justify="center"
        look="min-h-9 min-w-9 font-medium hover:bg-on-primary/10 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        place="shrink-0"
      >
        <span className="max-sm:hidden">Mark as read</span>
        <Check size={16} aria-hidden />
      </Surface>
    </Surface>
  )
}

// The line above the first unread message, ending in a NEW tag.
export function UnreadDivider() {
  return (
    <Surface
      data-divider
      role="separator"
      aria-label="New messages"
      tone="plain"
      radius="none"
      pad="lg"
      inset="bar"
    >
      <Row gap="none">
        <div className="h-px flex-1 bg-danger/80" />
        <Inset
          as="span"
          pad="xs"
          inset="chip"
          look="rounded-sm bg-danger text-3xs leading-none font-bold tracking-wider text-on-danger uppercase select-none"
          place="shrink-0"
        >
          New
        </Inset>
      </Row>
    </Surface>
  )
}
