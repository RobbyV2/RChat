'use client'

import { Typography, Tooltip } from '@mui/material'
import { ConnectionStatus as Status } from '@/app/lib/websocket'

interface ConnectionStatusProps {
  status: Status
  reconnectAttempts?: number
}

export default function ConnectionStatus({ status, reconnectAttempts = 0 }: ConnectionStatusProps) {
  const getStatusDisplay = () => {
    switch (status) {
      case 'connected':
        return {
          icon: '🟢',
          text: 'Connected',
          color: 'success.main',
          tooltip: 'Connected to server',
        }
      case 'connecting':
        return {
          icon: '🟡',
          text: reconnectAttempts > 0 ? `Reconnecting (${reconnectAttempts})` : 'Connecting',
          color: 'warning.main',
          tooltip:
            reconnectAttempts > 0
              ? `Reconnection attempt ${reconnectAttempts}`
              : 'Connecting to server',
        }
      case 'disconnected':
        return {
          icon: '🔴',
          text: 'Disconnected',
          color: 'error.main',
          tooltip: 'Disconnected from server',
        }
    }
  }

  const { icon, text, color, tooltip } = getStatusDisplay()

  return (
    <Tooltip title={tooltip} arrow>
      <Typography
        variant="body2"
        sx={{
          mr: 2,
          color,
          cursor: 'help',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          fontWeight: 500,
        }}
      >
        {icon} {text}
      </Typography>
    </Tooltip>
  )
}
