'use client'

import { useState, type ReactNode } from 'react'
import { Forward, Image as ImageIcon, X } from 'lucide-react'
import { BlockedQuote } from './blocking'
import { PreviewRow, PreviewSpoiler, RevealChannelPreview } from './preview_reveal'
import { useStore } from '../lib/store'
import { useForwardAccess } from '../lib/forward_access'
import { snippetParts, type SnippetPart } from '../lib/replies'
import { plainStamps } from '../lib/timestamps'
import type { ReplyRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { NameWithUsername } from './display_name'
import { KeyAvatar } from './p2p/p2p_badge'
import { Masked, useOwn } from './ui'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'

// A small marker for forwarded messages where only a line of them is shown (search, quotes).
export function ForwardedTag() {
  return (
    <span
      data-forwarded-tag
      className="flex shrink-0 items-center gap-0.5 text-on-surface-variant italic"
    >
      <Forward size={11} className="shrink-0" />
      Forwarded
    </span>
  )
}

export function Snippet({
  quote,
  own = false,
}: {
  quote: Pick<ReplyRef, 'content' | 'has_media'>
  own?: boolean
}) {
  if (!quote.content)
    return (
      <span className="flex min-w-0 items-center gap-1 italic">
        <span className="truncate">
          {quote.has_media ? 'Click to see attachment' : 'Click to see message'}
        </span>
        {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
      </span>
    )
  const parts = snippetParts(plainStamps(quote.content))
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className={parts.some(p => p.spoiler) ? 'min-w-0 break-words' : 'truncate'}>
        <SpoilerLine parts={parts} own={own} />
      </span>
      {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
    </span>
  )
}

// Each spoiler in the excerpt opens independently. The personal word filter still applies.
export function SpoilerLine({ parts, own = false }: { parts: SnippetPart[]; own?: boolean }) {
  return (
    <>
      {parts.map((part, i) =>
        part.spoiler ? (
          <PreviewSpoiler key={i + ':' + part.text}>
            <Masked text={part.text} code own={own} />
          </PreviewSpoiler>
        ) : (
          <Masked key={i} text={part.text} code own={own} />
        )
      )}
    </>
  )
}

// The quoted message above a reply. Click it to go to the original. `local`: a P2P quote, whose
// author carries a P2P key where an account carries its username; it shows the P2P name alone.
export function ReplyPreview({
  quote,
  avatar,
  color,
  local = false,
  onJump,
}: {
  quote: ReplyRef
  avatar: number
  color?: string
  local?: boolean
  onJump: (id: number) => void
}) {
  const blocked = useStore(s => (quote.author ? s.blocked[quote.author.username] === true : false))
  const [shown, setShown] = useState<string | null>(null)
  const viewer = useStore(s => s.me?.username)
  const authorKey = JSON.stringify([viewer, quote.id, quote.author?.username])
  const own = useOwn(quote.author?.username)
  const streamer = useStore(s => s.streamer)
  const copy = useForwardAccess(
    quote.forward ? { forward: quote.forward, channel_id: null } : null,
    {
      active: !local && !quote.partial && !quote.deleted && (!blocked || shown === authorKey),
    }
  )
  const connector = (
    <span
      aria-hidden
      className="pointer-events-none absolute top-1/2 rounded-tl-md border-t-2 border-l-2 border-outline-variant"
      style={{ left: avatar / 2 - 1, width: avatar / 2 + 6, height: 'calc(50% + 4px)' }}
    />
  )
  const indent = { paddingLeft: avatar + 12 }
  if (quote.partial)
    return (
      <div
        data-reply-to={quote.id}
        data-reply-loading
        className="relative mb-0.5 flex h-5 items-center"
        style={indent}
      >
        {connector}
        <span className="h-2 w-32 rounded-full bg-surface-container-highest" />
      </div>
    )
  if (quote.deleted || !quote.author)
    return (
      <div
        data-reply-to={quote.id}
        className="relative mb-0.5 flex h-5 items-center text-xs text-on-surface-variant"
        style={indent}
      >
        {connector}
        <span className="truncate italic">Original message was deleted</span>
      </div>
    )
  const { author } = quote
  if (blocked && shown !== authorKey)
    return (
      <div
        data-reply-to={quote.id}
        className="relative mb-0.5 flex h-5 items-center text-xs text-on-surface-variant"
        style={indent}
      >
        {connector}
        <BlockedQuote onShow={() => setShown(authorKey)} />
      </div>
    )
  return (
    <div
      data-reply-to={quote.id}
      className="relative mb-0.5 flex min-h-5 min-w-0 items-center text-xs"
      style={indent}
    >
      {connector}
      <PreviewRow
        title="Jump to message"
        onOpen={() => onJump(quote.id)}
        className="min-w-0 rounded-sm text-xs text-on-surface-variant hover:text-on-surface"
        contentClassName="flex min-w-0 items-center gap-1.5"
      >
        {local ? (
          <KeyAvatar ik={author.username} size={16} />
        ) : (
          <UserAvatar
            username={author.username}
            avatarKind={author.avatar_kind}
            avatarColor={author.avatar_color}
            size={16}
          />
        )}
        {local ? (
          <span
            title={streamer ? undefined : author.username}
            style={{ color }}
            className="streamer min-w-0 truncate font-medium text-on-surface"
          >
            {quote.mention ? '@' : ''}
            <Masked text={author.display_name} own={own} />
          </span>
        ) : (
          <span
            style={{ color }}
            className="streamer max-w-[40%] shrink-0 truncate font-medium text-on-surface"
          >
            {quote.mention ? '@' : ''}
            <NameWithUsername user={author} own={own} />
          </span>
        )}
        {isWebhookAuthor(author.username) && <WebhookBadge />}
        {quote.forwarded && <ForwardedTag />}
        {copy.access === 'open' ? (
          <Snippet key={authorKey} quote={quote} own={own && !quote.forwarded} />
        ) : (
          copy.target && <RevealChannelPreview target={copy.target} />
        )}
      </PreviewRow>
    </div>
  )
}

// A bar above the composer input. The composer shows one at most. `onClose` runs on X and on
// Escape.
export function ComposerBar({
  children,
  actions,
  onClose,
  closeLabel,
}: {
  children: ReactNode
  actions?: ReactNode
  onClose: () => void
  closeLabel: string
}) {
  return (
    <div
      data-composer-bar
      className="flex min-h-9 items-center gap-2 rounded-t-2xl bg-surface-container px-4 py-1 text-sm text-on-surface-variant"
    >
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {actions}
      <button
        type="button"
        title={closeLabel}
        aria-label={closeLabel}
        onClick={onClose}
        className="flex shrink-0 items-center justify-center rounded-full p-1 hover:bg-surface-container-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:size-10"
      >
        <X size={16} />
      </button>
    </div>
  )
}

export function ReplyBar({ draftKey, onClose }: { draftKey: string; onClose: () => void }) {
  const reply = useStore(s => s.replying[draftKey])
  const toggle = useStore(s => s.toggleReplyMention)
  const me = useStore(s => s.me?.username)
  if (!reply) return null
  const { author } = reply.message
  const mention = reply.mention
  return (
    <ComposerBar
      onClose={onClose}
      closeLabel="Cancel reply"
      actions={
        author.username !== me && (
          <button
            type="button"
            aria-pressed={mention}
            title={
              mention ? 'The author will be pinged. Click to turn off' : 'Click to ping the author'
            }
            onClick={() => toggle(draftKey)}
            className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-bold focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-10 pointer-coarse:min-w-12 ${
              mention
                ? 'text-primary hover:bg-primary/10'
                : 'text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            @ {mention ? 'ON' : 'OFF'}
          </button>
        )
      }
    >
      Replying to{' '}
      <span className="streamer font-semibold text-on-surface">
        <NameWithUsername user={author} />
      </span>
    </ComposerBar>
  )
}
