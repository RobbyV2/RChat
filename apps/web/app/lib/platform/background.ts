import { mobileOs } from './desktop'

interface Nav {
  userAgent?: string
  maxTouchPoints?: number
  userAgentData?: { mobile?: boolean }
}

// A phone or tablet browser (iPadOS reports a Mac with a touch screen).
export const mobileBrowser = (nav: Nav | undefined) => {
  if (!nav) return false
  if (nav.userAgentData?.mobile === true) return true
  const ua = nav.userAgent ?? ''
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)
  )
}

// Whether the system drops pages that stay in the background, so P2P sessions pause there after
// a while hidden: the mobile shell and mobile browsers, never computers.
export const pausesHidden = (
  nav: Nav | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  w: unknown = typeof window === 'undefined' ? undefined : window
) => mobileOs(w) !== null || mobileBrowser(nav)
