import type { StorageLike } from '../instances'

// Asking the browser to keep this site's data (P2P identity and history) through eviction.
// Firefox answers navigator.storage.persist() only once the user answers its prompt, maybe
// never, so nothing waits for it. A prompt dismissed earlier is asked again at a later P2P start,
// at most once per tab session, and only while the data isn't kept yet.

export const KEEP_ASKED = 'rchat_p2p_keep_asked'

export interface StorageManagerLike {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
}

export const keepAsker = (session: () => StorageLike | null) => {
  let asked = false
  return async (storage: StorageManagerLike | undefined) => {
    if (asked || !storage?.persist) return
    asked = true
    try {
      if (session()?.getItem(KEEP_ASKED)) return
    } catch {
      // No session storage: once per page.
    }
    try {
      if (await storage.persisted?.()) return
    } catch {
      // Unknown: ask.
    }
    try {
      session()?.setItem(KEEP_ASKED, '1')
    } catch {
      // Once per page then.
    }
    void storage.persist().catch(() => {})
  }
}
