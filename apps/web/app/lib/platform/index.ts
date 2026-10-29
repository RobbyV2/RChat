import type { BlobStore } from './blobs'
import { webBlobs } from './web_blobs'
import type { Notifier } from './notifications'
import { webNotifier } from './web_notifications'
import type { Sharing } from './sharing'
import { webSharing } from './web_sharing'
import { inShell, invoke } from './desktop'
import { desktopNotifier } from './desktop_notifications'
import { desktopSharing } from './desktop_sharing'

export type { BlobStore, BlobWriter } from './blobs'
export type { NoticeHandle, NoticeOptions, Notifier, Permission } from './notifications'
export type { ShareData, ShareResult, Sharing } from './sharing'
export { desktopInfo, inShell, type DesktopInfo, type DesktopOs } from './desktop'

// The adapters in use: the desktop shell's when running inside it, the web ones otherwise. Other
// native builds register theirs at startup, before the app renders; tests register a fake.
const desktop = inShell()

let notifier: Notifier = desktop ? desktopNotifier(invoke) : webNotifier

export const notifications = () => notifier

export const setNotifier = (next: Notifier) => {
  notifier = next
}

// Loaded on use: the store itself imports this module.
const reportError = (message: string) =>
  void import('../store').then(({ useStore }) => useStore.getState().setError(message))

let sharer: Sharing = desktop ? desktopSharing(invoke, reportError) : webSharing

export const sharing = () => sharer

export const setSharing = (next: Sharing) => {
  sharer = next
}

// The desktop shell keeps IndexedDB on disk in its own profile, so it uses the web store too.
let blobStore: BlobStore = webBlobs

export const blobs = () => blobStore

export const setBlobs = (next: BlobStore) => {
  blobStore = next
}
