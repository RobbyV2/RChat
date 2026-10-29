'use client'

import type { ReactNode } from 'react'
import { Forward, Image as ImageIcon, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { snippetParts } from '../lib/replies'
import { plainStamps } from '../lib/timestamps'
import type { ReplyRef } from '../lib/types'
import { UserAvatar } from './user_avatar'

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

export function Snippet({ quote }: { quote: Pick<ReplyRef, 'content' | 'has_media'> }) {
  if (!quote.content)
    return (
      <span className="flex min-w-0 items-center gap-1 italic">
        <span className="truncate">
          {quote.has_media ? 'Click to see attachment' : 'Click to see message'}
        </span>
        {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
      </span>
    )
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">
        {snippetParts(plainStamps(quote.content)).map((p, i) =>
          p.spoiler ? (
            <span
              key={i}
              data-reply-spoiler
              className="rounded-sm bg-on-surface-variant/70 text-transparent select-none"
            >
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
      {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
    </span>
  )
}

// The quoted message above a reply. Click it to go to the original.
export function ReplyPreview({
  quote,
  avatar,
  color,
  onJump,
}: {
  quote: ReplyRef
  avatar: number
  color?: string
  onJump: (id: number) => void
}) {
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
  return (
    <div
      data-reply-to={quote.id}
      className="relative mb-0.5 flex h-5 min-w-0 items-center text-xs"
      style={indent}
    >
      {connector}
      <button
        type="button"
        title="Jump to message"
        onClick={e => {
          e.stopPropagation()
          onJump(quote.id)
        }}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left text-on-surface-variant outline-offset-2 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
      >
        <UserAvatar
          username={author.username}
          avatarKind={author.avatar_kind}
          avatarColor={author.avatar_color}
          size={16}
        />
        <span style={{ color }} className="streamer shrink-0 font-medium text-on-surface">
          {quote.mention ? '@' : ''}
          {author.display_name}
        </span>
        {quote.forwarded && <ForwardedTag />}
        <Snippet quote={quote} />
      </button>
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
      <span className="streamer font-semibold text-on-surface">{author.display_name}</span>
    </ComposerBar>
  )
}
