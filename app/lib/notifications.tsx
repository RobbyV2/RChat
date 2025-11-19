'use client'

import { createContext, useContext, useState, ReactNode } from 'react'
import { Snackbar, Alert, AlertColor } from '@mui/material'

interface NotificationContextType {
  showError: (message: string) => void
  showSuccess: (message: string) => void
  showInfo: (message: string) => void
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

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [severity, setSeverity] = useState<AlertColor>('info')

  const showNotification = (msg: string, sev: AlertColor) => {
    setMessage(msg)
    setSeverity(sev)
    setOpen(true)
  }

  const showError = (msg: string) => showNotification(msg, 'error')
  const showSuccess = (msg: string) => showNotification(msg, 'success')
  const showInfo = (msg: string) => showNotification(msg, 'info')

  const handleClose = () => {
    setOpen(false)
  }

  return (
    <NotificationContext.Provider value={{ showError, showSuccess, showInfo }}>
      {children}
      <Snackbar
        open={open}
        autoHideDuration={6000}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert onClose={handleClose} severity={severity} variant="filled" sx={{ width: '100%' }}>
          {message}
        </Alert>
      </Snackbar>
    </NotificationContext.Provider>
  )
}
