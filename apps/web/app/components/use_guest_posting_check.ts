import { useEffect } from 'react'
import { guestCanPost, guestSessionHeaders } from '../lib/guest_chat'
import { api } from '../lib/instances'
import { keyed } from '../lib/lists'
import { useStore } from '../lib/store'

export function useGuestPostingCheck(server: string | null, channel: number | null) {
  const detail = useStore(s => (s.guest && server !== null ? s.servers[server] : undefined))
  const writable = useStore(s => guestCanPost(s.settings, detail, channel))
  useEffect(() => {
    if (!writable || channel === null) return
    return () => {
      useStore.setState(s => ({ guestPosting: keyed(s.guestPosting, String(channel), null) }))
    }
  }, [channel, server, writable])
  useEffect(() => {
    if (!writable || !detail || channel === null) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const check = async () => {
      try {
        const until = await api.req<number | null>(
          'GET',
          `/channels/${channel}/guest-messages`,
          undefined,
          guestSessionHeaders(api, detail.name)
        )
        if (!live) return
        useStore.setState(s => ({
          guestPosting: { ...s.guestPosting, [channel]: until ? 'paused' : 'ready' },
        }))
        if (until)
          timer = setTimeout(() => void check(), Math.max(1000, until * 1000 - Date.now() + 500))
      } catch {
        if (!live) return
        useStore.setState(s => ({ guestPosting: { ...s.guestPosting, [channel]: 'unavailable' } }))
        timer = setTimeout(() => void check(), 15000)
      }
    }
    void check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [channel, detail, writable])
}
