'use client'

import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Download,
  File,
  FileArchive,
  FileCode,
  FileHeadphone,
  FileImage,
  FilePlay,
  FileSpreadsheet,
  FileText,
  FileType,
  Presentation,
  X,
  type LucideIcon,
} from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { fmtSize } from '../lib/bytes'
import { useAccount } from '../lib/client/react'
import {
  EXTRAS,
  cardMenu,
  expiryLabel,
  expiryTitle,
  fileTarget,
  pct,
  primaryText,
  splitShown,
  type FileExtra,
  type FileKind,
  type FileMenu,
  type FileMenuOwn,
} from '../lib/file_card'
import { useMask } from '../lib/store'
import { longPress } from './context_menu'
import { RowSelecting } from './selection'
import { useLiveNow } from './timestamp'
import { MaskedText, MaskedTogether } from './ui'
import { Row, Surface } from './layout'
import { time } from '../lib/platform/time'

const ICONS: Record<FileKind, LucideIcon> = {
  archive: FileArchive,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
  audio: FileHeadphone,
  video: FilePlay,
  code: FileCode,
  text: FileType,
  image: FileImage,
  generic: File,
}

// The square button: a link (`href`) or a button. `hint`: words after the name in its title.
export interface FilePrimary {
  label: 'Download' | 'Save'
  onClick?: () => void
  href?: string
  download?: string
  disabled?: boolean
  hint?: string
}

interface CardProps {
  // The name as sent; `own` and `fileMask` pick how the viewer's filter shows it.
  name: string
  kind: FileKind
  size: number | null
  // After the size, such as a duration.
  detail?: string
  progress: { got: number; total: number } | null
  primary: FilePrimary
  // Turns the button into Cancel while a download runs.
  onCancel?: () => void
  // Buttons before the primary one, hidden while a download runs; the menu has them too.
  extra?: FileExtra[]
  // Above the row, such as a thumbnail.
  preview?: ReactNode
  // The P2P look.
  dashed?: boolean
  dim?: boolean
  data?: Record<`data-${string}`, string>
  // Inside the card, under the row.
  children?: ReactNode
  // Under the card.
  footer?: ReactNode
}

export interface FileCardProps extends CardProps {
  own: boolean
  fileMask: boolean
  // What the menu may do besides the card's buttons: start a download (null while none may),
  // copy the instance's address of a file it hosts, and remove the attachment.
  menu: FileMenuOwn
}

const square =
  'flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-coarse:size-12'
const primaryCls = `${square} bg-primary text-on-primary disabled:opacity-40`
const extraCls =
  'shrink-0 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-primary'
const cardBox = 'mt-1 w-md max-w-full min-w-0'

// A file in a message, hosted or P2P: its kind, name, size and a download button, with a menu
// on right-click and long-press that acts on the card as it is when a row runs. In a row in
// selection mode those open the row's menu instead.
export function FileCard({ own, fileMask, menu, ...card }: FileCardProps) {
  const shown = useMask(own, fileMask)(card.name)
  const open = useFileMenu(cardMenu(shown, { ...card, menu }))
  return <FileCardBody {...card} shown={shown} open={open} />
}

// Opens the menu of a card or video that is `current` now, its rows reading it as it is when
// they run; null in a row in selection mode, whose menu takes right-click and long-press.
export function useFileMenu(current: FileMenu): ((x: number, y: number) => void) | null {
  const acct = useAccount()
  const selecting = useContext(RowSelecting)
  const live = useRef<FileMenu | null>(current)
  useEffect(() => {
    live.current = current
    return () => {
      live.current = null
    }
  })
  const [target] = useState(() => fileTarget(() => live.current))
  return selecting ? null : (x, y) => openActionMenu(x, y, target, undefined, acct)
}

// The card for `shown`, the name as the filter shows it (as long as `name`). `open`: its menu,
// none when right-click and long-press belong to the row.
export function FileCardBody({
  name,
  shown,
  kind,
  size,
  detail,
  progress,
  primary,
  onCancel,
  extra,
  preview,
  dashed = false,
  dim = false,
  data,
  open,
  children,
  footer,
}: CardProps & { shown: string; open: ((x: number, y: number) => void) | null }) {
  const [base, shownBase, ext, shownExt] = splitShown(name, shown)
  const Icon = ICONS[kind]
  const percent = progress ? pct(progress) : null
  const sizeLine = [size !== null ? fmtSize(size) : '', detail ?? ''].join('')
  const { label, title } = primaryText(primary.label, shown, primary.hint)
  const button =
    progress && onCancel ? (
      <button
        title="Cancel download"
        aria-label="Cancel download"
        onClick={onCancel}
        className={`${square} bg-surface-container-highest text-on-surface hover:bg-surface-container-high`}
      >
        <X size={20} />
      </button>
    ) : primary.href !== undefined ? (
      <a
        href={primary.href}
        download={primary.download}
        title={title}
        aria-label={label}
        className={`${primaryCls} hover:bg-primary/90`}
      >
        <Download size={20} />
      </a>
    ) : (
      <button
        title={title}
        aria-label={label}
        onClick={primary.onClick}
        disabled={primary.disabled}
        className={`${primaryCls} enabled:hover:bg-primary/90`}
      >
        <Download size={20} />
      </button>
    )
  return (
    <div
      {...(open ? longPress(open) : {})}
      {...data}
      data-file-card=""
      className={dim ? `${cardBox} opacity-60` : cardBox}
    >
      <Surface
        pad="md"
        tone="base"
        look={`border ${dashed ? 'border-dashed border-tertiary/60' : 'border-outline-variant'}`}
        place="min-w-0"
      >
        {preview}
        <Row gap="md">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest text-on-surface-variant">
            <Icon size={24} aria-hidden />
          </span>
          <div className="min-w-0 flex-1" title={shown}>
            <MaskedTogether word={`file:${name}`}>
              <div className="flex min-w-0 text-sm leading-5">
                <span className="truncate font-semibold text-on-surface">
                  <MaskedText text={base} shown={shownBase} />
                </span>
                {ext && (
                  <span data-file-ext="" className="shrink-0 text-on-surface-variant">
                    <MaskedText text={ext} shown={shownExt} />
                  </span>
                )}
              </div>
            </MaskedTogether>
            {(percent !== null || sizeLine) && (
              <div className="text-xs text-on-surface-variant tabular-nums">
                {percent !== null ? `Downloading ${percent}%` : sizeLine}
              </div>
            )}
          </div>
          {!progress &&
            extra?.map(x => {
              const { label: extraLabel, icon: ExtraIcon } = EXTRAS[x.kind]
              return (
                <button
                  key={x.kind}
                  title={x.hint ? `${extraLabel} ${x.hint}` : extraLabel}
                  aria-label={extraLabel}
                  onClick={x.run}
                  className={extraCls}
                >
                  <ExtraIcon size={14} />
                </button>
              )
            })}
          {button}
        </Row>
        {percent !== null && (
          <div
            role="progressbar"
            aria-label={`Downloading ${shown}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="msg-part-loose h-1 w-full overflow-hidden rounded-full bg-surface-container-highest"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        )}
        {children}
      </Surface>
      {footer}
    </div>
  )
}

// When an uploaded file expires, under its card, kept current by the shared clock.
export function ExpiryLine({ at }: { at: number }) {
  useLiveNow(at * 1000)
  return (
    <p title={expiryTitle(at)} className="msg-part text-xs text-on-surface-variant">
      {expiryLabel(at, Math.floor(time().now() / 1000))}
    </p>
  )
}
