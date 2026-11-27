'use client'

import { IconButton } from './controls'
import { Row } from './layout'
import { useAccount } from '../lib/client/react'
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useStore } from '../lib/store'
import { restoreTheme } from '../lib/start'
import type { WsStatus } from '../lib/types'
import { time as appTime } from '../lib/platform/time'

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
  const account = useAccount()
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  useEffect(() => {
    restoreTheme(account)
  }, [account])
  return (
    <IconButton
      icon={theme === 'light' ? Moon : Sun}
      label="Toggle theme"
      size="lg"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    />
  )
}

export default function StatusClock({ timeCls = '' }: { timeCls?: string }) {
  const wsStatus = useStore(s => s.wsStatus)
  const live = useStore(s => s.token !== null || s.guest)
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => setTime(new Date(appTime().now()).toTimeString().slice(0, 8))
    tick()
    const id = appTime().every(1000, tick)
    return () => id()
  }, [])
  return (
    <Row gap="sm">
      <span
        title="Local time"
        className={`min-w-16 text-right text-sm tabular-nums text-on-surface-variant ${timeCls}`}
      >
        {time}
      </span>
      {live && (
        <span
          title={dotTitle[wsStatus]}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass[wsStatus]}`}
        />
      )}
    </Row>
  )
}
