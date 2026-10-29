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
import { previewPath, saveGuestMedia, useMediaSrc, usePreviewSrc } from '../lib/media_src'
import { expiryText, sameOriginImage } from '../lib/rules'
import { remarkMask } from '../lib/profanity'
import { CLOSE, OPEN, markSpoilers, spoilerParts, unmarkSpoilers } from '../lib/spoilers'
import {
  groupPills,
  knownMentions,
  useMask,
  userRefFor,
  useStore,
  type ContextMenuItem,
} from '../lib/store'
import type { Embed, Message, MessageMedia } from '../lib/types'
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
import { Masked } from './ui'

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: unknown
}

type SpoilerToken = MdNode | 'open' | 'close'

const MARKS = new RegExp(`(${[OPEN, CLOSE].map(m => m.replace(/[|<]/g, '\\$&')).join('|')})`)

// Pairs the markers `markSpoilers` left in the text (see `lib/spoilers.ts`) among siblings.
// A marker whose partner ended up in another node (markdown nesting split them) stays `||`, as
// does every marker in code. Returns whether `node` kept an unpaired marker.
const splitSpoilers = (node: MdNode): boolean => {
  const { children } = node
  if (!children) return false
  const barrier = new Set(children.filter(splitSpoilers))
  const tokens: SpoilerToken[] = []
  for (const child of children) {
    if (child.type !== 'text' || child.value === undefined || !MARKS.test(child.value)) {
      tokens.push(child)
      continue
    }
    for (const piece of child.value.split(MARKS)) {
      if (piece === OPEN) tokens.push('open')
      else if (piece === CLOSE) tokens.push('close')
      else if (piece) tokens.push({ type: 'text', value: piece })
    }
  }
  let left = barrier.size > 0
  const out: MdNode[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (typeof tok !== 'string') {
      out.push(tok)
      continue
    }
    let close = -1
    if (tok === 'open')
      for (let j = i + 1; j < tokens.length; j += 1) {
        const t = tokens[j]
        if (t === 'close') close = j
        if (typeof t === 'string' || barrier.has(t)) break
      }
    if (close === -1) {
      left = true
      out.push({ type: 'text', value: '||' })
      continue
    }
    out.push({
      type: 'emphasis',
      data: { hName: 'span', hProperties: { 'data-spoiler': '' } },
      children: tokens.slice(i + 1, close) as MdNode[],
    })
    i = close
  }
  node.children = out.reduce<MdNode[]>((acc, n) => {
    const last = acc[acc.length - 1]
    if (n.type === 'text' && last?.type === 'text' && !last.data && !n.data)
      acc[acc.length - 1] = { ...last, value: `${last.value ?? ''}${n.value ?? ''}` }
    else acc.push(n)
    return acc
  }, [])
  return left
}

// Markers left anywhere else (code, link targets, alt text) read as typed.
const unmarkTree = (node: MdNode & { url?: string; alt?: string; title?: string }) => {
  if (node.value !== undefined) node.value = unmarkSpoilers(node.value)
  if (typeof node.url === 'string') node.url = unmarkSpoilers(node.url)
  if (typeof node.alt === 'string') node.alt = unmarkSpoilers(node.alt)
  if (typeof node.title === 'string') node.title = unmarkSpoilers(node.title)
  node.children?.forEach(unmarkTree)
}

const remarkSpoiler = () => (tree: unknown) => {
  splitSpoilers(tree as MdNode)
  unmarkTree(tree as MdNode)
}

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

// A `||spoiler||`: a dark pill until clicked (or Enter / Space). Each one reveals on its own, for
// this view only. "Show spoilers: Always" starts them open, except in streamer mode.
const useSpoilersOpen = () => useStore(s => s.showSpoilers === 'always' && !s.streamer)

function SpoilerText({ children }: { children?: ReactNode }) {
  const always = useSpoilersOpen()
  const [revealed, setRevealed] = useState(false)
  const shown = useRef<HTMLSpanElement>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (revealed && focused.current) shown.current?.focus()
  }, [revealed])
  if (revealed || always)
    return (
      <span
        ref={shown}
        tabIndex={revealed ? -1 : undefined}
        data-spoiler="shown"
        className="rounded bg-on-surface/10 px-0.5 focus-visible:outline-2 focus-visible:outline-primary"
      >
        {children}
      </span>
    )
  const reveal = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    focused.current = document.activeElement === e.currentTarget
    setRevealed(true)
  }
  return (
    <span
      data-spoiler="hidden"
      role="button"
      tabIndex={0}
      aria-label="Spoiler, press to reveal"
      title="Spoiler"
      onClick={reveal}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') reveal(e)
      }}
      className="cursor-pointer rounded bg-spoiler px-0.5 select-none hover:bg-spoiler/85 focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span className="invisible" aria-hidden>
        {children}
      </span>
    </span>
  )
}

