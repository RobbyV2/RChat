import { useEffect, useState } from 'react'

// Milliseconds left until `until`, ticking four times a second while it runs (slow mode).
export const useCountdown = (until: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (until <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= until) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [until])
  return Math.max(0, until - now)
}
