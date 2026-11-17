import { readLocal, writeLocal } from '../instances'
import type { DeviceStore } from './device_store'

export const webDeviceStore: DeviceStore = {
  read: readLocal,
  write: writeLocal,
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
