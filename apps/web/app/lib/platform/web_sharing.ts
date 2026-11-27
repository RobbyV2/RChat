import type { ShareData, ShareResult, Sharing } from './sharing'

const nav = (): Navigator | null => (typeof navigator === 'undefined' ? null : navigator)

const copyText = async (text: string) => {
  try {
    await nav()?.clipboard?.writeText(text)
    return nav()?.clipboard !== undefined
  } catch {
    return false
  }
}

// An image drawn into a canvas, as PNG: what the clipboard takes for every image type. PNG bytes
// go as they are.
export const asPng = async (image: Blob | HTMLImageElement): Promise<Blob> => {
  if (image instanceof Blob && image.type === 'image/png') return image
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(png => (png ? resolve(png) : reject(new Error('no image'))), 'image/png')
  )
}

export const canCopyImage = () =>
  typeof ClipboardItem !== 'undefined' &&
  typeof createImageBitmap === 'function' &&
  typeof nav()?.clipboard?.write === 'function'

// The clipboard item is made at once and its bytes follow, so a browser that asks for a recent
// click sees the one that copied.
export const copyImage = async (image: Blob | HTMLImageElement | Promise<Blob>) => {
  if (!canCopyImage()) {
    if (image instanceof Promise) image.catch(() => {})
    return false
  }
  const png = Promise.resolve(image).then(asPng)
  png.catch(() => {})
  try {
    await nav()!.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    return false
  }
}

// An iPhone or iPad home screen app opens new windows in Safari, which can't read its `blob:`
// addresses.
const homeScreenIos = () => (nav() as { standalone?: unknown } | null)?.standalone === true

export const canOpenOriginal = (src: string) => !(src.startsWith('blob:') && homeScreenIos())

export const openOriginal = (src: string) => void window.open(src, '_blank', 'noopener,noreferrer')

const canShare = () => typeof nav()?.share === 'function'

const share = async (data: ShareData): Promise<ShareResult> => {
  const n = nav()
  if (!n || typeof n.share !== 'function') return 'failed'
  try {
    await n.share(data)
    return 'shared'
  } catch (e) {
    return e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

const saveFile = (name: string, text: string, mime: string) =>
  saveBlob(name, new Blob([text], { type: mime }))

// The anchor has `download`, so the browser saves the file instead of navigating to it.
const saveBlob = (name: string, blob: Blob) => {
  if (typeof document === 'undefined') return false
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

const openFile = (accept: string, maxBytes: number, tooLarge?: () => void) =>
  new Promise<string | null>(resolve => {
    if (typeof document === 'undefined') return resolve(null)
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      if (file.size > maxBytes) {
        tooLarge?.()
        return resolve(null)
      }
      file.text().then(resolve, () => resolve(null))
    })
    input.click()
  })

// A picked file as it is on disk: nothing is read until the caller streams it.
export const openBlob = (accept: string) =>
  new Promise<Blob | null>(resolve => {
    if (typeof document === 'undefined') return resolve(null)
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null))
    input.click()
  })

const canPrint = () => typeof window !== 'undefined' && typeof window.print === 'function'

const PRINT_FRAME_MS = 10 * 60_000

// Prints from a hidden frame that can't run scripts, so the page itself stays as it is. The frame
// goes once the dialog closes.
const print = (html: string) =>
  new Promise<boolean>(resolve => {
    if (typeof document === 'undefined' || !canPrint()) return resolve(false)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    const drop = () => frame.remove()
    frame.addEventListener(
      'load',
      () => {
        const win = frame.contentWindow
        if (!win) {
          drop()
          return resolve(false)
        }
        win.addEventListener('afterprint', drop, { once: true })
        setTimeout(drop, PRINT_FRAME_MS)
        try {
          win.focus()
          win.print()
          resolve(true)
        } catch {
          drop()
          resolve(false)
        }
      },
      { once: true }
    )
    frame.srcdoc = html
    document.body.appendChild(frame)
  })

export const webSharing: Sharing = {
  copyText,
  copyImage,
  canCopyImage,
  canOpenOriginal,
  openOriginal,
  canShare,
  share,
  saveFile,
  saveBlob,
  openFile,
  openBlob,
  canPrint,
  print,
}
