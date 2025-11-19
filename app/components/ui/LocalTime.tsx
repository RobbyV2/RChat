'use client'

import { useState, useEffect } from 'react'
import { Typography } from '@mui/material'

export default function LocalTime() {
  const [time, setTime] = useState<string>('')

  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      setTime(
        now.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }

    updateTime()
    const interval = setInterval(updateTime, 1000)

    return () => clearInterval(interval)
  }, [])

  if (!time) return null

  return (
    <Typography variant="body2" sx={{ mr: 2, fontFamily: 'monospace' }}>
      {time}
    </Typography>
  )
}
