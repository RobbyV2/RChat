'use client'

import { Check } from 'lucide-react'
import { Inset, Row, Surface } from './layout'
import { plays } from '../lib/motion/play'
import { unreadBannerText, type UnreadSummary } from '../lib/unread_banner'
import { Button } from './controls'

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
  return (
    <Surface
      ref={plays('banner.unread')}
      data-unread-banner
      pad="2xs"
      gap="2xs"
      row
      tone="plain"
      radius="lg"
      elevation={2}
      text="sm"
      look="bg-primary text-on-primary"
      place="absolute inset-x-3 top-2 z-raised"
    >
      <Button
        onClick={onJump}
        title="Jump to the first unread message"
        place="min-w-0 flex-1"
        variant="inherit"
        align="start"
      >
        <span className="truncate">{unreadBannerText(unread)}</span>
      </Button>
      <Button
        onClick={onMarkRead}
        title="Mark as read"
        place="shrink-0"
        variant="inherit"
        label="Mark as read"
      >
        <span className="max-sm:hidden">Mark as read</span>
        <Check size={16} aria-hidden />
      </Button>
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
