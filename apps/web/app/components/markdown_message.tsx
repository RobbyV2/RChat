'use client'

import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Ban,
  Clock,
  Download,
  EllipsisVertical,
  EyeOff,
  FileCode,
  FileText,
  Image as ImageIcon,
  Play,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react'
import { fmtSize } from '../lib/bytes'
import { fileLang, fenceTag } from '../lib/code'
import type { CodeNode } from '../lib/highlight'
import { relayOnly } from '../lib/ice'
import { ownTurn } from '../lib/relays'
import { api, home, localOrigins, remoteAllowed, shareOrigin } from '../lib/instances'
import { mentionCandidates, splitKnownMentions } from '../lib/mentions'
import {
  CANCELED,
  expiryDelay,
  headOf,
  keepPreview,
  p2p,
  previewUrl,
  unexpired,
  type Download as Fetched,
  type Preview,
} from '../lib/p2p'
import { sharing } from '../lib/platform'
import {
  audioHint,
  downloadName,
  guessKind,
  kindOf,
  NEUTRAL_TYPE,
  PREVIEW_MAX,
  safeType,
} from '../lib/sniff'
import {
  findInvites,
  findRemoteInvites,
  parseInvite,
  parseInviteAt,
  remoteKey,
} from '../lib/invite'
import { postedUrl, spoileredUrls } from '../lib/embed_links'
import { findMessageLinks, parseMessageLink } from '../lib/message_links'
import {
  mediaModeFor,
  previewPath,
  saveMedia,
  useLinkedSrc,
  useMediaSrc,
  usePreviewSrc,
} from '../lib/media_src'
import { expiryText, sameOriginImage } from '../lib/rules'
import { remarkMask } from '../lib/profanity'
import { markSpoilers, spoilerParts } from '../lib/spoilers'
import { hideSpoilers, type MdNode as SpoilerNode } from '../lib/spoiler_tree'
import { openActionMenu } from '../lib/actions/menu'
import { groupPills, knownMentions, useMask, userRefFor, useStore } from '../lib/store'
import { useChatSource } from './chat_source'
import type { Embed, Message, MessageMedia, UserRef } from '../lib/types'
import { longPress } from './context_menu'
import { InviteCard, RemoteInviteCard } from './invite_card'
import { MessageLinkCard } from './message_link_card'
import { RichEmbeds } from './webhooks'
import { profileTrigger } from './profile_card'
import { EditedMark } from './message_editor'
import {
  blobText,
  CodeBlock,
  CodePreview,
  CodePreviewLoading,
  keepText,
  keptText,
  nodeText,
  useServerText,
  type TextFile,
} from './code_block'
import { Stamp } from './timestamp'
import { splitStamps, type StampStyle } from '../lib/timestamps'
import { MaskControl, Masked, MaskedWord, MaskedWords, MaskPlain, useOwn } from './ui'
import { mentionHandle } from '../lib/display_name'
import { removedLifetime, removedTail } from '../lib/upload_expiry'
import { useUploadLifetime } from './upload_expiry'

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: unknown
}

// Spoilers are hidden by `lib/spoiler_tree.ts`, from the markers `markSpoilers` left in the source.
const remarkSpoiler = () => (tree: unknown, file: { toString(): string }) =>
  hideSpoilers(tree as SpoilerNode, String(file))

// Group mention pills are looked up as `\n<key>` (a username never holds a line break).
const markMentions = (
  node: MdNode,
  known: ReadonlySet<string>,
  groups: ReadonlyMap<string, string>
) => {
  const { children } = node
  if (!children) return
  const lookup = (name: string) => {
    if (known.has(name)) return name
    const group = groups.get(name)
    return group === undefined ? undefined : `\n${group}`
  }
  node.children = children.flatMap(child => {
    if (child.type === 'link' || child.type === 'linkReference') return [child]
    if (child.type !== 'text' || child.value === undefined) {
      markMentions(child, known, groups)
      return [child]
    }
    return splitKnownMentions(child.value, lookup).map(({ text, user }) =>
      user !== null
        ? {
            type: 'emphasis',
            data: {
              hName: 'span',
              hProperties: user.startsWith('\n')
                ? { 'data-group': user.slice(1) }
                : { 'data-mention': user },
            },
            children: [{ type: 'text', value: text }],
          }
        : { type: 'text', value: text }
    )
  })
}

const remarkMention =
  (known: ReadonlySet<string>, groups: ReadonlyMap<string, string>) => () => (tree: unknown) =>
    markMentions(tree as MdNode, known, groups)

// `(edited)` at the end of the last paragraph, or on its own line after other blocks.
const remarkEdited = (at: number) => () => (tree: unknown) => {
  const root = tree as MdNode
  const mark: MdNode = {
    type: 'emphasis',
    data: { hName: 'span', hProperties: { 'data-edited': String(at) } },
    children: [{ type: 'text', value: '(edited)' }],
  }
  const last = root.children?.[root.children.length - 1]
  if (last?.type === 'paragraph') last.children = [...(last.children ?? []), mark]
  else root.children = [...(root.children ?? []), { type: 'paragraph', children: [mark] }]
}

