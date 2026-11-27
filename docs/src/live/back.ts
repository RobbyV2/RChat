import { mobileOs } from '../../../apps/web/app/lib/platform/desktop'

// Shows "Back to the app" in the phone apps, which open the docs in the app's own view. The
// desktop app opens them in a window of their own, and browsers in a tab.
export function mountBack() {
  if (!mobileOs()) return
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a.live-back'))
    link.hidden = false
}
