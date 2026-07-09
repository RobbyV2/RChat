'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useStore } from '../lib/store'
import type { WsStatus } from '../lib/types'

const dotClass: Record<WsStatus, string> = {
  green: 'bg-status-green',
  yellow: 'bg-status-yellow',
  red: 'bg-status-red',
}

const dotTitle: Record<WsStatus, string> = {
  green: 'Live',
  yellow: 'Degraded, polling',
  red: 'Disconnected',
}

export function ThemeToggle() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  useEffect(() => {
    if (localStorage.getItem('rchat_theme') === 'light') useStore.getState().setTheme('light')
  }, [])
  return (
    <button
      title="Toggle theme"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
    >
      {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
    </button>
  )
}

export default function StatusClock() {
  const wsStatus = useStore(s => s.wsStatus)
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => setTime(new Date().toTimeString().slice(0, 8))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="flex items-center gap-2 text-sm tabular-nums text-on-surface-variant">
      <span title="Local time" className="min-w-16 text-right">
        {time}
      </span>
      <span
        title={dotTitle[wsStatus]}
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass[wsStatus]}`}
      />
    </div>
  )
}
