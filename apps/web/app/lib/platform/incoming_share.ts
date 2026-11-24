import type { SharedContent } from '../client/share_target'
import type { Invoke } from './desktop'

type NativeShare = {
  text: string
  files: { name: string; mime: string; data: string }[]
  error?: string | null
}

// One outstanding take at a time. Startup, foreground and a live native delivery can overlap.
export function watchIncomingShares(
  call: Invoke,
  receive: (content: SharedContent) => void,
  report: (message: string) => void,
  revision: () => number
) {
  let live = true,
    running = false,
    again = false
  async function take() {
    if (!live || document.hidden) return
    if (running) {
      again = true
      return
    }
    running = true
    const mark = revision()
    try {
      const payload = await call<NativeShare>('take_incoming_share')
      if (!live || revision() !== mark || !payload) return
      if (payload.error) {
        report(payload.error)
        return
      }
      if (!payload.text && !payload.files.length) return
      const files = payload.files.map(
        file =>
          new File(
            [Uint8Array.from(atob(file.data), c => c.charCodeAt(0))],
            file.name.split(/[/\\]/).pop() || 'Attachment',
            { type: file.mime }
          )
      )
      receive({ text: payload.text, files })
    } catch {
      if (live && revision() === mark) report('Could not open the shared content.')
    } finally {
      running = false
      if (again) {
        again = false
        void take()
      }
    }
  }
  const timer = setTimeout(take, 0)
  document.addEventListener('visibilitychange', take)
  window.addEventListener('focus', take)
  window.addEventListener('rchat-incoming-share', take)
  return () => {
    live = false
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', take)
    window.removeEventListener('focus', take)
    window.removeEventListener('rchat-incoming-share', take)
  }
}
