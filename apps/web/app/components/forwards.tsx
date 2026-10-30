'use client'

import { useState } from 'react'
import { Forward, Image as ImageIcon, SendHorizontal } from 'lucide-react'
import { useMask, useStore, type ContextMenuItem } from '../lib/store'
import { forwardOrigin, forwardPending } from '../lib/forward'
import type { Message } from '../lib/types'
import type { ToolbarAction } from './message_toolbar'
import { ComposerBar, SpoilerLine } from './replies'
import { snippetParts } from '../lib/replies'
import { MarkdownMessage } from './markdown_message'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'
import { BlockedQuote } from './blocking'
import { MessageTime } from './timestamp'
import { PollCard } from './poll_card'
import { fullTimeOf, messageTime, plainStamps } from '../lib/timestamps'
import { Masked } from './ui'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'

const DELETED_USER = 'Deleted user'

export const forwardAction = (onClick: () => void): ToolbarAction => ({
  key: 'forward',
  label: 'Forward',
  icon: Forward,
  onClick,
})

export const forwardMenuItem = (action: () => void): ContextMenuItem => ({
  label: 'Forward',
  icon: Forward,
  action,
})

// The bar above a composer while the forward clipboard has a message. Send forwards it here. X
// clears the clipboard.
export function ForwardBar({ draftKey }: { draftKey: string }) {
  const clip = useStore(s => s.forwardClip)
  const busy = useStore(s => (clip ? forwardPending(s.outbox[draftKey], clip.id) : false))
  const sendForward = useStore(s => s.sendForward)
  const clearForward = useStore(s => s.clearForward)
  const mask = useMask()
  if (!clip) return null
  return (
    <ComposerBar
      onClose={clearForward}
      closeLabel="Discard forward"
      actions={
        <button
          type="button"
          title="Forward here"
          disabled={busy}
          onClick={() => sendForward(draftKey)}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 pointer-coarse:min-h-10"
        >
          <SendHorizontal size={12} />
          Send
        </button>
      }
    >
      <span data-forward-bar className="flex min-w-0 items-center gap-2">
        <Forward size={14} className="shrink-0 text-primary" />
        <span className="shrink-0">
          Forward{' '}
          {clip.author ? (
            <span className="streamer font-semibold text-on-surface">
              {mask(clip.author.display_name)}
            </span>
          ) : (
            <span className="font-semibold text-on-surface">{DELETED_USER}</span>
          )}
          &apos;s message
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs">
          <span className="truncate">
            <SpoilerLine parts={snippetParts(plainStamps(clip.snippet))} />
          </span>
          {clip.has_media && <ImageIcon size={12} className="shrink-0" aria-label="Attachment" />}
        </span>
      </span>
    </ComposerBar>
  )
}

// A forwarded message: a label and a card with a compact copy of the original. The footer opens
// the original if you can read it.
export function ForwardCard({
  m,
  canDelete,
  sending = false,
}: {
  m: Message
  canDelete: boolean
  sending?: boolean
}) {
  const openForward = useStore(s => s.openForward)
  const fwd = m.forward
  const blocked = useStore(s => (fwd?.author ? s.blocked[fwd.author.username] === true : false))
  const [shown, setShown] = useState(false)
  if (!fwd) return null
  const { author } = fwd
  const origin = forwardOrigin(fwd)
  const when = fullTimeOf(fwd.created_at)
  const head = (
    <div className="flex items-center gap-1 text-xs text-on-surface-variant italic">
      <Forward size={12} className="shrink-0" />
      Forwarded
    </div>
  )
  if (blocked && !shown)
    return (
      <div data-forward={fwd.source_id} className="min-w-0">
        {head}
        <div className="mt-1 max-w-160 min-w-0 rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
          <BlockedQuote onShow={() => setShown(true)} />
        </div>
      </div>
    )
  return (
    <div data-forward={fwd.source_id} className="min-w-0">
      {head}
      <div className="mt-1 max-w-160 min-w-0 rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {author ? (
            <>
              <span
                {...profileTrigger(author, null, false)}
                title="View profile"
                className="block shrink-0 cursor-pointer rounded-full hover:opacity-85"
              >
                <UserAvatar
                  username={author.username}
                  avatarKind={author.avatar_kind}
                  avatarColor={author.avatar_color}
                  size={20}
                />
              </span>
              <span
                {...profileTrigger(author, null)}
                className="streamer min-w-0 cursor-pointer truncate rounded-sm text-sm font-medium outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <Masked text={author.display_name} />
              </span>
              {isWebhookAuthor(author.username) && <WebhookBadge />}
            </>
          ) : (
            <>
              <UserAvatar username="" avatarKind="color" avatarColor={null} size={20} />
              <span
                data-forward-deleted
                className="min-w-0 truncate text-sm font-medium text-on-surface-variant italic"
              >
                {DELETED_USER}
              </span>
            </>
          )}
          <MessageTime ts={fwd.created_at} className="shrink-0 text-xs text-on-surface-variant" />
        </div>
        {m.poll?.snapshot ? (
          <PollCard m={m} />
        ) : (
          <MarkdownMessage message={m} canDelete={canDelete} />
        )}
        {fwd.dropped && (
          <p className="mt-1 text-xs text-on-surface-variant italic">
            File not forwarded: {fwd.dropped}
          </p>
        )}
        <button
          type="button"
          disabled={sending}
          title={`Open the original message, sent ${when}`}
          onClick={e => {
            e.stopPropagation()
            void openForward(m)
          }}
          className="mt-1 flex max-w-full min-w-0 items-center gap-1 rounded-sm text-left text-xs text-on-surface-variant outline-offset-2 hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary disabled:no-underline pointer-coarse:min-h-8"
        >
          {origin && (
            <>
              <span className={`truncate ${origin.isServer ? 'streamer' : ''}`}>
                <Masked text={origin.label} />
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="shrink-0">
            Originally sent {messageTime(fwd.created_at * 1000, Date.now())}
          </span>
        </button>
      </div>
    </div>
  )
}
