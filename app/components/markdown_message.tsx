'use client'

import {
  createContext,
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
  FileText,
  Image as ImageIcon,
  Play,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react'
import { relayOnly } from '../lib/ice'
import { api, home, localOrigins, remoteAllowed } from '../lib/instances'
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
import { postedUrl } from '../lib/embed_links'
import { expiryText, sameOriginImage } from '../lib/rules'
import { knownMentions, userRefFor, useStore, type ContextMenuItem } from '../lib/store'
import type { Embed, Message, MessageMedia } from '../lib/types'
import { longPress } from './context_menu'
import { InviteCard, RemoteInviteCard } from './invite_card'
import { profileTrigger } from './profile_card'
import { EditedMark } from './message_editor'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: unknown
}

const splitSpoilers = (node: MdNode) => {
  const { children } = node
  if (!children) return
  for (const child of children) splitSpoilers(child)
  const tokens: (MdNode | null)[] = []
  for (const child of children) {
    if (child.type === 'text' && child.value !== undefined && child.value.includes('||')) {
      child.value.split('||').forEach((value, i) => {
        if (i) tokens.push(null)
        if (value) tokens.push({ type: 'text', value })
      })
    } else {
      tokens.push(child)
    }
  }
  const out: MdNode[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok !== null) {
      out.push(tok)
      continue
    }
    const close = tokens.indexOf(null, i + 1)
    const inner = close === -1 ? [] : tokens.slice(i + 1, close)
    if (inner.length === 0) {
      out.push({ type: 'text', value: '||' })
      continue
    }
    out.push({
      type: 'emphasis',
      data: { hName: 'span', hProperties: { 'data-spoiler': '' } },
      children: inner.filter((t): t is MdNode => t !== null),
    })
    i = close
  }
  node.children = out
}

const remarkSpoiler = () => (tree: unknown) => splitSpoilers(tree as MdNode)

const markMentions = (node: MdNode, known: ReadonlySet<string>) => {
  const { children } = node
  if (!children) return
  node.children = children.flatMap(child => {
    if (child.type === 'link' || child.type === 'linkReference') return [child]
    if (child.type !== 'text' || child.value === undefined) {
      markMentions(child, known)
      return [child]
    }
    return splitKnownMentions(child.value, name => (known.has(name) ? name : undefined)).map(
      ({ text, user }) =>
        user !== null
          ? {
              type: 'emphasis',
              data: { hName: 'span', hProperties: { 'data-mention': user } },
              children: [{ type: 'text', value: text }],
            }
          : { type: 'text', value: text }
    )
  })
}

const remarkMention = (known: ReadonlySet<string>) => () => (tree: unknown) =>
  markMentions(tree as MdNode, known)

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

const InLink = createContext(false)

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const previews = useStore(s => s.settings.asset_previews)
  const inLink = useContext(InLink)
  const local = sameOriginImage(src, window.location.href, [window.location.origin, api.origin()])
  if (previews && local)
    return <img src={src} alt={alt ?? ''} className="my-1 max-h-80 max-w-full rounded-xl" />
  if (!src) return <>{alt}</>
  if (inLink) return <>{alt || src}</>
  return (
    <a href={src} target="_blank" rel="noreferrer" className="text-primary underline">
      {alt || src}
    </a>
  )
}

function SpoilerText({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <span
      data-spoiler={revealed ? 'shown' : 'hidden'}
      onClick={() => setRevealed(true)}
      className={`rounded px-1 ${
        revealed
          ? 'bg-surface-container-high'
          : 'cursor-pointer bg-on-surface text-transparent select-none'
      }`}
    >
      {children}
    </span>
  )
}

function Mention({ username }: { username: string }) {
  const user = useStore(s => userRefFor(s, username))
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const mine = useStore(s => s.me?.username === username)
  return (
    <span
      {...profileTrigger(user, server)}
      data-mention={username}
      className={`streamer cursor-pointer rounded px-0.5 font-medium hover:underline ${
        mine ? 'bg-primary-container text-on-primary-container' : 'bg-primary/15 text-primary'
      }`}
    >
      @{user.display_name}
    </span>
  )
}

