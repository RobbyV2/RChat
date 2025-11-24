'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import {
  Snackbar,
  Alert,
  AlertColor,
  AlertProps,
  SnackbarOrigin,
  SnackbarProps,
} from '@mui/material'

const REDIRECT_NOTIFICATION_KEY = 'rchat_redirect_notification'

export interface NotificationConfig {
  message: string
  type?: AlertColor
  alert?: Omit<AlertProps, 'onClose' | 'children'>
  snackbar?: Omit<SnackbarProps, 'open' | 'onClose' | 'children'>
}

export function queueNotification(config: NotificationConfig, overwrite = false): void {
  if (typeof window !== 'undefined') {
    if (!overwrite && sessionStorage.getItem(REDIRECT_NOTIFICATION_KEY)) return
    sessionStorage.setItem(REDIRECT_NOTIFICATION_KEY, JSON.stringify(config))
  }
}

interface NotificationContextType {
  show: (config: NotificationConfig) => void
  showError: (message: string) => void
  showSuccess: (message: string) => void
  showInfo: (message: string) => void
  showWarning: (message: string) => void
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined)

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider')
  }
  return context
}

interface NotificationProviderProps {
  children: ReactNode
}

const DEFAULT_ANCHOR: SnackbarOrigin = { vertical: 'bottom', horizontal: 'right' }
const DEFAULT_DURATION = 6000

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<NotificationConfig>({ message: '' })

  const show = useCallback((cfg: NotificationConfig) => {
    setConfig(cfg)
    setOpen(true)
  }, [])

  const showError = useCallback(
    (message: string) => show({ message, alert: { severity: 'error' } }),
    [show]
  )
  const showSuccess = useCallback(
    (message: string) => show({ message, alert: { severity: 'success' } }),
    [show]
  )
  const showInfo = useCallback(
    (message: string) => show({ message, alert: { severity: 'info' } }),
    [show]
  )
  const showWarning = useCallback(
    (message: string) => show({ message, alert: { severity: 'warning' } }),
    [show]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return

    const stored = sessionStorage.getItem(REDIRECT_NOTIFICATION_KEY)
    if (stored) {
      sessionStorage.removeItem(REDIRECT_NOTIFICATION_KEY)
      try {
        show(JSON.parse(stored))
      } catch (e) {
        console.error('Failed to parse redirect notification:', e)
      }
    }
  }, [show])

  const handleClose = () => setOpen(false)

  const { severity: alertSeverity, variant = 'filled', ...alertProps } = config.alert ?? {}

  const severity = config.type ?? alertSeverity ?? 'info'

  const {
    autoHideDuration = DEFAULT_DURATION,
    anchorOrigin = DEFAULT_ANCHOR,
    ...snackbarProps
  } = config.snackbar ?? {}

  return (
    <NotificationContext.Provider value={{ show, showError, showSuccess, showInfo, showWarning }}>
      {children}
      <Snackbar
        open={open}
        autoHideDuration={autoHideDuration}
        onClose={handleClose}
        anchorOrigin={anchorOrigin}
        {...snackbarProps}
      >
        <Alert
          onClose={handleClose}
          severity={severity as AlertColor}
          variant={variant}
          sx={{ width: '100%' }}
          {...alertProps}
        >
          {config.message}
        </Alert>
      </Snackbar>
    </NotificationContext.Provider>
  )
}
