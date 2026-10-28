import type { BlobStore } from './blobs'
import { webBlobs } from './web_blobs'
import type { Notifier } from './notifications'
import { webNotifier } from './web_notifications'
import type { Sharing } from './sharing'
import { webSharing } from './web_sharing'

export type { BlobStore } from './blobs'
export type { NoticeHandle, NoticeOptions, Notifier, Permission } from './notifications'
export type { ShareData, ShareResult, Sharing } from './sharing'

// The adapter in use. Native builds register theirs at startup, before the app renders, e.g.
// `if ('__TAURI_INTERNALS__' in window) setNotifier(tauriNotifier)`; tests register a fake.
let notifier: Notifier = webNotifier

export const notifications = () => notifier

export const setNotifier = (next: Notifier) => {
  notifier = next
}

let sharer: Sharing = webSharing

export const sharing = () => sharer

export const setSharing = (next: Sharing) => {
  sharer = next
}

let blobStore: BlobStore = webBlobs

export const blobs = () => blobStore

export const setBlobs = (next: BlobStore) => {
  blobStore = next
}
