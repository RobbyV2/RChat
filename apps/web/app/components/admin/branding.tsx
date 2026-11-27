'use client'
import { useAccount } from '../../lib/client/react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { AnnouncementEditor } from './announcements'
import { Lock, X } from 'lucide-react'
import {
  BRAND_LINKS_MAX,
  BRAND_SUGGESTIONS_MAX,
  brandRow,
  linksError,
  linksOf,
  suggestionsError,
  suggestionsOf,
  textError,
  type BrandRow,
} from '../../lib/admin_brand'
import { patchFor, sourceOf } from '../../lib/admin_config'
import { assetUrl } from '../../lib/brand'
import {
  MARK_SIZES,
  logoError,
  logoSize,
  markError,
  markRect,
  sizeError,
  type MarkSize,
} from '../../lib/brand_images'

import { errorText, useStore } from '../../lib/store'
import type { BrandAsset, BrandLink, InstanceSuggestion, SiteSettingsPatch } from '../../lib/types'
import { PageGroup, PageRow } from '../settings_page'
import { Button, IconButton, Pill } from '../controls'
import { Chips, FieldError, fieldCls } from '../ui'
import { useApplyConfig, useControl } from './config_state'

type TextRow = Extract<BrandRow, { kind: 'text' }>

// The image rows of the section, for its search.
export const BRAND_IMAGE_ROWS = [
  {
    id: 'brand_logo',
    label: 'Logo',
    line: 'The picture on the sign-in page and where the app shows its name.',
    keywords: ['image', 'picture'],
  },
  {
    id: 'brand_mark',
    label: 'Mark',
    line: 'The square icon in the tab and on home screens.',
    keywords: ['icon', 'favicon', 'image'],
  },
]

const labelCls = 'text-sm font-medium text-on-surface'
const lineCls = 'text-sm text-on-surface-variant'
const rowCls = 'flex flex-col gap-1.5 rounded-xl bg-surface-container px-3 py-3'

// Where a brand control's value comes from: pinned by the server config, the same as it, or
// different from it with a way to take the config's value.
function Source({ rowKey }: { rowKey: string }) {
  const control = useControl(rowKey)
  const apply = useApplyConfig()
  if (!control) return null
  switch (sourceOf(control)) {
    case 'none':
      return null
    case 'pinned':
      return (
        <p data-source="pinned" className="flex items-center gap-2 text-xs text-on-surface-variant">
          <Lock size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 break-words">
            Set in the server config (<code className="font-mono">{control.env}</code>)
          </span>
        </p>
      )
    case 'same':
      return (
        <p data-source="same" className="text-xs">
          <Pill tone="outline">From server config</Pill>
        </p>
      )
    case 'differs':
      return (
        <p
          data-source="differs"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant"
        >
          <span className="min-w-0">The server config has another value.</span>
          {patchFor(control.key, control.config ?? '') !== null && (
            <Button onClick={() => apply([control])} place="-my-1 shrink-0">
              Use it
            </Button>
          )}
        </p>
      )
  }
}

// One line or a few lines of text, saved on its own.
function TextControl({ row }: { row: TextRow }) {
  const control = useControl(row.key)
  const updateSettings = useStore(s => s.updateSettings)
  const stored = control?.value ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const text = draft ?? stored
  const pinned = control?.pinned ?? false
  const off = control === null || pinned
  const field = `${fieldCls} streamer disabled:opacity-50`
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const wrong = textError(row, text)
        setError(wrong)
        if (wrong !== null) return
        void updateSettings({ [row.key]: text } as SiteSettingsPatch).then(() => setDraft(null))
      }}
      className={rowCls}
    >
      <label htmlFor={id} className={labelCls}>
        {row.label}
      </label>
      <p className={lineCls}>{row.line}</p>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        {row.lines ? (
          <textarea
            id={id}
            rows={3}
            value={text}
            disabled={off}
            maxLength={row.max * 2}
            onChange={e => setDraft(e.target.value)}
            className={`${field} min-h-20 basis-full resize-y`}
          />
        ) : (
          <input
            id={id}
            value={text}
            disabled={off}
            maxLength={row.max * 2}
            onChange={e => setDraft(e.target.value)}
            className={`${field} basis-40`}
          />
        )}
        <Button
          type="submit"
          variant="filled"
          size="md"
          disabled={off || text === stored}
          place="shrink-0"
        >
          Save
        </Button>
      </div>
      <FieldError message={error} />
      {control === null && <p className={lineCls}>Loading</p>}
      <Source rowKey={row.key} />
    </form>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <IconButton icon={X} label={label} size="lg" data-icon-only onClick={onClick} />
}

