'use client'

import { IconButton } from './controls'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, FileCode, ShieldAlert } from 'lucide-react'
import { useAccount, useStoreApi } from '../lib/client/react'
import { fmtSize } from '../lib/bytes'
import {
  decodeText,
  fenceLang,
  highlightSplit,
  LANGS,
  lineCount,
  PREVIEW_TEXT_MAX,
  type Lang,
  type TextFile,
} from '../lib/code'
import { useHighlight, type CodeNode } from '../lib/highlight'
import { sharing } from '../lib/platform'
import { useChat } from '../lib/place/use_chat'
import { Surface } from './layout'

const CLASS = /^[a-z][\w-]*$/i

const toReact = (n: CodeNode, key: number): ReactNode => {
  if (n.type === 'text') return n.value ?? ''
  const kids = (n.children ?? []).map(toReact)
  if (n.type !== 'element') return <Fragment key={key}>{kids}</Fragment>
  const cls = n.properties?.className
  const className = Array.isArray(cls)
    ? cls.filter((c): c is string => typeof c === 'string' && CLASS.test(c)).join(' ')
    : undefined
  return (
    <span key={key} className={className}>
      {kids}
    </span>
  )
}

function CopyButton({ text }: { text: string }) {
  const store = useStoreApi()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const label = copied ? 'Copied' : 'Copy code'
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={label}
      size="sm"
      onClick={() =>
        void sharing()
          .copyText(text)
          .then(ok =>
            ok ? setCopied(true) : store.getState().setError('Could not copy to the clipboard')
          )
      }
    />
  )
}

// A fenced code block: highlighted for a known tag, or guessed when long enough and untagged.
export function CodeBlock({ code, tag }: { code: string; tag: string | null }) {
  const named = tag !== null ? fenceLang(tag) : null
  const [head, tail] = highlightSplit(code)
  // P2P messages don't fetch the grammars; they are used once something else loaded them.
  const { fetches } = useChat()
  const hl = useHighlight(head, named, tag === null || named !== null, fetches)
  const label = hl ? LANGS[hl.lang] : named ? LANGS[named] : tag || 'Text'
  return (
    <div data-code-block="" className="my-1 max-w-full rounded-lg bg-surface-container-high">
      <div className="flex h-7 items-center justify-between gap-2 pr-1 pl-3 text-2xs text-on-surface-variant">
        <span className="truncate font-medium">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-hl overflow-x-auto px-3 pb-2 font-mono text-xs leading-5">
        <code>
          {hl ? toReact(hl.nodes, 0) : head}
          {tail}
        </code>
      </pre>
    </div>
  )
}

// What the text of a hast node reads, for the code inside a fenced block.
export const nodeText = (n: CodeNode | undefined): string =>
  !n ? '' : n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(nodeText).join('')

export type { TextFile } from '../lib/code'

export const blobText = async (blob: Blob): Promise<TextFile | null> => {
  const cut = blob.size > PREVIEW_TEXT_MAX
  const bytes = new Uint8Array(await blob.slice(0, PREVIEW_TEXT_MAX).arrayBuffer())
  const text = decodeText(bytes, cut)
  return text === null ? null : { text, cut }
}

// The start of an uploaded text file: undefined while it loads, null when it is not text or
// could not be loaded.
export const useServerText = (id: string, server: string | undefined, wanted: boolean) => {
  const account = useAccount()
  const { api, textPreviews } = account
  const mark = account.lifetime.sessionMark()
  const key = JSON.stringify([account.conn.origin, 'media', server, id])
  const [got, setGot] = useState<{ key: string; mark: object; file: TextFile | null } | null>(null)
  useEffect(() => {
    if (!wanted || textPreviews.get(key) !== undefined) return
    const stop = new AbortController()
    api
      .mediaStart(id, server, PREVIEW_TEXT_MAX, stop.signal)
      .then(({ bytes, cut, total }) => {
        const text = decodeText(bytes, cut)
        return text === null ? null : { text, cut, total }
      })
      .then(
        file => {
          if (stop.signal.aborted || mark !== account.lifetime.sessionMark()) return
          textPreviews.keep(key, file)
          setGot({ key, mark, file })
        },
        () => {
          if (!stop.signal.aborted && mark === account.lifetime.sessionMark())
            setGot({ key, mark, file: null })
        }
      )
    return () => stop.abort()
  }, [id, key, server, wanted, account, api, textPreviews, mark])
  const cached = textPreviews.get(key)
  if (cached !== undefined) return cached
  return got?.key === key && got.mark === mark ? got.file : undefined
}

export function CodePreviewLoading({ filename }: { filename: string }) {
  return (
    <div
      aria-label={`Loading ${filename}`}
      className="mt-1 h-40 w-2xl max-w-full motion-safe:animate-pulse rounded-xl bg-surface-container"
    />
  )
}

// An inline preview of a text file: about 20 lines, scrolling for the rest. Shown as text only,
// never rendered or run. `plain` skips highlighting (for files that could not be verified).
export function CodePreview({
  filename,
  size,
  lang,
  file,
  plain = false,
  note,
  actions,
  footer,
}: {
  filename: string
  size: number | null
  lang: Lang
  file: TextFile
  plain?: boolean
  note?: string
  actions?: ReactNode
  footer?: ReactNode
}) {
  const { text, cut } = file
  const [head, tail] = highlightSplit(text)
  const hl = useHighlight(head, lang, !plain && lang !== 'plaintext')
  const lines = lineCount(text)
  const bytes = size ?? file.total ?? (cut ? null : new Blob([text]).size)
  const gutter = Array.from({ length: lines }, (_, i) => i + 1).join('\n')
  return (
    <div
      data-code-preview=""
      className="mt-1 w-2xl max-w-full overflow-hidden rounded-xl border border-outline-variant bg-surface-container"
    >
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <FileCode size={18} className="shrink-0 text-primary" />
        <span className="min-w-0 truncate text-sm">{filename}</span>
        {bytes !== null && (
          <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
            {fmtSize(bytes)}
          </span>
        )}
        <span className="shrink-0 rounded bg-surface-container-highest px-1.5 py-0.5 text-2xs text-on-surface-variant">
          {LANGS[lang]}
        </span>
        <span className="ml-auto flex shrink-0 items-center">{actions}</span>
      </div>
      <div
        role="region"
        aria-label={`Preview of ${filename}`}
        tabIndex={0}
        className="code-hl flex max-h-100 overflow-auto border-t border-outline-variant bg-surface-container-high font-mono text-xs leading-5"
      >
        <pre
          aria-hidden
          className="sticky left-0 shrink-0 bg-surface-container-high py-2 pr-3 pl-3 text-right text-outline select-none"
        >
          {gutter}
        </pre>
        <pre className="min-w-0 flex-1 py-2 pr-3">
          <code>
            {hl ? toReact(hl.nodes, 0) : head}
            {tail}
          </code>
        </pre>
      </div>
      {(cut || note) && (
        <Surface tone="plain" radius="none" border="top" inset="bar" pad="md" gap="3xs">
          {cut && (
            <p className="text-xs text-on-surface-variant">
              Showing the first 1 MB. Download to view all.
            </p>
          )}
          {note && (
            <p className="flex items-center gap-1 text-xs text-error">
              <ShieldAlert size={12} className="shrink-0" />
              {note}
            </p>
          )}
        </Surface>
      )}
      {footer}
    </div>
  )
}
