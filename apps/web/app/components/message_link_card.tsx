'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { canView, instanceTarget, useViewing } from '../lib/viewing'
import { ChartColumn, CornerDownRight, Forward, Phone, Pin } from 'lucide-react'
import { useStore } from '../lib/store'
import { useForwardAccess } from '../lib/forward_access'
import { cardLabel } from '../lib/message_links'
import type { ForwardRef, MessageLocation } from '../lib/types'
import { messagePath, type MessageTarget } from '../lib/view'
import { MessageTime } from './timestamp'
import { Snippet } from './replies'
import { UserAvatar } from './user_avatar'
import { BlockedQuote } from './blocking'
import { Masked } from './ui'
import { NameWithUsername } from './display_name'

export const WidgetLinkCards = createContext<ReadonlyMap<number, MessageLocation> | null>(null)
// Whether a frame may show a forwarded copy from this source.
export const WidgetForwardOpen = createContext<(fwd: ForwardRef) => boolean>(() => true)

export function WidgetMessageLinkCard({
  link,
  card,
}: {
  link: MessageTarget
  card?: MessageLocation
}) {
  const forwardOpen = useContext(WidgetForwardOpen)
  if (
    !card ||
    link.place.kind !== 'channel' ||
    card.server !== link.place.server ||
    card.channel_id !== link.place.channelId ||
    card.thread_root_id !== link.thread
  )
    return null
  return (
    <LinkCard
      card={card}
      gated={!!card.forward && !forwardOpen(card.forward)}
      jump={() => window.open(messagePath(link), '_blank', 'noopener,noreferrer')}
    />
  )
}

// A pasted link to a message on this instance. Shown only once the gated lookup says the viewer
// can read the message; otherwise the link stays a plain link.
export function MessageLinkCard({ link }: { link: MessageTarget }) {
  const { id } = link
  const card = useStore(s => s.linkCards[id])
  useViewing(s => s.revision)
  const target = link.place
  const allowed = useStore(s => {
    if (target.kind === 'dm') return true
    const t = instanceTarget(s, target.server, target.channelId)
    return !!t && canView(t)
  })
  const sourceVisible = useStore(s => {
    if (!card || card.dm_id !== null) return true
    const t = card.server && instanceTarget(s, card.server, card.channel_id ?? -1)
    return !!t && canView(t)
  })
  const known = useStore(s => id in s.linkCards)
  const forward = useForwardAccess(card, {
    server: card?.server ?? undefined,
    active: allowed && sourceVisible,
  })
  const resolveLinkCard = useStore(s => s.resolveLinkCard)
  const openMessage = useStore(s => s.openMessage)
  useEffect(() => {
    if (target.kind === 'channel' && !allowed)
      void useStore
        .getState()
        .discoverChannels(target.server)
        .catch(() => {})
    if (allowed && !known) resolveLinkCard(id, target)
  }, [id, known, resolveLinkCard, target, allowed])
  return allowed && sourceVisible && card ? (
    <LinkCard
      card={card}
      gated={forward.access !== 'open'}
      jump={() => void openMessage(id, 'push', link.place)}
    />
  ) : null
}

// `gated`: a forwarded copy whose source room is closed here shows no text.
function LinkCard({
  card,
  gated,
  jump,
}: {
  card: MessageLocation
  gated: boolean
  jump: () => void
}) {
  const { id } = card
  const blocked = useStore(s => s.blocked[card.author.username] === true)
  const [shown, setShown] = useState(false)
  if (blocked && !shown)
    return (
      <div
        data-link-card={id}
        className="mt-1 flex max-w-160 min-w-0 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2"
      >
        <BlockedQuote onShow={() => setShown(true)} />
      </div>
    )
  const { author, created_at } = card
  const onJump = (e: React.MouseEvent) => {
    e.stopPropagation()
    jump()
  }
  return (
    <div
      data-link-card={id}
      className="mt-1 flex max-w-160 min-w-0 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2"
    >
      <button type="button" tabIndex={-1} onClick={onJump} className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            username={author.username}
            avatarKind={author.avatar_kind}
            avatarColor={author.avatar_color}
            size={20}
          />
          <span className="streamer min-w-0 truncate text-sm font-medium">
            <NameWithUsername user={author} />
          </span>
          <MessageTime ts={created_at} className="shrink-0 text-xs text-on-surface-variant" />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-on-surface-variant">
          {gated ? (
            <Label icon={<Forward size={14} className="shrink-0" />} text="Forwarded message" />
          ) : (
            <CardText card={card} />
          )}
        </div>
      </button>
      <button
        type="button"
        title="Jump to message"
        onClick={onJump}
        className="flex shrink-0 items-center gap-1 rounded-full bg-secondary-container px-3 py-1 text-xs font-medium text-on-secondary-container hover:brightness-95 pointer-coarse:min-h-8"
      >
        <CornerDownRight size={12} />
        Jump
      </button>
    </div>
  )
}

function Label({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 italic">
      {icon}
      <span className="truncate">
        <Masked text={text} />
      </span>
    </span>
  )
}

const LABEL_ICONS = { pin: Pin, call: Phone, forward: Forward, poll: ChartColumn }

function CardText({ card }: { card: MessageLocation }) {
  const shown = cardLabel(card)
  if (shown.label !== null) {
    const Icon = LABEL_ICONS[shown.label]
    return <Label icon={<Icon size={14} className="shrink-0" />} text={shown.text} />
  }
  if (!shown.forwarded) return <Snippet quote={card} />
  return (
    <>
      <Forward size={14} className="shrink-0" aria-label="Forwarded" />
      <Snippet quote={card} />
    </>
  )
}
