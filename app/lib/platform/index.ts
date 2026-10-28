import type { Notifier } from './notifications'
import { webNotifier } from './web_notifications'

export type { NoticeHandle, NoticeOptions, Notifier, Permission } from './notifications'

// The adapter in use. Native builds register theirs at startup, before the app renders, e.g.
// `if ('__TAURI_INTERNALS__' in window) setNotifier(tauriNotifier)`; tests register a fake.
let notifier: Notifier = webNotifier

export const notifications = () => notifier

export const setNotifier = (next: Notifier) => {
  notifier = next
}
