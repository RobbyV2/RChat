import type { Invoke } from './desktop'
import { desktopSharing } from './desktop_sharing'
import type { ShareData, ShareResult, Sharing } from './sharing'

// One text for the share sheet: the message, then the link on its own line.
export const shareText = ({ text, url }: ShareData) =>
  [text, url].filter((part): part is string => !!part).join('\n')

// The mobile shell has the same clipboard and file commands as the desktop one, plus the system
// share sheet. The shell answers false when the user closed the sheet without sharing.
export const mobileSharing = (call: Invoke, report: (message: string) => void): Sharing => ({
  ...desktopSharing(call, report),
  canShare: () => true,
  share: async (data): Promise<ShareResult> => {
    const text = shareText(data)
    if (!text) return 'failed'
    try {
      const shared = await call<boolean>('share_text', { title: data.title ?? null, text })
      return shared === false ? 'cancelled' : 'shared'
    } catch {
      return 'failed'
    }
  },
})

export interface BackEnv {
  // What is open on top of the chat; empty when nothing is.
  open: () => string
  // Asks the topmost layer to close, like the Escape key does.
  escape: () => void
  // Waits until the page has reacted to `escape`.
  settle: () => Promise<void>
  canGoBack: boolean
  back: () => void
  exit: () => void
}

// The Android back button closes the topmost sheet, menu or dialog first, then goes back through
// the chat's history, and leaves the app at the start of it. When nothing closed, it goes on to
// the history step, so a layer that ignores Escape can't trap the button.
export const onBack = async (env: BackEnv) => {
  const before = env.open()
  if (before) {
    env.escape()
    await env.settle()
    if (env.open() !== before) return
  }
  if (env.canGoBack) env.back()
  else env.exit()
}

// Layers listen for Escape on the window, so the key goes there: sent to the focused field, it
// would also cancel a reply or edit in progress.
export const pressEscape = (target: EventTarget) => {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
}
