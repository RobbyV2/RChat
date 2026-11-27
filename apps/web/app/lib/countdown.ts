import { useEffect, useState } from 'react'
import { time } from './platform/time'

// Milliseconds left until `until`, ticking four times a second while it runs (slow mode).
export const useCountdown = (until: number): number => {
  const [now, setNow] = useState(() => time().now())
  useEffect(() => {
    setNow(time().now())
    if (until <= time().now()) return
    const timer = time().every(250, () => {
      const t = time().now()
      setNow(t)
      if (t >= until) timer()
    })
    return () => timer()
  }, [until])
  return Math.max(0, until - now)
}
