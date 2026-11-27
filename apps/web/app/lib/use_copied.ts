import { useEffect, useState } from 'react'
import { time } from './platform/time'

// Returns `[copied, flash]`. `copied` is true for 1.5 s after `flash()`, for a "Copied" check mark.
export function useCopied() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = time().after(1500, () => setCopied(false))
    return () => id()
  }, [copied])
  return [copied, () => setCopied(true)] as const
}
