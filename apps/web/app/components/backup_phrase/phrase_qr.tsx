'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Download, FileDown, Printer } from 'lucide-react'
import {
  KEY_DOT,
  KEY_PATH,
  artLayout,
  qrMatrix,
  qrSvg,
  sheetAction,
  sheetHtml,
} from '../../lib/backup_qr'
import { shareOrigin } from '../../lib/instances'
import { sharing } from '../../lib/platform'
import { useStore } from '../../lib/store'
import { textBtn } from '../ui'

export const PNG_NAME = 'rchat-backup-phrase.png'
export const SVG_NAME = 'rchat-backup-phrase.svg'
export const SHEET_NAME = 'rchat-backup-phrase.html'
const LOGO_SRC = '/rchat_logo.png'
const LOGO_WIDTH = 352
const PNG_SCALE = 12

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>(resolve => {
    if (!src) return resolve(null)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })

let logoCache: Promise<string> | null = null

// The logo, scaled down once and inlined, so saved and printed files stand alone.
const logoDataUri = () =>
  (logoCache ??= loadImage(LOGO_SRC).then(img => {
    const canvas = img ? document.createElement('canvas') : null
    const ctx = canvas?.getContext('2d')
    if (!img || !canvas || !ctx) {
      logoCache = null
      return ''
    }
    canvas.width = LOGO_WIDTH
    canvas.height = Math.round((LOGO_WIDTH * img.naturalHeight) / img.naturalWidth)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }))

const useLogo = () => {
  const [logo, setLogo] = useState('')
  useEffect(() => {
    let live = true
    void logoDataUri().then(uri => {
      if (live) setLogo(uri)
    })
    return () => {
      live = false
    }
  }, [])
  return logo
}

const svgUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

const qrPng = async (words: string[], logo: string) => {
  const m = qrMatrix(words)
  const s = PNG_SCALE
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = m.size * s
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  m.dark.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) ctx.fillRect(x * s, y * s, s, s)
    })
  )
  const art = artLayout(m.hole)
  const img = await loadImage(logo)
  if (img) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, art.logo.x * s, art.logo.y * s, art.logo.w * s, art.logo.h * s)
  }
  ctx.save()
  ctx.translate(art.key.x * s, art.key.y * s)
  ctx.scale((art.key.size * s) / 24, (art.key.size * s) / 24)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000'
  ctx.stroke(new Path2D(KEY_PATH))
  ctx.beginPath()
  ctx.arc(KEY_DOT.cx, KEY_DOT.cy, KEY_DOT.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
}

const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

// Black on white with a quiet zone in both themes. While hidden, nothing of the phrase is drawn.
export function PhraseQr({
  words,
  hidden,
  onShow,
}: {
  words: string[]
  hidden: boolean
  onShow?: () => void
}) {
  const logo = useLogo()
  const src = useMemo(() => (hidden ? null : svgUri(qrSvg(words, logo))), [hidden, words, logo])
  const box = 'aspect-square w-full max-w-64 rounded-xl'
  if (src)
    return (
      <img
        src={src}
        alt="QR code of the backup phrase"
        draggable={false}
        className={`${box} block bg-white`}
      />
    )
  const cover = `${box} flex items-center justify-center border border-dashed border-outline-variant p-4 text-center text-sm text-on-surface-variant`
  if (!onShow) return <div className={cover}>Hidden in streamer mode</div>
  return (
    <button
      type="button"
      onClick={onShow}
      className={`${cover} cursor-pointer hover:bg-surface-container-highest hover:text-on-surface`}
    >
      Hidden in streamer mode. Show QR code
    </button>
  )
}

const noSubscribe = () => () => {}

// Saving and printing work while the phrase is hidden: nothing of it is drawn on screen.
export function PhraseExport({
  words,
  kind,
  name,
}: {
  words: string[]
  kind: 'account' | 'p2p'
  name?: string
}) {
  const username = useStore(s => s.me?.username ?? '')
  const action = sheetAction(
    useSyncExternalStore<boolean | null>(
      noSubscribe,
      () => sharing().canPrint(),
      () => null
    )
  )
  const [note, setNote] = useState<string | null>(null)

  const savePng = async () => {
    setNote(null)
    const blob = await qrPng(words, await logoDataUri())
    if (!blob || !sharing().saveBlob(PNG_NAME, blob)) setNote("Couldn't save the image")
  }
  const saveSvg = async () => {
    setNote(null)
    const svg = qrSvg(words, await logoDataUri())
    if (!sharing().saveBlob(SVG_NAME, new Blob([svg], { type: 'image/svg+xml' })))
      setNote("Couldn't save the image")
  }
  const sheet = async () =>
    sheetHtml({
      words,
      kind,
      account: name ?? (kind === 'account' ? username : ''),
      host: kind === 'account' ? hostOf(shareOrigin()) : '',
      date: today(),
      svg: qrSvg(words, await logoDataUri()),
    })
  const print = async () => {
    setNote(null)
    if (!(await sharing().print(await sheet()))) setNote("Couldn't open printing")
  }
  // Where this app can't print, the sheet is saved to print from a browser.
  const saveSheet = async () => {
    setNote(null)
    const blob = new Blob([await sheet()], { type: 'text/html' })
    if (!sharing().saveBlob(SHEET_NAME, blob)) setNote("Couldn't save the sheet")
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => void savePng()}
          className={`${textBtn} flex items-center gap-1.5`}
        >
          <Download size={16} />
          Save PNG
        </button>
        <button
          type="button"
          onClick={() => void saveSvg()}
          className={`${textBtn} flex items-center gap-1.5`}
        >
          <Download size={16} />
          Save SVG
        </button>
        <span className="grid">
          <span
            aria-hidden="true"
            className={`${textBtn} invisible col-start-1 row-start-1 flex items-center gap-1.5`}
          >
            <FileDown size={16} />
            Save sheet
          </span>
          {action === 'print' && (
            <button
              type="button"
              onClick={() => void print()}
              className={`${textBtn} col-start-1 row-start-1 flex items-center gap-1.5 justify-self-start`}
            >
              <Printer size={16} />
              Print
            </button>
          )}
          {action === 'save' && (
            <button
              type="button"
              onClick={() => void saveSheet()}
              className={`${textBtn} col-start-1 row-start-1 flex items-center gap-1.5 justify-self-start`}
            >
              <FileDown size={16} />
              Save sheet
            </button>
          )}
        </span>
      </div>
      {note && (
        <p role="alert" className="text-xs text-error">
          {note}
        </p>
      )}
    </div>
  )
}
