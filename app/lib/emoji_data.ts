import data from 'emojibase-data/en/data.json'
import github from 'emojibase-data/en/shortcodes/github.json'
import emojibase from 'emojibase-data/en/shortcodes/emojibase.json'
import { fromEmojibase, type RawEmoji, type ShortcodeMap } from './emoji'

const SENTINELS: [number, string][] = [
  [18, '\u{1FAEB}'],
  [17, '\u{1FAEA}'],
  [16, '\u{1FAE9}'],
  [15.1, '\u{1F642}‍↔️'],
  [15, '\u{1FAE8}'],
  [14, '\u{1FAE0}'],
  [13.1, '\u{1F636}‍\u{1F32B}️'],
  [13, '\u{1F972}'],
  [12.1, '\u{1F9D1}‍\u{1F9B0}'],
  [12, '\u{1F971}'],
]

const FLOOR = 11
const SIZE = 24

function supportedVersion(): number {
  if (typeof document === 'undefined') return Infinity
  const canvas = document.createElement('canvas')
  canvas.width = SIZE * 3
  canvas.height = SIZE * 1.5
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return Infinity
  ctx.font = `${SIZE}px ${getComputedStyle(document.body).fontFamily}, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#000'
  const ref = ctx.measureText('\u{1F600}').width
  const renders = (e: string) => {
    if (ctx.measureText(e).width > ref * 1.4) return false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillText(e, 0, 0)
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 0 && (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24)) return true
    }
    return false
  }
  try {
    for (const [version, e] of SENTINELS) if (renders(e)) return version
  } catch {
    return Infinity
  }
  return FLOOR
}

export const buildEmoji = () =>
  fromEmojibase(
    data as unknown as RawEmoji[],
    [github as ShortcodeMap, emojibase as ShortcodeMap],
    supportedVersion()
  )
