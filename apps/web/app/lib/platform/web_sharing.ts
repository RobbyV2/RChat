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

export const webSharing: Sharing = {
  copyText,
  canShare,
  share,
  saveFile,
  saveBlob,
  openFile,
  openBlob,
}
