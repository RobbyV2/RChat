import type { BlobStore } from './blobs'
import { webBlobs } from './web_blobs'
import type { DeviceStore } from './device_store'
import { webDeviceStore } from './web_device_store'
import type { Notifier } from './notifications'
import { webNotifier } from './web_notifications'
import type { Sharing } from './sharing'
import { webSharing } from './web_sharing'
import { inShell, invoke, mobileOs } from './desktop'
import { desktopNotifier } from './desktop_notifications'
import { desktopSharing } from './desktop_sharing'
import { mobileSharing } from './mobile'

export type { BlobStore, BlobWriter } from './blobs'
export type { DeviceStore } from './device_store'
export type { NoticeHandle, NoticeOptions, Notifier, Permission } from './notifications'
export type { ShareData, ShareResult, Sharing } from './sharing'
export {
  desktopInfo,
  inShell,
  mobileOs,
  shellInfo,
  type DesktopInfo,
  type DesktopOs,
  type MobileOs,
  type ShellInfo,
  type ShellOs,
} from './desktop'

// The adapters in use: the Tauri shell's when running inside it (desktop or mobile), the web ones
// otherwise. Other native builds register theirs at startup, before the app renders; tests
// register a fake.
const shell = inShell()
const mobile = shell && mobileOs() !== null

let notifier: Notifier = shell ? desktopNotifier(invoke) : webNotifier

export const notifications = () => notifier

export const setNotifier = (next: Notifier) => {
  notifier = next
}

// Loaded on use: the store itself imports this module.
const reportError = (message: string) =>
  void import('../store').then(({ useStore }) => useStore.getState().setError(message))

let sharer: Sharing = !shell
  ? webSharing
  : mobile
    ? mobileSharing(invoke, reportError)
    : desktopSharing(invoke, reportError)

export const sharing = () => sharer

export const setSharing = (next: Sharing) => {
  sharer = next
}

// The shell keeps IndexedDB on disk in its own profile, so it uses the web store too.
let blobStore: BlobStore = webBlobs

export const blobs = () => blobStore

export const setBlobs = (next: BlobStore) => {
  blobStore = next
}

let deviceStore: DeviceStore = webDeviceStore

export const device = () => deviceStore

export const setDeviceStore = (next: DeviceStore) => {
  deviceStore = next
}