const markStamps = (node: MdNode) => {
  const { children } = node
  if (!children) return
  node.children = children.flatMap(child => {
    if (child.type !== 'text' || child.value === undefined) {
      markStamps(child)
      return [child]
    }
    if (!child.value.includes('<t:')) return [child]
    return splitStamps(child.value).map(({ text, stamp }) =>
      stamp
        ? {
            type: 'emphasis',
            data: {
              hName: 'span',
              hProperties: { 'data-stamp': String(stamp.ms), 'data-style': stamp.style },
            },
            children: [{ type: 'text', value: text }],
          }
        : { type: 'text', value: text }
    )
  })
}

const remarkStamps = () => (tree: unknown) => markStamps(tree as MdNode)

const InLink = createContext(false)

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const previews = useStore(s => s.settings.asset_previews)
  const inLink = useContext(InLink)
  // A P2P message never loads anything by itself: an image from the instance would tell it what
  // was said and when it was read.
  const chat = useChatSource()
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const local =
    !chat && sameOriginImage(src, window.location.href, [window.location.origin, api.origin()])
  const shown = useLinkedSrc(src, server, previews && local)
  if (previews && local && shown === undefined)
    return (
      <span className="my-1 block h-40 w-60 max-w-full motion-safe:animate-pulse rounded-xl bg-surface-container" />
    )
  if (previews && local && shown)
    return <img src={shown} alt={alt ?? ''} className="my-1 max-h-80 max-w-full rounded-xl" />
  if (!src) return <>{alt}</>
  if (inLink) return <>{alt || src}</>
  return (
    <a href={src} target="_blank" rel="noreferrer" className="text-primary underline">
      {alt || src}
    </a>
  )
}

// A `||spoiler||`: a dark pill until clicked (or Enter / Space), for this view only. "Show
// spoilers: Always" starts them open, except in streamer mode.
const useSpoilersOpen = () => useStore(s => s.showSpoilers === 'always' && !s.streamer)

// Spoilers whose reveal is shared, so the pieces of one that formatting split open together.
const RevealedSpoilers = createContext<{
  open: ReadonlySet<string>
  reveal: (piece: string) => void
} | null>(null)

function SpoilerPieces({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const reveal = useCallback(
    (piece: string) => setOpen(o => (o.has(piece) ? o : new Set(o).add(piece))),
    []
  )
  const value = useMemo(() => ({ open, reveal }), [open, reveal])
  return <RevealedSpoilers.Provider value={value}>{children}</RevealedSpoilers.Provider>
}

// `piece`: the spoiler's number in its message. `block`: it holds blocks (code, raw HTML).
function SpoilerText({
  children,
  piece,
  block = false,
}: {
  children?: ReactNode
  piece?: string
  block?: boolean
}) {
  const always = useSpoilersOpen()
  const shared = useContext(RevealedSpoilers)
  const [mine, setMine] = useState(false)
  const revealed = mine || (piece !== undefined && !!shared && shared.open.has(piece))
  const shown = useRef<HTMLDivElement & HTMLSpanElement>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (revealed && focused.current) shown.current?.focus()
  }, [revealed])
  const Tag = block ? 'div' : 'span'
  const box = block ? 'my-1 w-fit max-w-full rounded' : 'rounded px-0.5'
  if (revealed || always)
    return (
      <Tag
        ref={shown}
        tabIndex={revealed ? -1 : undefined}
        data-spoiler="shown"
        className={`${box} bg-on-surface/10 focus-visible:outline-2 focus-visible:outline-primary`}
      >
        {children}
      </Tag>
    )
  const reveal = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    focused.current = document.activeElement === e.currentTarget
    setMine(true)
    if (piece !== undefined) shared?.reveal(piece)
  }
  return (
    <Tag
      data-spoiler="hidden"
      role="button"
      tabIndex={0}
      aria-label="Spoiler, press to reveal"
      title="Spoiler"
      onClick={reveal}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') reveal(e)
      }}
      className={`${box} cursor-pointer bg-spoiler select-none hover:bg-spoiler/85 focus-visible:outline-2 focus-visible:outline-primary`}
    >
      <Tag className="invisible" aria-hidden>
        <MaskControl>{children}</MaskControl>
      </Tag>
    </Tag>
  )
}

function Mention({ username }: { username: string }) {
  const src = useChatSource()
  const stored = useStore(s => (src ? null : userRefFor(s, username)))
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const storeMine = useStore(s => s.me?.username === username)
  const user = src ? src.user(username) : (stored as UserRef)
  const mine = src ? src.mine(username) : storeMine
  return (
    <span
      {...(src ? {} : profileTrigger(user, server))}
      data-mention={username}
      className={`streamer cursor-pointer rounded px-0.5 font-medium hover:underline ${
        mine ? 'bg-primary-container text-on-primary-container' : 'bg-primary/15 text-primary'
      }`}
    >
      @
      <MaskControl>
        <Masked text={mentionHandle(user)} own={mine} />
      </MaskControl>
    </span>
  )
}

