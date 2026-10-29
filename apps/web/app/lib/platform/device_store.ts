// Settings that must stay on this device, such as relay credentials: never synced, exported or
// sent anywhere. The web one keeps them in localStorage; a native shell can register a store
// backed by its own keychain. Keys come already scoped to the instance and account.
export interface DeviceStore {
  read: (key: string) => string | null
  write: (key: string, value: string | null) => boolean
  // Calls `fn` when another tab or window changed `key`; returns the unsubscribe.
  watch?: (key: string, fn: () => void) => () => void
}
