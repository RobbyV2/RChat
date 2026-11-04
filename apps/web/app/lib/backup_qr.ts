import { encode } from 'uqr'
import { qrPayload } from './backup_phrase'

export interface PhraseQrMatrix {
  size: number
  dark: boolean[][]
  hole: { x: number; y: number; side: number }
}

export interface SheetInput {
  words: string[]
  kind: 'account' | 'p2p'
  account: string
  host: string
  date: string
  svg: string
}

const BORDER = 4
const HOLE_SHARE = 0.38
export const LOGO_ASPECT = 880 / 236
export const KEY_PATH =
  'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z'
export const KEY_DOT = { cx: 16.5, cy: 7.5, r: 1.25 }

// Error correction H, with the middle cleared for the logo and key: about 14% of the symbol.
export const qrMatrix = (words: string[]): PhraseQrMatrix => {
  const qr = encode(qrPayload(words), { ecc: 'H', border: BORDER })
  const inner = qr.size - 2 * BORDER
  let side = Math.floor(inner * HOLE_SHARE)
  if ((qr.size - side) % 2) side -= 1
  const at = (qr.size - side) / 2
  const inHole = (v: number) => v >= at && v < at + side
  const dark = qr.data.map((row, y) => row.map((d, x) => d && !(inHole(x) && inHole(y))))
  return { size: qr.size, dark, hole: { x: at, y: at, side } }
}

// Where the logo and the key sit inside the hole, in modules.
export const artLayout = ({ x, y, side }: PhraseQrMatrix['hole']) => {
  const pad = side * 0.08
  const logoW = side - 2 * pad
  const logoH = logoW / LOGO_ASPECT
  const gap = side * 0.06
  const key = side * 0.5
  const top = y + (side - logoH - gap - key) / 2
  return {
    logo: { x: x + pad, y: top, w: logoW, h: logoH },
    key: { x: x + (side - key) / 2, y: top + logoH + gap, size: key },
  }
}

const num = (v: number) => String(Math.round(v * 1000) / 1000)

export const qrSvg = (words: string[], logoDataUri: string) => {
  const m = qrMatrix(words)
  let d = ''
  m.dark.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`
    })
  )
  const { logo, key } = artLayout(m.hole)
  const image = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logoDataUri)
    ? `<image x="${num(logo.x)}" y="${num(logo.y)}" width="${num(logo.w)}" height="${num(logo.h)}" preserveAspectRatio="xMidYMid meet" href="${logoDataUri}"/>`
    : ''
  const glyph =
    `<g transform="translate(${num(key.x)} ${num(key.y)}) scale(${num(key.size / 24)})" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${KEY_PATH}"/><circle cx="${KEY_DOT.cx}" cy="${KEY_DOT.cy}" r="${KEY_DOT.r}" fill="#000" stroke="none"/></g>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.size} ${m.size}" width="${m.size * 8}" height="${m.size * 8}">` +
    `<rect width="${m.size}" height="${m.size}" fill="#fff"/>` +
    `<path d="${d}" fill="#000" shape-rendering="crispEdges"/>` +
    image +
    glyph +
    '</svg>'
  )
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const esc = (t: string) => t.replace(/[&<>"']/g, c => ESCAPES[c])

const SHEET_CSS = `@page{margin:16mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:8mm 0}
main{max-width:170mm;margin:0 auto}
h1{font-size:22px;margin:0 0 2mm}
.meta{margin:0 0 6mm;color:#333}
.meta span{margin-right:6mm}
.top{display:flex;gap:8mm;align-items:flex-start}
.qr{flex:none;width:62mm;height:62mm}
.qr svg{display:block;width:100%;height:100%}
ol{list-style:none;margin:0;padding:0;flex:1;display:grid;grid-template-columns:repeat(2,1fr);gap:2mm 6mm;font:16px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
li{border-bottom:1px solid #bbb;padding:1mm 0}
.how{margin:8mm 0 0;padding:4mm 5mm;border:1px solid #000;border-radius:3mm}
.how p{margin:0}
.how p+p{margin-top:2mm}`

const sheetLines = ({ kind, account, host }: SheetInput) =>
  kind === 'account'
    ? [
        `This phrase recovers the account ${account} on ${host}. On the sign-in page, choose to use your backup phrase, then type these words or scan the code.`,
        'Keep it offline and private. Anyone who has it can take over the account.',
      ]
    : [
        'This is a P2P-only phrase. It recovers your P2P identity on a new device: type these words or scan the code.',
        'Keep it offline and private. Anyone who has it can take over the identity.',
      ]

const sheetMeta = ({ kind, account, host, date }: SheetInput) =>
  (kind === 'account'
    ? [
        ['Account', account],
        ['Instance', host],
        ['Made', date],
      ]
    : [
        ['Identity', account],
        ['Made', date],
      ]
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`)
    .join('')

// The whole sheet in one document: made on the device and never sent anywhere.
export const sheetHtml = (s: SheetInput) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  `<title>Backup phrase</title><style>${SHEET_CSS}</style></head><body><main>` +
  `<h1>${s.kind === 'p2p' ? 'P2P backup phrase' : 'Backup phrase'}</h1>` +
  `<p class="meta">${sheetMeta(s)}</p>` +
  `<div class="top"><div class="qr">${s.svg}</div><ol>` +
  s.words.map((w, i) => `<li>${i + 1}. ${esc(w)}</li>`).join('') +
  '</ol></div><div class="how">' +
  sheetLines(s)
    .map(l => `<p>${esc(l)}</p>`)
    .join('') +
  '</div></main></body></html>'

// What the third export control does: print, save the sheet where the platform can't print, or
// nothing yet while the platform is unknown (the first paint).
export const sheetAction = (canPrint: boolean | null) =>
  canPrint === null ? null : canPrint ? ('print' as const) : ('save' as const)