// A list that is edited as a whole and saved with one button.
function ListFrame({
  rowKey,
  dirty,
  error,
  full,
  addLabel,
  onAdd,
  onSave,
  children,
}: {
  rowKey: string
  dirty: boolean
  error: string | null
  full: boolean
  addLabel: string
  onAdd: () => void
  onSave: () => void
  children: ReactNode
}) {
  const row = brandRow(rowKey)
  const control = useControl(rowKey)
  const off = control === null || control.pinned
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        onSave()
      }}
      className={rowCls}
    >
      <p className={labelCls}>{row?.label}</p>
      <p className={lineCls}>{row?.line}</p>
      <fieldset disabled={off} className="flex min-w-0 flex-col gap-2 disabled:opacity-50">
        {children}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button disabled={off || full} onClick={onAdd}>
          {addLabel}
        </Button>
        <Button type="submit" variant="filled" size="md" disabled={off || !dirty} place="shrink-0">
          Save
        </Button>
      </div>
      <FieldError message={error} />
      {control === null && <p className={lineCls}>Loading</p>}
      <Source rowKey={rowKey} />
    </form>
  )
}

const pairCls = 'flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-surface-container-high p-2'

function LinksControl() {
  const control = useControl('brand_links')
  const updateSettings = useStore(s => s.updateSettings)
  const stored = linksOf(control?.value)
  const [draft, setDraft] = useState<BrandLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = draft ?? stored
  const edit = (i: number, part: Partial<BrandLink>) =>
    setDraft(list.map((l, at) => (at === i ? { ...l, ...part } : l)))
  return (
    <ListFrame
      rowKey="brand_links"
      dirty={draft !== null}
      error={error}
      full={list.length >= BRAND_LINKS_MAX}
      addLabel="Add a link"
      onAdd={() => setDraft([...list, { label: '', url: 'https://' }])}
      onSave={() => {
        const wrong = linksError(list)
        setError(wrong)
        if (wrong !== null) return
        void updateSettings({ brand_links: list }).then(() => setDraft(null))
      }}
    >
      {list.length === 0 && <p className={lineCls}>No links.</p>}
      {list.map((link, i) => (
        <div key={i} className={pairCls}>
          <input
            value={link.label}
            onChange={e => edit(i, { label: e.target.value })}
            placeholder="Label"
            aria-label="Link label"
            className={`${fieldCls} basis-28`}
          />
          <input
            value={link.url}
            onChange={e => edit(i, { url: e.target.value })}
            placeholder="https://"
            aria-label="Link address"
            inputMode="url"
            className={`${fieldCls} basis-48`}
          />
          <RemoveButton
            label="Remove the link"
            onClick={() => setDraft(list.filter((_, at) => at !== i))}
          />
        </div>
      ))}
    </ListFrame>
  )
}

const MODES = [
  { value: 'add', label: "After the app's own list" },
  { value: 'replace', label: "Instead of the app's own list" },
] as const

