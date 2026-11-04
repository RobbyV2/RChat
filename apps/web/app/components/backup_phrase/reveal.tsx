'use client'

import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store'
import { textBtn } from '../ui'

// Blurs the phrase in streamer mode, with no hover or tap reveal, until the user presses Show.
// Turning streamer mode on again covers it again.
export const SECRET = 'streamer-secret'

export function useReveal() {
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState(false)
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.streamer && !prev.streamer) setShown(false)
      }),
    []
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
    <button
      type="button"
      onClick={reveal.hidden ? reveal.show : reveal.hide}
      className={`${textBtn} self-start`}
    >
      {reveal.hidden ? 'Show words' : 'Hide words'}
    </button>
  )
}
