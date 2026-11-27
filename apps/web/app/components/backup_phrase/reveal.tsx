'use client'

import { useEffect, useState } from 'react'
import { useStoreApi } from '../../lib/client/react'
import { useStore } from '../../lib/store'
import { Button } from '../controls'

// Blurs the phrase in streamer mode, with no hover or tap reveal, until the user presses Show.
// Turning streamer mode on again covers it again.
export const SECRET = 'streamer-secret'

export function useReveal() {
  const store = useStoreApi()
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState(false)
  useEffect(
    () =>
      store.subscribe((s, prev) => {
        if (s.streamer && !prev.streamer) setShown(false)
      }),
    [store]
  )
  return {
    streamer,
    hidden: streamer && !shown,
    show: () => setShown(true),
    hide: () => setShown(false),
  }
}

export type Reveal = ReturnType<typeof useReveal>

// Show words / Hide words, only in streamer mode.
export function RevealToggle({ reveal }: { reveal: Reveal }) {
  if (!reveal.streamer) return null
  return (
    <Button onClick={reveal.hidden ? reveal.show : reveal.hide} place="self-start">
      {reveal.hidden ? 'Show words' : 'Hide words'}
    </Button>
  )
}
