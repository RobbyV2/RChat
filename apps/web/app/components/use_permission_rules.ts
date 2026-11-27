import { useEffect, useState } from 'react'
import { loaded } from '../lib/perms'
import { loadPermissionRules } from '../lib/perms_load'

// Whether the shared permission rules are loaded; starts loading them when they are not.
export function usePermissionRules() {
  const [ready, setReady] = useState(loaded)
  useEffect(() => {
    if (ready) return
    let live = true
    void loadPermissionRules().then(
      () => live && setReady(true),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [ready])
  return ready
}