const childText = (c: ReactNode): string =>
  typeof c === 'string' || typeof c === 'number'
    ? String(c)
    : Array.isArray(c)
      ? c.map(childText).join('')
      : ''

// `@everyone` and `@here` in a neutral pill, a role in its color.
function GroupPill({ group, text }: { group: string; text: string }) {
  const id = group[0] === 'r' ? Number(group.slice(1)) : null
  const role = useStore(s => {
    for (const detail of Object.values(s.servers)) {
      const r = detail.roles.find(x => x.id === id)
      if (r) return r
    }
    return null
  })
  const owner = useStore(
    s => Object.values(s.servers).find(d => d.roles.some(x => x.id === id))?.creator ?? null
  )
  if (role)
    return (
      <span
        data-group={group}
        style={{ color: role.color, backgroundColor: `${role.color}26` }}
        className="rounded px-0.5 font-medium"
      >
        @
        <MaskControl>
          <Masked text={role.name} by={owner} />
        </MaskControl>
      </span>
    )
  return (
    <span
      data-group={group}
      className="rounded bg-on-surface/10 px-0.5 font-medium text-on-surface"
    >
      {text}
    </span>
  )
}

export function MessageLink({ href, children, ...props }: React.ComponentProps<'a'>) {
  const invite = href ? parseInvite(href, shareOrigin()) : null
  const target = href && !invite ? parseMessageLink(href, localOrigins()) : null
  const body = (
    <InLink.Provider value>
      <MaskControl>{children}</MaskControl>
    </InLink.Provider>
  )
  if (target)
    return (
      <a
        {...props}
        href={href}
        onClick={e => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          void useStore.getState().openMessage(target.id)
        }}
        className="text-primary underline"
      >
        {body}
      </a>
    )
  if (!invite)
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer" className="text-primary underline">
        {body}
      </a>
    )
  return (
    <a
      {...props}
      href={href}
      onClick={e => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        useStore.getState().openInvite(invite.server, invite.password)
      }}
      className="text-primary underline"
    >
      {body}
    </a>
  )
}

const components: Components = {
  span: ({ node, ...props }) =>
    'data-masked' in props ? (
      <MaskedWord
        hidden={String((props as Record<string, unknown>)['data-masked'])}
        word={String((props as Record<string, unknown>)['data-mask-word'])}
      >
        {props.children}
      </MaskedWord>
    ) : 'data-spoiler' in props ? (
      <SpoilerText piece={String((props as Record<string, unknown>)['data-spoiler'])}>
        {props.children}
      </SpoilerText>
    ) : 'data-edited' in props ? (
      <EditedMark at={Number((props as Record<string, unknown>)['data-edited'])} />
    ) : 'data-stamp' in props ? (
      <Stamp
        ms={Number((props as Record<string, unknown>)['data-stamp'])}
        style={(props as Record<string, unknown>)['data-style'] as StampStyle}
        token={String(props.children)}
      />
    ) : 'data-mention' in props ? (
      <Mention username={String((props as Record<string, unknown>)['data-mention'])} />
    ) : 'data-group' in props ? (
      <GroupPill
        group={String((props as Record<string, unknown>)['data-group'])}
        text={childText(props.children)}
      />
    ) : (
      <span {...props} />
    ),
  div: ({ node, ...props }) =>
    'data-spoiler' in props ? (
      <SpoilerText piece={String((props as Record<string, unknown>)['data-spoiler'])} block>
        {props.children}
      </SpoilerText>
    ) : (
      <div {...props} />
    ),
  img: ({ src, alt }) => (
    <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />
  ),
  a: ({ node, ...props }) => <MessageLink {...props} />,
  p: ({ node, ...props }) => <p {...props} className="my-0.5" />,
  ul: ({ node, ...props }) => <ul {...props} className="my-1 list-disc pl-5" />,
  ol: ({ node, ...props }) => <ol {...props} className="my-1 list-decimal pl-5" />,
  blockquote: ({ node, ...props }) => (
    <blockquote
      {...props}
      className="my-1 border-l-2 border-outline pl-3 text-on-surface-variant"
    />
  ),
  code: ({ node, ...props }) => (
    <code {...props} className="rounded bg-surface-container-high px-1 py-0.5 font-mono text-xs" />
  ),
  pre: ({ node, ...props }) => {
    const code = node?.children[0]
    if (code?.type === 'element' && code.tagName === 'code')
      return (
        <CodeBlock
          code={nodeText(code as CodeNode).replace(/\n$/, '')}
          tag={fenceTag(code.properties.className)}
        />
      )
    return (
      <pre
        {...props}
        className="my-1 overflow-x-auto rounded-lg bg-surface-container-high p-2 [&_code]:bg-transparent [&_code]:p-0"
      />
    )
  },
  h1: ({ node, ...props }) => <h1 {...props} className="my-1 text-lg font-bold" />,
  h2: ({ node, ...props }) => <h2 {...props} className="my-1 text-base font-bold" />,
  h3: ({ node, ...props }) => <h3 {...props} className="my-1 text-sm font-bold" />,
  table: ({ node, ...props }) => (
    <div className="my-1 max-w-full overflow-x-auto">
      <table {...props} className="border-collapse text-xs" />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th {...props} className="border border-outline-variant px-2 py-1 text-left" />
  ),
  td: ({ node, ...props }) => <td {...props} className="border border-outline-variant px-2 py-1" />,
}