function SuggestionsControl() {
  const control = useControl('instance_suggestions')
  const updateSettings = useStore(s => s.updateSettings)
  const stored = suggestionsOf(control?.value)
  const [draft, setDraft] = useState<ReturnType<typeof suggestionsOf> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = draft ?? stored
  const edit = (i: number, part: Partial<InstanceSuggestion>) =>
    setDraft({
      ...shown,
      list: shown.list.map((s, at) => (at === i ? { ...s, ...part } : s)),
    })
  return (
    <ListFrame
      rowKey="instance_suggestions"
      dirty={draft !== null}
      error={error}
      full={shown.list.length >= BRAND_SUGGESTIONS_MAX}
      addLabel="Add an instance"
      onAdd={() => setDraft({ ...shown, list: [...shown.list, { url: 'https://', label: '' }] })}
      onSave={() => {
        const wrong = suggestionsError(shown.list)
        setError(wrong)
        if (wrong !== null) return
        void updateSettings({ instance_suggestions: shown }).then(() => setDraft(null))
      }}
    >
      <Chips
        label="Where the suggestions show"
        value={shown.mode}
        options={MODES}
        onChange={mode => setDraft({ ...shown, mode })}
      />
      {shown.list.length === 0 && <p className={lineCls}>No instances.</p>}
      {shown.list.map((s, i) => (
        <div key={i} className={pairCls}>
          <input
            value={s.url}
            onChange={e => edit(i, { url: e.target.value })}
            placeholder="https://"
            aria-label="Instance address"
            inputMode="url"
            className={`${fieldCls} streamer basis-48`}
          />
          <input
            value={s.label}
            onChange={e => edit(i, { label: e.target.value })}
            placeholder="Label (optional)"
            aria-label="Instance label"
            className={`${fieldCls} streamer basis-28`}
          />
          <RemoveButton
            label="Remove the instance"
            onClick={() => setDraft({ ...shown, list: shown.list.filter((_, at) => at !== i) })}
          />
        </div>
      ))}
    </ListFrame>
  )
}

// The picked file as a picture the browser can draw, or null when it is none.
const readImage = (file: File) => createImageBitmap(file).catch(() => null)

// A canvas of `width` by `height` as a PNG.
const pngOf = (canvas: HTMLCanvasElement) =>
  new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))

const drawn = (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.imageSmoothingQuality = 'high'
  paint(ctx)
  return pngOf(canvas)
}

// The background of a maskable icon: the app's own dark surface.
const MASK_BACKGROUND = '#141218'

const markImage = (picture: ImageBitmap, size: MarkSize) =>
  drawn(size.size, size.size, ctx => {
    if (size.maskable) {
      ctx.fillStyle = MASK_BACKGROUND
      ctx.fillRect(0, 0, size.size, size.size)
    }
    const { x, y, side } = markRect(size)
    ctx.drawImage(picture, x, y, side, side)
  })

// One brand image: what is uploaded now, and the buttons that replace or remove it.
function ImageControl({
  id,
  label,
  line,
  preview,
  round,
  make,
  kinds,
}: {
  id: string
  label: string
  line: string
  // The kind whose upload is shown.
  preview: BrandAsset
  round: boolean
  // The images to upload for a picked file, or what is wrong with it.
  make: (picture: ImageBitmap) => Promise<{ kind: BrandAsset; image: Blob }[] | string>
  kinds: BrandAsset[]
}) {
  const ownerSession = useAccount()
  const path = useStore(s => s.brand?.assets[preview] ?? null)
  const setBrand = useStore(s => s.setBrand)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const run = (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    void work()
      .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e))))
      .finally(() => setBusy(false))
  }
  const upload = (file: File) =>
    run(async () => {
      const mark = ownerSession.lifetime.sessionMark()
      const picture = await readImage(file)
      if (mark !== ownerSession.lifetime.sessionMark()) {
        picture?.close()
        return
      }
      if (!picture) return setError("That file can't be read as an image.")
      const made = await make(picture)
      picture.close()
      if (mark !== ownerSession.lifetime.sessionMark()) return
      if (typeof made === 'string') return setError(made)
      let last: unknown = null
      for (const { kind, image } of made)
        last = await ownerSession.lifetime.live(ownerSession.api.adminPutBrandAsset(kind, image))
      setBrand(last)
    })
  const remove = () =>
    run(async () => {
      for (const kind of kinds)
        await ownerSession.lifetime.live(ownerSession.api.adminDeleteBrandAsset(kind))
      setBrand(await ownerSession.lifetime.live(ownerSession.api.brand()))
    })
  return (
    <PageRow id={id} className={rowCls}>
      <p className={labelCls}>{label}</p>
      <p className={lineCls}>{line}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div
          data-brand-preview={preview}
          className={`flex h-16 min-w-16 max-w-full shrink-0 items-center justify-center overflow-hidden bg-surface-container-highest px-2 ${
            round ? 'w-16 rounded-2xl px-0' : 'rounded-xl'
          }`}
        >
          {path === null ? (
            <span className="text-xs text-on-surface-variant">None</span>
          ) : (
            <img
              src={assetUrl(ownerSession.api.origin(), path)}
              alt={`${label} uploaded now`}
              className={round ? 'h-16 w-16 object-cover' : 'max-h-12 w-auto max-w-48'}
            />
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={`${label} file`}
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) upload(file)
          }}
        />
        <Button variant="filled" size="md" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Working' : path === null ? 'Upload' : 'Replace'}
        </Button>
        {path !== null && (
          <Button variant="danger" disabled={busy} onClick={remove}>
            Remove
          </Button>
        )}
      </div>
      <FieldError message={error} />
    </PageRow>
  )
}