function MessageLink({ href, children, ...props }: React.ComponentProps<'a'>) {
  const invite = href ? parseInvite(href, window.location.origin) : null
  const body = <InLink.Provider value>{children}</InLink.Provider>
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
    'data-spoiler' in props ? (
      <SpoilerText>{props.children}</SpoilerText>
    ) : 'data-edited' in props ? (
      <EditedMark at={Number((props as Record<string, unknown>)['data-edited'])} />
    ) : 'data-mention' in props ? (
      <Mention username={String((props as Record<string, unknown>)['data-mention'])} />
    ) : (
      <span {...props} />
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
  pre: ({ node, ...props }) => (
    <pre
      {...props}
      className="my-1 overflow-x-auto rounded-lg bg-surface-container-high p-2 [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
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

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(0)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`

const UNVERIFIED = 'Unverified: sent from an older app'

function P2pFile({ media, messageId }: { media: MessageMedia; messageId: number }) {
  const me = useStore(s => s.me)
  const previews = useStore(s => s.settings.asset_previews)
  const avail = useStore(s => (media.hoster !== null ? s.p2pAvailability[media.hoster] : undefined))
  // Fetching from the sender shows them our IP address, so images load on their own only when
  // that goes through the relay, or when nothing has to be fetched.
  const hidesIp = useStore(s => relayOnly(s.instance?.ice, s.iceHelpers, s.iceRelay))
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
  const hidden = spoiler && !revealed
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
      .then(got => {
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
      <span className="streamer truncate">{hosterName}</span>
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
    return (
      <button
        title="Click to reveal"
        onClick={() => setRevealed(true)}
        className="mt-1 flex w-fit cursor-pointer items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 hover:bg-surface-container-high"
      >
        <EyeOff size={18} className="shrink-0 text-on-surface-variant" />
        <span className="text-sm text-on-surface-variant">Spoiler · click to reveal</span>
      </button>
    )
  }

  const saveButton = (
    <button
      title={`Download from ${hosterName}'s browser`}
      aria-label="Download"
      onClick={() => run(true)}
      disabled={busy || !online}
      className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40"
    >
      <Download size={14} />
    </button>
  )

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
          <span className="max-w-60 truncate text-xs text-on-surface-variant">{filename}</span>
          {saveButton}
        </span>
        {meta}
      </div>
    )
  }

  if (!online) {
    const notice = `File not available. Ask ${hosterName} to send it again.`
    return (
      <div
        title={notice}
        className="mt-1 w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2 opacity-60"
      >
        <span className="flex items-center gap-2 text-sm text-on-surface-variant">
          <FileText size={18} className="shrink-0" />
          <span className="max-w-60 truncate">{filename}</span>
        </span>
        <p className="mt-1 text-xs text-on-surface-variant italic">{notice}</p>
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
        <span className="max-w-60 truncate text-sm">{filename}</span>
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

function MediaAttachment({ media }: { media: MessageMedia }) {
  const previews = useStore(s => s.settings.asset_previews)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const [revealed, setRevealed] = useState(false)
  const { id, filename, removed, removed_by_author, spoiler, expires_at } = media
  if (removed) {
    return (
      <p className="mt-1 text-xs text-on-surface-variant italic">
        {removed_by_author
          ? 'Attachment removed'
          : `File ${filename} was removed after 1 day of posting`}
      </p>
    )
  }
  const url = api.mediaUrl(id, server)
  const hidden = spoiler && !revealed
  const expiry =
    expires_at !== null ? (
      <span className="mt-1.5 flex items-center gap-1 text-xs text-on-surface-variant">
        <Clock size={10} />
        {fmtExpiry(expires_at)}
      </span>
    ) : null
  if (previews && IMAGE_EXT.test(filename)) {
    if (hidden) {
      return (
        <button
          title="Click to reveal"
          onClick={() => setRevealed(true)}
          className="relative mt-1 block w-fit cursor-pointer overflow-hidden rounded-xl"
        >
          <img src={url} alt="Spoiler" className="max-h-80 max-w-full blur-2xl" />
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
        <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
          <img src={url} alt={filename} className="max-h-80 max-w-full rounded-xl" />
        </a>
        {expiry}
      </div>
    )
  }
  if (hidden) {
    return (
      <button
        onClick={() => setRevealed(true)}
        className="mt-1 flex w-fit cursor-pointer items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 hover:bg-surface-container-high"
      >
        <EyeOff size={18} className="shrink-0 text-on-surface-variant" />
        <span className="text-sm text-on-surface-variant">Spoiler · click to reveal</span>
      </button>
    )
  }
  return (
    <a
      href={url}
      download={filename}
      className="mt-1 block w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2 hover:bg-surface-container-high"
    >
      <span className="flex items-center gap-2">
        <FileText size={18} className="shrink-0 text-primary" />
        <span className="max-w-60 truncate text-sm">{filename}</span>
        <Download size={14} className="shrink-0 text-on-surface-variant" />
      </span>
      {expiry}
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
  const deleteEmbed = useStore(s => s.deleteEmbed)
  const openContextMenu = useStore(s => s.openContextMenu)
  const { ord, site_name, title, description, image_url, banner_removed } = embed
  const url = useMemo(() => postedUrl(message.content, embed.url), [message.content, embed.url])

  const menu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      {
        label: 'Remove embed',
        danger: true,
        action: () => void deleteEmbed(message.id, ord, false),
      },
    ]
    if (image_url !== null && !banner_removed) {
      items.push({ label: 'Remove banner', action: () => void deleteEmbed(message.id, ord, true) })
    }
    items.push({
      label: 'Remove all embeds',
      danger: true,
      action: () => {
        for (const e of message.embeds) void deleteEmbed(message.id, e.ord, false)
      },
    })
    openContextMenu(x, y, items)
  }

  return (
    <div
      {...(canDelete ? longPress(menu) : {})}
      className="group/embed relative mt-1 w-fit max-w-md rounded-lg border-l-4 border-primary bg-surface-container py-2 pr-8 pl-3"
    >
      {site_name !== null && <div className="text-xs text-on-surface-variant">{site_name}</div>}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block text-sm font-medium break-words text-primary hover:underline"
      >
        {title ?? url}
      </a>
      {description !== null && (
        <p className="mt-0.5 line-clamp-3 text-xs break-words text-on-surface-variant">
          {description}
        </p>
      )}
      {image_url !== null && !banner_removed && (
        <img src={image_url} alt={title ?? url} className="mt-2 max-h-60 max-w-full rounded-md" />
      )}
      {canDelete && (
        <button
          title="Embed options"
          onClick={e => menu(e.clientX, e.clientY)}
          className="absolute top-1.5 right-1.5 rounded-full p-1 text-on-surface-variant opacity-0 group-focus-within/embed:opacity-100 group-hover/embed:opacity-100 hover:bg-surface-container-highest max-md:opacity-100"
        >
          <EllipsisVertical size={14} />
        </button>
      )}
    </div>
  )
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
  const known = useStore(s => knownMentions(s, message, candidates))
  const plugins = useMemo(
    () => [
      remarkGfm,
      remarkSpoiler,
      remarkMention(new Set(known ? known.split('\n') : [])),
      ...(edited ? [remarkEdited(edited)] : []),
    ],
    [known, edited]
  )
  const homePublic = useStore(s => s.instance?.public_url ?? null)
  const local = useMemo(() => localOrigins(homePublic), [homePublic])
  const invites = useMemo(() => {
    const found = local.flatMap(origin => findInvites(content, origin))
    return found.filter((i, at) => found.findIndex(o => o.server === i.server) === at).slice(0, 3)
  }, [content, local])
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
        if (local.some(origin => parseInvite(e.url, origin) !== null)) return false
        const remote = parseInviteAt(e.url, 'http://invalid')
        return !(remote && remoteOk[remoteKey(remote)])
      }),
    [embeds, local, remoteOk]
  )
  return (
    <div className="min-w-0 text-sm leading-relaxed break-words">
      {editor ??
        (content.trim() !== '' ? (
          <ReactMarkdown remarkPlugins={plugins} components={components}>
            {content}
          </ReactMarkdown>
        ) : (
          edited && (
            <p className="my-0.5">
              <EditedMark at={edited} />
            </p>
          )
        ))}
      {media !== null && (
        <div className="group/att relative w-fit">
          {!media.removed && attachmentsOff(media) ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-on-surface-variant italic">
              <Ban size={12} className="shrink-0" />
              {attachmentsOff(media)}
            </p>
          ) : media.kind === 'p2p' && !media.removed ? (
            <P2pFile media={media} messageId={message.id} />
          ) : (
            <MediaAttachment media={media} />
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
      {invites.map(i => (
        <InviteCard key={i.server} variant="embed" server={i.server} password={i.password} />
      ))}
      {previews &&
        remotes.map(i => (
          <RemoteInviteCard key={remoteKey(i)} invite={i} onResolved={onResolved} />
        ))}
      {previews &&
        links.map(e => <EmbedCard key={e.ord} embed={e} message={message} canDelete={canDelete} />)}
    </div>
  )
})