const fmtExpiry = (ts: number | null) =>
  ts === null ? 'Indefinite' : expiryText(ts - Math.floor(Date.now() / 1000))

// The cover of a hidden spoiler attachment.
export function SpoilerCover({ title, onReveal }: { title?: string; onReveal: () => void }) {
  return (
    <button
      title={title}
      aria-label="Spoiler attachment, press to reveal"
      onClick={onReveal}
      className="mt-1 flex w-fit items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 hover:bg-surface-container-high"
    >
      <EyeOff size={18} className="shrink-0 text-on-surface-variant" />
      <span className="rounded-full bg-spoiler px-2 py-0.5 text-xs font-medium tracking-wide text-white uppercase">
        Spoiler
      </span>
      <span className="text-sm text-on-surface-variant">Reveal</span>
    </button>
  )
}

const UNVERIFIED = 'Unverified: sent from an older app'

function P2pFile({ media, messageId }: { media: MessageMedia; messageId: number }) {
  const me = useStore(s => s.me)
  const previews = useStore(s => s.settings.asset_previews)
  const streamer = useStore(s => s.streamer)
  const avail = useStore(s => (media.hoster !== null ? s.p2pAvailability[media.hoster] : undefined))
  // Fetching from the sender shows them our IP address, so images load on their own only when
  // that goes through the relay, or when nothing has to be fetched.
  const hidesIp = useStore(s =>
    relayOnly(s.instance?.ice, s.iceHelpers, s.iceRelay, ownTurn(s.relayPrefs))
  )
  const { id, filename, hoster, expires_at, spoiler, size, mime } = media
  const sha256 = media.sha256 ?? null
  const [shown, setShown] = useState<Preview | null>(() => previewUrl(messageId))
  const [progress, setProgress] = useState<{ got: number; total: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const ctl = useRef<{ stop: AbortController; save: boolean } | null>(null)

  const [, tick] = useState(0)
  useEffect(() => {
    const wait = expiryDelay(expires_at, Date.now())
    if (wait === null) return
    const t = setTimeout(() => tick(n => n + 1), wait)
    return () => clearTimeout(t)
  }, [expires_at])

  useEffect(
    () => () => {
      if (ctl.current && !ctl.current.save) ctl.current.stop.abort()
    },
    []
  )

  const live = unexpired(expires_at, Math.floor(Date.now() / 1000))
  const own = me !== null && hoster === me.username
  const localFile = live && own ? p2p.file(id) : null
  const hosted = live && avail?.online === true && avail.ids.includes(id)
  const online = localFile !== null || hosted
  const hosterName =
    hoster !== null ? userRefFor(useStore.getState(), hoster).display_name : 'the sender'
  const guess = guessKind(filename)
  const audio = audioHint(filename, mime)
  const unverified = sha256 === null && !own
  const canPreview =
    previews && guess !== null && !unverified && size !== null && size <= PREVIEW_MAX
  // Text is shown inert, so files without a checksum get a plain preview too.
  const lang = fileLang(filename)
  const canText = previews && lang !== null && size !== null && size <= PREVIEW_MAX
  const [text, setText] = useState<TextFile | null>(
    () => (canText && live ? keptText(`p2p:${messageId}`) : null) ?? null
  )
  const always = useSpoilersOpen()
  const hidden = spoiler && !revealed && !always
  const busy = progress !== null
  const autoLoad =
    hidesIp || localFile !== null || (hoster !== null && p2p.hasReceived(id, hoster, sha256))

  const fetchFile = async (signal: AbortSignal): Promise<Fetched> => {
    const kept = hoster !== null ? await p2p.receivedFile(id, hoster, sha256) : null
    if (kept) return kept
    if (localFile) {
      const blob = await p2p.blob(id)
      if (!blob) throw new Error('File not available')
      const type = safeType(await headOf(blob), audio)
      return { blob: new Blob([blob], { type }), type, verified: true }
    }
    if (!hosted || hoster === null) throw new Error('File not available')
    const grant = await p2p.requestPeer(messageId)
    if (signal.aborted) throw new Error(CANCELED)
    return p2p.download(grant.peerId, id, {
      token: grant.token,
      relays: grant.relays,
      size,
      sha256,
      hoster,
      messageId,
      audio,
      signal,
      onProgress: (got, total) => setProgress({ got, total }),
    })
  }

  const run = (save: boolean) => {
    if (ctl.current) return
    const c = new AbortController()
    const job = { stop: c, save }
    ctl.current = job
    setFailed(null)
    setProgress({ got: 0, total: size ?? 0 })
    fetchFile(c.signal)
      .then(async got => {
        if (canText && !save) {
          const file = await blobText(got.blob)
          keepText(`p2p:${messageId}`, file && { ...file, verified: got.verified })
          setText(file && { ...file, verified: got.verified })
        }
        const kind = kindOf(got.type)
        if (canPreview && got.verified && kind !== null && got.blob.size <= PREVIEW_MAX) {
          const preview = { url: URL.createObjectURL(got.blob), kind }
          keepPreview(messageId, preview)
          setShown(preview)
        }
        if (save)
          sharing().saveBlob(downloadName(filename), new Blob([got.blob], { type: NEUTRAL_TYPE }))
      })
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e)
        if (text === CANCELED) return
        setFailed(text)
        if (save) p2p.onError(text)
        else console.error('p2p fetch', e)
      })
      .finally(() => {
        if (ctl.current === job) ctl.current = null
        setProgress(null)
      })
  }

  useEffect(() => {
    if (!canPreview || guess !== 'image' || !autoLoad || shown !== null || !online || hidden) return
    if (ctl.current || failed !== null) return
    run(false)
  }, [canPreview, guess, autoLoad, shown, online, hidden, failed])

  useEffect(() => {
    if (!canText || !autoLoad || text !== null || !online || hidden) return
    if (ctl.current || failed !== null || keptText(`p2p:${messageId}`) === null) return
    run(false)
  }, [canText, autoLoad, text, online, hidden, failed, messageId])

  useEffect(() => {
    setFailed(null)
  }, [avail])

  const meta = (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
      <span
        title="Hosted peer-to-peer from the sender's browser"
        className="flex items-center gap-1 rounded bg-tertiary-container px-1.5 py-0.5 font-medium text-on-tertiary-container"
      >
        <Share2 size={10} />
        P2P
      </span>
      <span className="streamer truncate">
        <Masked text={hosterName} own={own} />
      </span>
      <span>·</span>
      <span>{fmtExpiry(expires_at)}</span>
      {unverified && (
        <span
          title="This file has no checksum, so its contents can't be verified"
          className="flex items-center gap-1 text-error"
        >
          <ShieldAlert size={12} />
          {UNVERIFIED}
        </span>
      )}
    </span>
  )

  if (hidden) {
    return <SpoilerCover title="Reveal" onReveal={() => setRevealed(true)} />
  }

  const saveButton = (
    <button
      title={
        streamer || hoster === null
          ? "Download from the sender's browser"
          : `Download from ${hosterName}'s browser`
      }
      aria-label="Download"
      onClick={() => run(true)}
      disabled={busy || !online}
      className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40"
    >
      <Download size={14} />
    </button>
  )

  if (text !== null && lang !== null) {
    return (
      <CodePreview
        filename={filename}
        size={size}
        lang={lang}
        file={text}
        plain={text.verified === false}
        note={text.verified === false ? 'Not verified, so shown as plain text' : undefined}
        actions={saveButton}
        footer={<div className="px-3 pb-2">{meta}</div>}
      />
    )
  }

  if (shown !== null) {
    return (
      <div className="mt-1 w-fit max-w-full">
        {shown.kind === 'image' ? (
          <img src={shown.url} alt={filename} className="max-h-80 max-w-full rounded-xl" />
        ) : shown.kind === 'video' ? (
          <video src={shown.url} controls className="max-h-80 max-w-full rounded-xl" />
        ) : (
          <audio src={shown.url} controls className="max-w-full" />
        )}
        <span className="mt-1 flex items-center gap-2">
          <span className="max-w-60 truncate text-xs text-on-surface-variant">
            <Masked text={filename} own={own} />
          </span>
          {saveButton}
        </span>
        {meta}
      </div>
    )
  }

  if (!online) {
    const generic = streamer || hoster === null
    return (
      <div
        title={
          generic
            ? 'File not available. Ask the sender to send it again.'
            : `File not available. Ask ${hosterName} to send it again.`
        }
        className="mt-1 w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2 opacity-60"
      >
        <span className="flex items-center gap-2 text-sm text-on-surface-variant">
          <FileText size={18} className="shrink-0" />
          <span className="max-w-60 truncate">
            <Masked text={filename} own={own} />
          </span>
        </span>
        <p className="mt-1 text-xs text-on-surface-variant italic">
          File not available. Ask{' '}
          {hoster === null ? (
            'the sender'
          ) : (
            <span className="streamer">
              <Masked text={hosterName} own={own} />
            </span>
          )}{' '}
          to send it again.
        </p>
        {meta}
      </div>
    )
  }

  const pct =
    progress && progress.total > 0 ? Math.min(100, (progress.got / progress.total) * 100) : 0
  return (
    <div className="mt-1 w-fit max-w-full rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
      <div className="flex items-center gap-2">
        <FileText size={18} className="shrink-0 text-tertiary" />
        <span className="max-w-60 truncate text-sm">
          <Masked text={filename} own={own} />
        </span>
        {size !== null && (
          <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
            {fmtSize(size)}
          </span>
        )}
        {busy ? (
          <button
            title="Cancel download"
            aria-label="Cancel download"
            onClick={() => ctl.current?.stop.abort()}
            className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
          >
            <X size={14} />
          </button>
        ) : (
          <>
            {canPreview && guess === 'image' && !autoLoad && (
              <button
                title="Show image (connects to the sender)"
                aria-label="Show image"
                onClick={() => run(false)}
                className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary"
              >
                <ImageIcon size={14} />
              </button>
            )}
            {canText && !autoLoad && keptText(`p2p:${messageId}`) !== null && (
              <button
                title="Show preview (connects to the sender)"
                aria-label="Show preview"
                onClick={() => run(false)}
                className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary"
              >
                <FileCode size={14} />
              </button>
            )}
            {canPreview && guess !== 'image' && (
              <button
                title={guess === 'video' ? 'Play video' : 'Play audio'}
                aria-label={guess === 'video' ? 'Play video' : 'Play audio'}
                onClick={() => run(false)}
                className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary"
              >
                <Play size={14} />
              </button>
            )}
            {saveButton}
          </>
        )}
      </div>
      {busy && (
        <div
          role="progressbar"
          aria-label={`Downloading ${filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          className="mt-2 h-1 w-full min-w-40 overflow-hidden rounded-full bg-surface-container-highest"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      )}
      {failed !== null && <p className="mt-1 text-xs text-error">{failed}</p>}
      {meta}
    </div>
  )
}

function MediaAttachment({
  media,
  own,
  postedAt,
}: {
  media: MessageMedia
  own: boolean
  postedAt: number
}) {
  const previews = useStore(s => s.settings.asset_previews)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const [revealed, setRevealed] = useState(false)
  const always = useSpoilersOpen()
  const lifetime = useUploadLifetime(server)
  const { id, filename, removed, removed_by_author, spoiler, expires_at } = media
  const image = previews && IMAGE_EXT.test(filename)
  const src = useMediaSrc(id, server, image && !removed)
  const fetched = mediaModeFor(server) === 'blob'
  const lang = previews && !image ? fileLang(filename) : null
  const text = useServerText(
    id,
    server,
    lang !== null && !removed && !(spoiler && !revealed && !always)
  )
  if (removed) {
    return (
      <p className="mt-1 text-xs text-on-surface-variant italic">
        {removed_by_author ? (
          'Attachment removed'
        ) : (
          <>
            File <Masked text={filename} own={own} />{' '}
            {removedTail(removedLifetime(expires_at, postedAt, lifetime))}
          </>
        )}
      </p>
    )
  }
  const hidden = spoiler && !revealed && !always
  const expiry =
    expires_at !== null ? (
      <span className="mt-1.5 flex items-center gap-1 text-xs text-on-surface-variant">
        <Clock size={10} />
        {fmtExpiry(expires_at)}
      </span>
    ) : null
  if (image && src === undefined)
    return (
      <div className="mt-1 h-40 w-60 max-w-full motion-safe:animate-pulse rounded-xl bg-surface-container" />
    )
  if (image && src !== null) {
    if (hidden) {
      return (
        <button
          title="Reveal"
          aria-label="Spoiler image, press to reveal"
          data-spoiler-media
          onClick={() => setRevealed(true)}
          className="relative mt-1 block w-fit overflow-hidden rounded-xl"
        >
          <img src={src} alt="Spoiler" className="max-h-80 max-w-full blur-2xl" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-scrim/70 px-3 py-1 text-xs font-medium tracking-wide text-white uppercase">
              Spoiler
            </span>
          </span>
        </button>
      )
    }
    return (
      <div className="mt-1 w-fit">
        <a href={src} target="_blank" rel="noreferrer" className="block w-fit">
          <img src={src} alt={filename} className="max-h-80 max-w-full rounded-xl" />
        </a>
        {expiry}
      </div>
    )
  }
  if (hidden) {
    return <SpoilerCover onReveal={() => setRevealed(true)} />
  }
  const save = () =>
    void saveMedia(id, server, filename).catch((err: unknown) =>
      useStore.getState().setError(err instanceof Error ? err.message : String(err))
    )
  if (lang !== null && text === undefined) return <CodePreviewLoading filename={filename} />
  if (lang !== null && text) {
    const iconBtn =
      'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary'
    return (
      <CodePreview
        filename={filename}
        size={media.size}
        lang={lang}
        file={text}
        actions={
          fetched ? (
            <button
              title={`Download ${filename}`}
              aria-label="Download"
              onClick={save}
              className={iconBtn}
            >
              <Download size={14} />
            </button>
          ) : (
            <a
              href={api.mediaUrl(id)}
              download={filename}
              title={`Download ${filename}`}
              aria-label="Download"
              className={iconBtn}
            >
              <Download size={14} />
            </a>
          )
        }
        footer={expiry && <div className="px-3 pb-2">{expiry}</div>}
      />
    )
  }
  const card = (
    <>
      <span className="flex items-center gap-2">
        <FileText size={18} className="shrink-0 text-primary" />
        <span className="max-w-60 truncate text-sm">
          <Masked text={filename} own={own} />
        </span>
        <Download size={14} className="shrink-0 text-on-surface-variant" />
      </span>
      {expiry}
    </>
  )
  const box =
    'mt-1 block w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-left hover:bg-surface-container-high'
  if (fetched) {
    return (
      <button title={`Download ${filename}`} onClick={save} className={box}>
        {card}
      </button>
    )
  }
  return (
    <a href={api.mediaUrl(id)} download={filename} className={box}>
      {card}
    </a>
  )
}

function EmbedCard({
  embed,
  message,
  canDelete,
}: {
  embed: Embed
  message: Message
  canDelete: boolean
}) {
  const { ord, site_name, title, description, image_url, banner_removed } = embed
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const path = banner_removed ? null : previewPath(message.id, ord, image_url)
  const src = usePreviewSrc(path, server)
  const [broken, setBroken] = useState<string | null>(null)
  const url = useMemo(() => postedUrl(message.content, embed.url), [message.content, embed.url])

  const menu = (x: number, y: number) =>
    openActionMenu(x, y, { kind: 'embed', message, ord, banner: path !== null })

  return (
    <div
      {...(canDelete ? longPress(menu) : {})}
      className="group/embed relative mt-1 w-fit max-w-md rounded-lg border-l-4 border-primary bg-surface-container py-2 pr-8 pl-3"
    >
      {site_name !== null && (
        <div className="text-xs text-on-surface-variant">
          <Masked text={site_name} />
        </div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block text-sm font-medium break-words text-primary hover:underline"
      >
        {title === null ? url : <Masked text={title} />}
      </a>
      {description !== null && (
        <p className="mt-0.5 line-clamp-3 text-xs break-words text-on-surface-variant">
          <Masked text={description} />
        </p>
      )}
      {src && broken !== src && (
        <img
          src={src}
          alt={title ?? url}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setBroken(src)}
          className="mt-2 max-h-60 max-w-full rounded-md"
        />
      )}
      {canDelete && (
        <button
          title="Embed options"
          aria-label="Embed options"
          onClick={e => menu(e.clientX, e.clientY)}
          className="absolute top-1.5 right-1.5 rounded-full p-1 text-on-surface-variant opacity-0 group-focus-within/embed:opacity-100 group-hover/embed:opacity-100 hover:bg-surface-container-highest max-md:opacity-100"
        >
          <EllipsisVertical size={14} />
        </button>
      )}
    </div>
  )
}

// In place of a preview for a link inside a spoiler: nothing is fetched for it. Revealing shows
// the link itself, still without a preview.
function SpoilerLinkCard({ url }: { url: string }) {
  const always = useSpoilersOpen()
  const [revealed, setRevealed] = useState(false)
  const box =
    'mt-1 flex w-fit max-w-md items-center gap-2 rounded-lg border-l-4 border-outline bg-surface-container py-2 pr-3 pl-3 text-sm'
  if (revealed || always)
    return (
      <div data-spoiler-link="shown" className={box}>
        <EyeOff size={14} className="shrink-0 text-on-surface-variant" />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 break-all text-primary hover:underline"
        >
          {url}
        </a>
      </div>
    )
  return (
    <button
      type="button"
      data-spoiler-link="hidden"
      title="Spoiler link, click to show"
      aria-label="Spoiler link, press to show"
      onClick={() => setRevealed(true)}
      className={`${box} text-on-surface-variant hover:bg-surface-container-high`}
    >
      <EyeOff size={14} className="shrink-0" />
      <span className="rounded-full bg-spoiler px-2 py-0.5 text-xs font-medium tracking-wide text-white uppercase">
        Spoiler
      </span>
      Link hidden
    </button>
  )
}

// Text inside a webhook's rich embed, read like messages (spoilers, the personal filter) but
// without mentions. `text` is markdown; `line` is one plain line (title, field name, footer).
function useCardText() {
  const mask = useMask()
  return useMemo(() => {
    const plugins = [remarkGfm, remarkSpoiler, remarkMask(mask)]
    return {
      text: (text: string) => (
        <MaskPlain>
          <MaskedWords>
            <SpoilerPieces>
              <ReactMarkdown remarkPlugins={plugins} components={components}>
                {markSpoilers(text)}
              </ReactMarkdown>
            </SpoilerPieces>
          </MaskedWords>
        </MaskPlain>
      ),
      line: (text: string) =>
        spoilerParts(text).map((part, i) =>
          part.spoiler ? (
            <SpoilerText key={i}>
              <Masked text={part.text} />
            </SpoilerText>
          ) : (
            <Fragment key={i}>
              <Masked text={part.text} />
            </Fragment>
          )
        ),
    }
  }, [mask])
}

export const MarkdownMessage = memo(function MarkdownMessage({
  message,
  canDelete = false,
  editor,
}: {
  message: Message
  canDelete?: boolean
  editor?: ReactNode
}) {
  const deleteMedia = useStore(s => s.deleteMedia)
  const previews = useStore(s => s.settings.asset_previews)
  const uploads = useStore(s => s.settings.asset_uploads)
  const p2pOn = useStore(s => s.settings.p2p_attachments)
  const attachmentsOff = (m: MessageMedia) =>
    !uploads && !p2pOn
      ? 'Attachments are turned off on this server'
      : m.kind === 'p2p' && !p2pOn
        ? 'P2P attachments are turned off on this server'
        : null
  const { content, media, embeds, edited_at: edited } = message
  const candidates = useMemo(
    () => (content.includes('@') ? mentionCandidates(content) : []),
    [content]
  )
  const src = useChatSource()
  const stored = useStore(s => (src ? '' : knownMentions(s, message, candidates)))
  const known = src ? src.known(message, candidates) : stored
  const pills = useStore(s => groupPills(s, message))
  const own = useOwn(message.webhook || message.forward ? null : message.author.username)
  const mask = useMask(own)
  const card = useCardText()
  // P2P conversations show no previews: they would ask the instance about what was said.
  const plugins = useMemo(
    () => [
      remarkGfm,
      remarkSpoiler,
      remarkStamps,
      remarkMention(
        new Set(known ? known.split('\n') : []),
        new Map(pills ? pills.split('\n').map(line => line.split('\t') as [string, string]) : [])
      ),
      ...(edited ? [remarkEdited(edited)] : []),
      remarkMask(mask),
    ],
    [known, pills, edited, mask]
  )
  const source = useMemo(() => markSpoilers(content), [content])
  const hidden = useMemo(() => spoileredUrls(content), [content])
  const homePublic = useStore(s => s.instance?.public_url ?? null)
  const local = useMemo(() => localOrigins(homePublic), [homePublic])
  const invites = useMemo(() => {
    const found = local.flatMap(origin => findInvites(content, origin))
    return found.filter((i, at) => found.findIndex(o => o.server === i.server) === at).slice(0, 3)
  }, [content, local])
  const messageLinks = useMemo(() => findMessageLinks(content, local), [content, local])
  const remotes = useMemo(
    () => findRemoteInvites(content, local, origin => remoteAllowed(origin, home.origin)),
    [content, local]
  )
  const [remoteOk, setRemoteOk] = useState<Record<string, boolean>>({})
  const onResolved = useCallback(
    (key: string, ok: boolean) => setRemoteOk(m => (m[key] === ok ? m : { ...m, [key]: ok })),
    []
  )
  const links = useMemo(
    () =>
      embeds.filter(e => {
        if (hidden.includes(e.url)) return false
        if (local.some(origin => parseInvite(e.url, origin) !== null)) return false
        if (parseMessageLink(e.url, local)) return false
        const remote = parseInviteAt(e.url, 'http://invalid')
        return !(remote && remoteOk[remoteKey(remote)])
      }),
    [embeds, local, remoteOk, hidden]
  )
  return (
    <div className="min-w-0 text-sm leading-relaxed break-words">
      {editor ??
        (content.trim() !== '' ? (
          <MaskPlain>
            <MaskedWords>
              <SpoilerPieces>
                <ReactMarkdown remarkPlugins={plugins} components={components}>
                  {source}
                </ReactMarkdown>
              </SpoilerPieces>
            </MaskedWords>
          </MaskPlain>
        ) : (
          edited && (
            <p className="my-0.5">
              <EditedMark at={edited} />
            </p>
          )
        ))}
      {media !== null && (
        <div className="group/att relative w-fit max-w-full">
          {!media.removed && attachmentsOff(media) ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-on-surface-variant italic">
              <Ban size={12} className="shrink-0" />
              {attachmentsOff(media)}
            </p>
          ) : media.kind === 'p2p' && !media.removed ? (
            <P2pFile media={media} messageId={message.id} />
          ) : (
            <MediaAttachment media={media} own={own} postedAt={message.created_at} />
          )}
          {canDelete && !media.removed && (
            <button
              title="Remove attachment"
              onClick={() => void deleteMedia(message.id)}
              className="absolute -top-1.5 -right-1.5 rounded-full bg-surface-container-highest p-1 text-on-surface-variant opacity-0 shadow-elevation-1 group-focus-within/att:opacity-100 group-hover/att:opacity-100 hover:text-error max-md:opacity-100"
            >
              <X size={12} />
            </button>
          )}
        </div>
      )}
      {message.webhook && message.webhook.embeds.length > 0 && (
        <RichEmbeds embeds={message.webhook.embeds} text={card.text} line={card.line} />
      )}
      {!src && messageLinks.map(l => <MessageLinkCard key={l.id} link={l} />)}
      {!src &&
        invites.map(i => (
          <InviteCard key={i.server} variant="embed" server={i.server} password={i.password} />
        ))}
      {previews &&
        !src &&
        remotes.map(i => (
          <RemoteInviteCard key={remoteKey(i)} invite={i} onResolved={onResolved} />
        ))}
      {previews &&
        !src &&
        links.map(e => <EmbedCard key={e.ord} embed={e} message={message} canDelete={canDelete} />)}
      {previews && hidden.slice(0, 3).map(url => <SpoilerLinkCard key={url} url={url} />)}
    </div>
  )
})