function Mention({ username }: { username: string }) {
  const user = useStore(s => userRefFor(s, username))
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const mine = useStore(s => s.me?.username === username)
  const mask = useMask()
  return (
    <span
      {...profileTrigger(user, server)}
      data-mention={username}
      className={`streamer cursor-pointer rounded px-0.5 font-medium hover:underline ${
        mine ? 'bg-primary-container text-on-primary-container' : 'bg-primary/15 text-primary'
      }`}
    >
      @{mask(user.display_name)}
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
  const role = useStore(s => {
    if (group[0] !== 'r') return null
    const id = Number(group.slice(1))
    for (const detail of Object.values(s.servers)) {
      const r = detail.roles.find(x => x.id === id)
      if (r) return r
    }
    return null
  })
  const mask = useMask()
  if (role)
    return (
      <span
        data-group={group}
        style={{ color: role.color, backgroundColor: `${role.color}26` }}
        className="rounded px-0.5 font-medium"
      >
        @{mask(role.name)}
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
  const body = <InLink.Provider value>{children}</InLink.Provider>
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
    'data-spoiler' in props ? (
      <SpoilerText>{props.children}</SpoilerText>
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
function SpoilerCover({ title, onReveal }: { title?: string; onReveal: () => void }) {
  return (
    <button
      title={title}
      aria-label="Spoiler attachment, press to reveal"
      onClick={onReveal}
      className="mt-1 flex w-fit cursor-pointer items-center gap-2 rounded-xl border border-outline-variant bg-surface-container px-3 py-2 hover:bg-surface-container-high"
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
        <Masked text={hosterName} />
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
            <Masked text={filename} />
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
            <Masked text={filename} />
          </span>
        </span>
        <p className="mt-1 text-xs text-on-surface-variant italic">
          File not available. Ask{' '}
          {hoster === null ? (
            'the sender'
          ) : (
            <span className="streamer">
              <Masked text={hosterName} />
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
          <Masked text={filename} />
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

function MediaAttachment({ media }: { media: MessageMedia }) {
  const previews = useStore(s => s.settings.asset_previews)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const [revealed, setRevealed] = useState(false)
  const always = useSpoilersOpen()
  const { id, filename, removed, removed_by_author, spoiler, expires_at } = media
  const image = previews && IMAGE_EXT.test(filename)
  const src = useMediaSrc(id, server, image && !removed)
  const guest = api.guestMedia(server)
  const lang = previews && !image ? fileLang(filename) : null
  const text = useServerText(
    id,
    server,
    lang !== null && !removed && !(spoiler && !revealed && !always)
  )
  if (removed) {
    return (
      <p className="mt-1 text-xs text-on-surface-variant italic">
        {removed_by_author
          ? 'Attachment removed'
          : `File ${filename} was removed after 1 day of posting`}
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
          className="relative mt-1 block w-fit cursor-pointer overflow-hidden rounded-xl"
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
    void saveGuestMedia(id, server ?? '', filename).catch((err: unknown) =>
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
          guest && server !== undefined ? (
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
          <Masked text={filename} />
        </span>
        <Download size={14} className="shrink-0 text-on-surface-variant" />
      </span>
      {expiry}
    </>
  )
  const box =
    'mt-1 block w-fit rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-left hover:bg-surface-container-high'
  if (guest && server !== undefined) {
    return (
      <button title={`Download ${filename}`} onClick={save} className={`cursor-pointer ${box}`}>
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
  const deleteEmbed = useStore(s => s.deleteEmbed)
  const openContextMenu = useStore(s => s.openContextMenu)
  const { ord, site_name, title, description, image_url, banner_removed } = embed
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : undefined))
  const path = banner_removed ? null : previewPath(message.id, ord, image_url)
  const src = usePreviewSrc(path, server)
  const [broken, setBroken] = useState<string | null>(null)
  const mask = useMask()
  const url = useMemo(() => postedUrl(message.content, embed.url), [message.content, embed.url])

  const menu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      {
        label: 'Remove embed',
        danger: true,
        action: () => void deleteEmbed(message.id, ord, false),
      },
    ]
    if (path !== null) {
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
      {site_name !== null && (
        <div className="text-xs text-on-surface-variant">{mask(site_name)}</div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block text-sm font-medium break-words text-primary hover:underline"
      >
        {title === null ? url : mask(title)}
      </a>
      {description !== null && (
        <p className="mt-0.5 line-clamp-3 text-xs break-words text-on-surface-variant">
          {mask(description)}
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
      className={`${box} cursor-pointer text-on-surface-variant hover:bg-surface-container-high`}
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
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {markSpoilers(text)}
        </ReactMarkdown>
      ),
      line: (text: string) =>
        spoilerParts(text).map((part, i) =>
          part.spoiler ? (
            <SpoilerText key={i}>{mask(part.text)}</SpoilerText>
          ) : (
            <Fragment key={i}>{mask(part.text)}</Fragment>
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
  const known = useStore(s => knownMentions(s, message, candidates))
  const pills = useStore(s => groupPills(s, message))
  const mask = useMask()
  const card = useCardText()
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
          <ReactMarkdown remarkPlugins={plugins} components={components}>
            {source}
          </ReactMarkdown>
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
      {message.webhook && message.webhook.embeds.length > 0 && (
        <RichEmbeds embeds={message.webhook.embeds} text={card.text} line={card.line} />
      )}
      {messageLinks.map(l => (
        <MessageLinkCard key={l.id} link={l} />
      ))}
      {invites.map(i => (
        <InviteCard key={i.server} variant="embed" server={i.server} password={i.password} />
      ))}
      {previews &&
        remotes.map(i => (
          <RemoteInviteCard key={remoteKey(i)} invite={i} onResolved={onResolved} />
        ))}
      {previews &&
        links.map(e => <EmbedCard key={e.ord} embed={e} message={message} canDelete={canDelete} />)}
      {previews && hidden.slice(0, 3).map(url => <SpoilerLinkCard key={url} url={url} />)}
    </div>
  )
})
