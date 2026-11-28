'use client'

import { personName } from '../lib/names'
import { Name } from './name'
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
import { useShownOrNull } from './shown_user'
import { KeyAvatar } from './p2p/p2p_badge'
import { IconButton } from './controls'
import { Masked, useOwn } from './ui'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { Row, Surface, Inset } from './layout'
import type { ComposerList, Replying } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { useCompose } from '../lib/place/use_composer'
import { inlineRowLook } from '../lib/controls'

// A small marker for forwarded messages where only a line of them is shown (search, quotes).
export function ForwardedTag() {
  return (
    <Row as="span" data-forwarded-tag gap="3xs" ink="muted" look="italic" place="shrink-0">
      <Forward size={11} className="shrink-0" />
      Forwarded
    </Row>
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
      <Row as="span" gap="2xs">
        <span className="truncate italic">
          {quote.has_media ? 'Click to see attachment' : 'Click to see message'}
        </span>
        {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
      </Row>
    )
  const parts = snippetParts(plainStamps(quote.content))
  return (
    <Row as="span" gap="2xs">
      <span className={parts.some(p => p.spoiler) ? 'min-w-0 break-words' : 'truncate'}>
        <SpoilerLine parts={parts} own={own} />
      </span>
      {quote.has_media && <ImageIcon size={14} className="shrink-0" />}
    </Row>
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
  const server = useStore(s => (!local && s.view?.kind === 'channel' ? s.view.server : null))
  const author = useShownOrNull(quote.author, server)
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
  const gutter = <span aria-hidden className="shrink-0" style={{ width: avatar + 12 }} />
  if (quote.partial)
    return (
      <Row data-reply-to={quote.id} data-reply-loading gap="none" look="h-5" place="relative">
        {connector}
        {gutter}
        <span className="h-2 w-32 rounded-full bg-surface-container-highest" />
      </Row>
    )
  if (quote.deleted || !author)
    return (
      <Row data-reply-to={quote.id} gap="none" text="xs" ink="muted" look="h-5" place="relative">
        {connector}
        {gutter}
        <span className="truncate italic">Original message was deleted</span>
      </Row>
    )
  if (blocked && shown !== authorKey)
    return (
      <Row data-reply-to={quote.id} gap="none" text="xs" ink="muted" look="h-5" place="relative">
        {connector}
        {gutter}
        <BlockedQuote onShow={() => setShown(authorKey)} />
      </Row>
    )
  return (
    <Row data-reply-to={quote.id} gap="none" text="xs" look="min-h-5" place="relative min-w-0">
      {connector}
      {gutter}
      <PreviewRow
        title="Jump to message"
        onOpen={() => onJump(quote.id)}
        className="min-w-0 rounded-sm text-xs text-on-surface-variant hover:text-on-surface"
        contentClassName={inlineRowLook}
      >
        {local ? <KeyAvatar person={author} size={16} /> : <UserAvatar person={author} size={16} />}
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
            className="max-w-2/5 shrink-0 truncate font-medium text-on-surface"
          >
            <Name of={personName(author, own)} withUsername before={quote.mention ? '@' : null} />
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
    </Row>
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
    <Surface
      data-composer-bar
      row
      pad="lg"
      inset="line"
      gap="sm"
      tone="base"
      radius="none"
      text="sm"
      ink="muted"
      look="@container min-h-9 rounded-t-2xl"
    >
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {actions}
      <IconButton icon={X} label={closeLabel} size="sm" onClick={onClose} />
    </Surface>
  )
}

function Answered({ to }: { to: Replying['to'] }) {
  const shown = useShownOrNull(
    to.kind === 'account' ? to.user : null,
    to.kind === 'account' ? to.server : null
  )
  const name = to.kind === 'named' ? to.name : shown ? personName(shown) : null
  return name && <Name of={name} withUsername look="font-semibold text-on-surface" />
}

// Above a composer while its draft answers a message, whichever place it is in: who is answered,
// whether the answer pings them, and the way out.
export function ReplyBar({ list }: { list: ComposerList }) {
  const compose = useCompose(list)
  const { replying } = useLive(compose.state)
  if (!replying) return null
  const { mention } = replying
  return (
    <ComposerBar
      onClose={compose.cancelReply}
      closeLabel="Cancel reply"
      actions={
        mention !== null && (
          <Inset
            type="button"
            aria-pressed={mention}
            title={
              mention ? 'The author will be pinged. Click to turn off' : 'Click to ping the author'
            }
            onClick={compose.toggleReplyMention}
            as="button"
            pad="xs"
            inset="chip"
            align="center"
            text="xs"
            look={`rounded-md font-bold focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-10 pointer-coarse:min-w-12 ${mention ? 'text-primary hover:bg-primary/10' : 'text-on-surface-variant hover:bg-surface-container-highest'}`}
            place="shrink-0"
          >
            @ {mention ? 'ON' : 'OFF'}
          </Inset>
        )
      }
    >
      Replying to <Answered to={replying.to} />
    </ComposerBar>
  )
}
