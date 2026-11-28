'use client'
import { ask, asked, known } from '../lib/asks'
import { Refreshed, useAccountRequest } from './loaded'

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
import { Row, Surface, Inset } from './layout'
import { time } from '../lib/platform/time'

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
    const t = time().after(1500, () => setCopied(false))
    return () => t()
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
    <div data-code-block="" className="msg-block max-w-full rounded-lg bg-surface-container-high">
      <Inset
        row
        pad="md"
        inset="sides"
        gap="sm"
        justify="between"
        text="2xs"
        ink="muted"
        look="h-7"
      >
        <span className="truncate font-medium">{label}</span>
        <CopyButton text={code} />
      </Inset>
      <pre className="code-hl code-body overflow-x-auto font-mono text-xs leading-5">
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

// The start of an uploaded text file for `children`: undefined while it loads, null when it is
// not text or did not come. `notice` says why it did not come, with a way to ask again.
export function ServerText({
  id,
  server,
  children,
}: {
  id: string
  server: string | undefined
  children: (file: TextFile | null | undefined, notice: ReactNode) => ReactNode
}) {
  const account = useAccount()
  const { textPreviews } = account
  const key = JSON.stringify([account.conn.origin, 'media', server, id])
  const load = useAccountRequest<TextFile | null | undefined>(
    signal => {
      const kept = textPreviews.get(key)
      if (kept !== undefined) return known(kept)
      const mark = account.lifetime.sessionMark()
      return asked(
        ask.mediaStart(id, server, PREVIEW_TEXT_MAX, signal),
        ({ bytes, cut, total }) => {
          const text = decodeText(bytes, cut)
          const file = text === null ? null : { text, cut, total }
          if (mark === account.lifetime.sessionMark()) textPreviews.keep(key, file)
          return file
        }
      )
    },
    [id, server, key, textPreviews]
  )
  return (
    <Refreshed load={load} known={textPreviews.get(key)} what="the preview">
      {(file, notice) => children(load.status === 'failed' ? null : file, notice)}
    </Refreshed>
  )
}

export function CodePreviewLoading({ filename }: { filename: string }) {
  return (
    <div
      aria-label={`Loading ${filename}`}
      className="msg-part h-40 w-2xl max-w-full motion-safe:animate-pulse rounded-xl bg-surface-container"
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
      className="msg-part w-2xl max-w-full overflow-hidden rounded-xl border border-outline-variant bg-surface-container"
    >
      <Inset row pad="md" inset="chip" gap="sm">
        <FileCode size={18} className="shrink-0 text-primary" />
        <span className="min-w-0 truncate text-sm">{filename}</span>
        {bytes !== null && (
          <span className="shrink-0 text-xs text-on-surface-variant tabular-nums">
            {fmtSize(bytes)}
          </span>
        )}
        <Surface
          as="span"
          pad="xs"
          inset="chip"
          tone="highest"
          radius="none"
          text="2xs"
          ink="muted"
          look="rounded"
          place="shrink-0"
        >
          {LANGS[lang]}
        </Surface>
        <span className="ml-auto flex shrink-0 items-center">{actions}</span>
      </Inset>
      <div
        role="region"
        aria-label={`Preview of ${filename}`}
        tabIndex={0}
        className="code-hl flex max-h-100 overflow-auto border-t border-outline-variant bg-surface-container-high font-mono text-xs leading-5"
      >
        <pre
          aria-hidden
          className="code-gutter sticky left-0 shrink-0 bg-surface-container-high text-right text-outline select-none"
        >
          {gutter}
        </pre>
        <pre className="code-lines min-w-0 flex-1">
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
            <Row as="p" gap="2xs" text="xs" ink="error">
              <ShieldAlert size={12} className="shrink-0" />
              {note}
            </Row>
          )}
        </Surface>
      )}
      {footer}
    </div>
  )
}
