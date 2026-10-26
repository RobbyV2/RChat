'use client'

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Clock, Download, EllipsisVertical, EyeOff, FileText, Share2, X } from 'lucide-react'
import { apiOrigin, mediaUrl } from '../lib/api'
import { splitMentions } from '../lib/mentions'
import { base64ToBlob, p2p } from '../lib/p2p'
import { findInvites, parseInvite } from '../lib/invite'
import { expiryText, sameOriginImage } from '../lib/rules'
import { userRefFor, useStore, type ContextMenuItem } from '../lib/store'
import type { Embed, Message, MessageMedia } from '../lib/types'
import { longPress } from './context_menu'
import { InviteCard } from './invite_card'
import { profileTrigger } from './profile_card'

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

const markMentions = (node: MdNode, username: string) => {
  const { children } = node
  if (!children) return
  node.children = children.flatMap(child => {
    if (child.type !== 'text' || child.value === undefined) {
      markMentions(child, username)
      return [child]
    }
    return splitMentions(child.value, username).map(({ text, mention }) =>
      mention
        ? {
            type: 'emphasis',
            data: { hName: 'span', hProperties: { 'data-mention': '' } },
            children: [{ type: 'text', value: text }],
          }
        : { type: 'text', value: text }
    )
  })
}

const remarkMention = (username: string) => () => (tree: unknown) =>
  markMentions(tree as MdNode, username)

const InLink = createContext(false)

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const previews = useStore(s => s.settings.asset_previews)
  const inLink = useContext(InLink)
  const local = sameOriginImage(src, window.location.href, [window.location.origin, apiOrigin()])
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

function Mention({ children }: { children?: ReactNode }) {
  const me = useStore(s => s.me)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  return (
    <span
      {...(me ? profileTrigger(me, server) : {})}
      className="streamer cursor-pointer rounded bg-primary-container px-0.5 font-medium text-on-primary-container hover:underline"
    >
      {children}
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
    ) : 'data-mention' in props ? (
      <Mention>{props.children}</Mention>
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

const objectUrls = new Map<string, string>()
const OBJECT_URLS_MAX = 32

const cachedUrl = (id: string) => {
  const u = objectUrls.get(id)
  if (u === undefined) return null
  objectUrls.delete(id)
  objectUrls.set(id, u)
  return u
}

const keepUrl = (id: string, u: string) => {
  objectUrls.delete(id)
  objectUrls.set(id, u)
  for (const [old, stale] of objectUrls) {
    if (objectUrls.size <= OBJECT_URLS_MAX) break
    objectUrls.delete(old)
    URL.revokeObjectURL(stale)
  }
}

const fmtExpiry = (ts: number | null) =>
  ts === null ? 'Indefinite' : expiryText(ts - Math.floor(Date.now() / 1000))

function P2pFile({ media }: { media: MessageMedia }) {
  const me = useStore(s => s.me)
  const previews = useStore(s => s.settings.asset_previews)
  const avail = useStore(s => (media.hoster !== null ? s.p2pAvailability[media.hoster] : undefined))
  const { id, filename, hoster, expires_at, spoiler } = media
  const [url, setUrl] = useState(() => cachedUrl(id))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const localFile = me !== null && hoster === me.username ? p2p.file(id) : null
  const peerId = avail?.online === true && avail.ids.includes(id) ? avail.peer_id : null
  const online = localFile !== null || peerId !== null
  const hosterName =
    hoster !== null ? userRefFor(useStore.getState(), hoster).display_name : 'the sender'
  const isImage = IMAGE_EXT.test(filename)
  const hidden = spoiler && !revealed

  const getUrl = async () => {
    const cached = cachedUrl(id)
    if (cached) return cached
    const blob = localFile
      ? base64ToBlob(localFile.data, localFile.mime)
      : await (() => {
          if (peerId === null) throw new Error('File not available')
          return p2p.download(peerId, id)
        })()
    const u = URL.createObjectURL(blob)
    keepUrl(id, u)
    return u
  }

  useEffect(() => {
    if (!isImage || !previews || url !== null || !online || busy || failed || hidden) return
    setBusy(true)
    getUrl()
      .then(setUrl)
      .catch((e: unknown) => {
        setFailed(true)
        console.error('p2p fetch', e)
      })
      .finally(() => setBusy(false))
  }, [isImage, previews, url, online, busy, failed, hidden])

  useEffect(() => {
    setFailed(false)
  }, [avail])

  const save = () => {
    setBusy(true)
    getUrl()
      .then(u => {
        const a = document.createElement('a')
        a.href = u
        a.download = filename
        a.click()
      })
      .catch((e: unknown) => p2p.onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const meta = (
    <span className="mt-1.5 flex items-center gap-2 text-xs text-on-surface-variant">
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

  if (!online && url === null) {
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

  if (isImage && previews && url !== null) {
    return (
      <div className="mt-1 w-fit">
        <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
          <img src={url} alt={filename} className="max-h-80 max-w-full rounded-xl" />
        </a>
        {meta}
      </div>
    )
  }

  return (
    <div className="mt-1 w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
      <div className="flex items-center gap-2">
        <FileText size={18} className="shrink-0 text-tertiary" />
        <span className="max-w-60 truncate text-sm">{filename}</span>
        <button
          title={`Download from ${hosterName}'s browser`}
          onClick={save}
          disabled={busy}
          className="shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary disabled:opacity-40"
        >
          <Download size={14} />
        </button>
      </div>
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
  const url = mediaUrl(id, server)
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
  const { ord, url, site_name, title, description, image_url, banner_removed } = embed

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
}: {
  message: Message
  canDelete?: boolean
}) {
  const deleteMedia = useStore(s => s.deleteMedia)
  const previews = useStore(s => s.settings.asset_previews)
  const username = useStore(s => s.me?.username ?? '')
  const plugins = useMemo(
    () => [remarkGfm, remarkSpoiler, ...(username ? [remarkMention(username)] : [])],
    [username]
  )
  const { content, media, embeds } = message
  const invites = useMemo(() => findInvites(content, window.location.origin), [content])
  const links = useMemo(
    () => embeds.filter(e => parseInvite(e.url, window.location.origin) === null),
    [embeds]
  )
  return (
    <div className="min-w-0 text-sm leading-relaxed break-words">
      {content.trim() !== '' && (
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {content}
        </ReactMarkdown>
      )}
      {media !== null && (
        <div className="group/att relative w-fit">
          {media.kind === 'p2p' && !media.removed ? (
            <P2pFile media={media} />
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
        links.map(e => <EmbedCard key={e.ord} embed={e} message={message} canDelete={canDelete} />)}
    </div>
  )
})