const makeLogo = async (picture: ImageBitmap) => {
  const wrong = logoError(picture.width, picture.height)
  if (wrong !== null) return wrong
  const { width, height } = logoSize(picture.width, picture.height)
  const image = await drawn(width, height, ctx => ctx.drawImage(picture, 0, 0, width, height))
  if (!image) return "That file can't be read as an image."
  return sizeError(image.size) ?? [{ kind: 'logo' as const, image }]
}

const makeMark = async (picture: ImageBitmap) => {
  const wrong = markError(picture.width, picture.height)
  if (wrong !== null) return wrong
  const made: { kind: BrandAsset; image: Blob }[] = []
  for (const size of MARK_SIZES) {
    const image = await markImage(picture, size)
    if (!image) return "That file can't be read as an image."
    const big = sizeError(image.size)
    if (big !== null) return big
    made.push({ kind: size.kind, image })
  }
  return made
}

const text = (key: string): TextRow => {
  const row = brandRow(key)
  if (row?.kind !== 'text') throw new Error(`${key} is not a text`)
  return row
}

// The names, pictures and texts of the instance and of the app it serves.
export function BrandingSection() {
  return (
    <div>
      <PageGroup label="Names">
        {['instance_name', 'app_name', 'app_short_name'].map(key => (
          <PageRow key={key} id={key}>
            <TextControl row={text(key)} />
          </PageRow>
        ))}
      </PageGroup>
      <PageGroup label="Pictures">
        <ImageControl
          id="brand_logo"
          label="Logo"
          line="A picture up to 2048 by 1024 pixels. Larger ones are scaled down."
          preview="logo"
          round={false}
          make={makeLogo}
          kinds={['logo']}
        />
        <ImageControl
          id="brand_mark"
          label="Mark"
          line="A square picture of 512 pixels or more. It becomes the icon in the tab and on home screens."
          preview="mark-192"
          round
          make={makeMark}
          kinds={MARK_SIZES.map(m => m.kind)}
        />
        <p className="px-1 text-xs text-on-surface-variant">
          The page title and the installed app follow the brand when the server serves the app too.
        </p>
      </PageGroup>
      <PageGroup label="Texts">
        {['brand_about', 'login_note'].map(key => (
          <PageRow key={key} id={key}>
            <TextControl row={text(key)} />
          </PageRow>
        ))}
        <PageRow id="brand_links">
          <LinksControl />
        </PageRow>
      </PageGroup>
      <AnnouncementEditor />
      <PageGroup label="Other instances">
        <PageRow id="instance_suggestions">
          <SuggestionsControl />
        </PageRow>
      </PageGroup>
    </div>
  )
}
