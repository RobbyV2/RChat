import type { AuthBrowser } from './auth_browser'
import { webAuthBrowser } from './web_auth_browser'
import { shellAuthBrowser } from './shell_auth_browser'
import type { AccountSession } from '../client/session'
import { probe, type Capabilities } from '../capabilities'
import type { BlobStore } from './blobs'
import { webBlobs } from './web_blobs'
import type { DeviceStore } from './device_store'
import { webDeviceStore } from './web_device_store'
import { shellDeviceKeys, webDeviceKeys, type DeviceKeys, type KeyVault } from './device_keys'
import type { Notifier } from './notifications'
import { webNotifier } from './web_notifications'
import type { Sharing } from './sharing'
import type { QrScanner } from './qr_scanner'
import { webQrScanner } from './web_qr_scanner'
import { webSharing } from './web_sharing'
import { inShell, invoke, mobileOs } from './desktop'
import { desktopNotifier } from './desktop_notifications'
import { desktopSharing } from './desktop_sharing'
import { mobileSharing } from './mobile'

export type { BlobStore, BlobWriter } from './blobs'
export type { DeviceStore } from './device_store'
export type { DeviceKey, DeviceKeys, KeyVault } from './device_keys'
export type { NoticeHandle, NoticeOptions, Notifier, Permission } from './notifications'
export type { ShareData, ShareResult, Sharing } from './sharing'
export type { QrScanner } from './qr_scanner'
export { mobileBrowser, pausesHidden } from './background'
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

let sharer: Sharing | undefined

export const sharing = (owner?: AccountSession, valid = () => true): Sharing => {
  if (sharer) return sharer
  if (!shell) return webSharing
  const report = owner
    ? owner.lifetime.inSession((message: string) => {
        if (valid()) owner.store.getState().setError(message)
      })
    : () => {}
  return mobile ? mobileSharing(invoke, report) : desktopSharing(invoke, report)
}

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
let deviceKeysOf: ((vault: KeyVault) => DeviceKeys) | undefined
let madeKeys = new WeakMap<KeyVault, DeviceKeys>()

export const device = () => deviceStore

export const setDeviceStore = (next: DeviceStore) => {
  deviceStore = next
  madeKeys = new WeakMap()
}

// The device key of the profile whose P2P database is `vault`: wrapped through the shell's device
// store inside a shell, a non-extractable browser key on the web. One per vault, so every caller
// waits on the same key.
export const deviceKeys = (vault: KeyVault): DeviceKeys => {
  const have = madeKeys.get(vault)
  if (have) return have
  const made = deviceKeysOf
    ? deviceKeysOf(vault)
    : shell
      ? shellDeviceKeys(vault, deviceStore, deviceStore !== webDeviceStore)
      : webDeviceKeys(vault)
  madeKeys.set(vault, made)
  return made
}

export const setDeviceKeys = (next?: (vault: KeyVault) => DeviceKeys) => {
  deviceKeysOf = next
  madeKeys = new WeakMap()
}

let qrScanner: QrScanner = webQrScanner

export const scanner = () => qrScanner

export const setScanner = (next: QrScanner) => {
  qrScanner = next
}

// Probed on first use and kept for the page; null probes again.
let caps: Capabilities | null = null

export const capabilities = (): Capabilities => (caps ??= probe())

export const setCapabilities = (next: Capabilities | null) => {
  caps = next
}

let browser: AuthBrowser | undefined
export const authBrowser = () => browser ?? (inShell() ? shellAuthBrowser : webAuthBrowser)
export const setAuthBrowser = (next?: AuthBrowser) => {
  browser = next
}
