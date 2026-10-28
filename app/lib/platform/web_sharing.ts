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

const openFile = (accept: string, maxBytes: number) =>
  new Promise<string | null>(resolve => {
    if (typeof document === 'undefined') return resolve(null)
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file || file.size > maxBytes) return resolve(null)
      file.text().then(resolve, () => resolve(null))
    })
    input.click()
  })

export const webSharing: Sharing = { copyText, canShare, share, saveFile, saveBlob, openFile }
