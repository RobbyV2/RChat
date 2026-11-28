import { useAccount } from '../lib/client/react'
import { useEffect } from 'react'
import { guestCanPost, guestPostingUntil } from '../lib/guest_chat'
import { keyed } from '../lib/lists'
import { useStore } from '../lib/store'
import { time } from '../lib/platform/time'
import type { Cancel } from '../lib/clock'

export function useGuestPostingCheck(server: string | null, channel: number | null) {
  const account = useAccount()
  const { store } = account
  const detail = useStore(s => (s.guest && server !== null ? s.servers[server] : undefined))
  const writable = useStore(s => guestCanPost(s.settings, detail, channel))
  useEffect(() => {
    if (!writable || channel === null) return
    return () => {
      store.setState(s => ({ guestPosting: keyed(s.guestPosting, String(channel), null) }))
    }
  }, [store, channel, server, writable])
  useEffect(() => {
    if (!writable || !detail || channel === null) return
    let live = true
    let timer: Cancel
    const check = async () => {
      try {
        const until = await guestPostingUntil(account, detail.name, channel)
        if (!live) return
        store.setState(s => ({
          guestPosting: { ...s.guestPosting, [channel]: until ? 'paused' : 'ready' },
        }))
        if (until)
          timer = time().after(
            Math.max(1000, until * 1000 - time().now() + 500),
            () => void check()
          )
      } catch {
        if (!live) return
        store.setState(s => ({ guestPosting: { ...s.guestPosting, [channel]: 'unavailable' } }))
        timer = time().after(15000, () => void check())
      }
    }
    void check()
    return () => {
      live = false
      timer?.()
    }
  }, [account, store, channel, detail, writable])
}
