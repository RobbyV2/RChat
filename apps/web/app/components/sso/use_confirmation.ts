import { useCallback, useLayoutEffect, useRef } from 'react'
import { client } from '../../lib/client/client'
import { useAccount, useStore } from '../../lib/client/react'

// Capture the specific account, session and settings dialog before any async work.
export function useConfirmation() {
  const acct = useAccount()
  const shownVersion = client.shownVersion()
  const mark = acct.lifetime.sessionMark()
  const dialog = useStore(s => s.activeDialog)
  const token = useStore(s => s.token)
  const username = useStore(s => s.me?.username)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(() => {
    const s = acct.store.getState()
    return (
      mounted.current &&
      client.shown() === acct &&
      client.shownVersion() === shownVersion &&
      !!username &&
      !s.guest &&
      s.token === token &&
      s.me?.username === username &&
      mark === acct.lifetime.sessionMark() &&
      dialog === s.activeDialog
    )
  }, [acct, shownVersion, mark, dialog, username, token])
}
