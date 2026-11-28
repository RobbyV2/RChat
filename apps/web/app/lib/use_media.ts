'use client'

import { useCallback, useSyncExternalStore } from 'react'

export const COARSE_QUERY = '(pointer: coarse)'

// Whether the media query matches now; false on the server.
export function useMedia(query: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}
