import type { DeviceStore } from './device_store'

const local = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const webDeviceStore: DeviceStore = {
  read: key => {
    try {
      return local()?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  write: (key, value) => {
    const store = local()
    if (!store) return false
    try {
      if (value === null) store.removeItem(key)
      else store.setItem(key, value)
      return true
    } catch {
      return false
    }
  },
  watch: (key, fn) => {
    const w = typeof window === 'undefined' ? null : window
    if (typeof w?.addEventListener !== 'function') return () => {}
    const on = (e: StorageEvent) => {
      if (e.key === key || e.key === null) fn()
    }
    w.addEventListener('storage', on)
    return () => {
      if (typeof w.removeEventListener === 'function') w.removeEventListener('storage', on)
    }
  },
}
