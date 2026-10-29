'use client'

import { useEffect } from 'react'
import { CornerDownRight, Forward, Phone, Pin } from 'lucide-react'
import { useStore } from '../lib/store'
import { cardLabel } from '../lib/message_links'
import type { MessageLocation } from '../lib/types'
import type { MessageTarget } from '../lib/view'
import { MessageTime } from './timestamp'
import { Snippet } from './replies'
import { UserAvatar } from './user_avatar'

// A pasted link to a message on this instance. Shown only once the gated lookup says the viewer
// can read the message; otherwise the link stays a plain link.
export function MessageLinkCard({ link }: { link: MessageTarget }) {
  const { id } = link
  const card = useStore(s => s.linkCards[id])
  const known = useStore(s => id in s.linkCards)
  const resolveLinkCard = useStore(s => s.resolveLinkCard)
  const openMessage = useStore(s => s.openMessage)
  useEffect(() => {
    if (!known) resolveLinkCard(id)
  }, [id, known, resolveLinkCard])
  if (!card) return null
  const { author, created_at } = card
  const jump = (e: React.MouseEvent) => {
    e.stopPropagation()
    void openMessage(id)
  }
  return (
    <div
      data-link-card={id}
      className="mt-1 flex max-w-160 min-w-0 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2"
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={jump}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            username={author.username}
            avatarKind={author.avatar_kind}
            avatarColor={author.avatar_color}
            size={20}
          />
          <span className="streamer min-w-0 truncate text-sm font-medium">
            {author.display_name}
          </span>
          <MessageTime ts={created_at} className="shrink-0 text-xs text-on-surface-variant" />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-on-surface-variant">
          <CardText card={card} />
        </div>
      </button>
      <button
        type="button"
        title="Jump to message"
        onClick={jump}
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
      <span className="truncate">{text}</span>
    </span>
  )
}

const LABEL_ICONS = { pin: Pin, call: Phone, forward: Forward }

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
