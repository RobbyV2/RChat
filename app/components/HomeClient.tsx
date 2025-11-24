'use client'

import { useState, useEffect } from 'react'
import { Container, Box, Paper, Tabs, Tab, Button } from '@mui/material'
import RegisterForm from './auth/RegisterForm'
import LoginForm from './auth/LoginForm'
import Dashboard from './dashboard/Dashboard'
import { authApi } from '../lib/api'
import { useNotifications } from '../lib/notifications'

interface HomeClientProps {
  initialTab?: number
}

export default function HomeClient({ initialTab = 1 }: HomeClientProps) {
  const [tab, setTab] = useState(initialTab)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isGuestMode, setIsGuestMode] = useState(false)
  const [mounted, setMounted] = useState(false)
  const { showSuccess } = useNotifications()

  useEffect(() => {
    setMounted(true)
    setIsAuthenticated(authApi.isAuthenticated())
    const guestMode = localStorage.getItem('rchat_guest_mode') === 'true'
    if (guestMode && !authApi.isAuthenticated()) {
      setIsGuestMode(true)
    }
  }, [])

  // Sync URL with Tab
  useEffect(() => {
    if (!mounted || isAuthenticated || isGuestMode) return

    const path = tab === 0 ? '/register' : '/login'
    if (window.location.pathname !== path && window.location.pathname !== '/') {
      // If we are on a specific route, ensure tab matches, or if tab changed, update route
      // Actually, if we are on /register, tab should be 0.
      // If we click tab 1, URL should change to /login.
      window.history.replaceState(null, '', path)
    } else if (window.location.pathname === '/' && path !== '/login') {
      // If at root, defaulting to login (tab 1) is fine, but if switched to register, update URL
      window.history.replaceState(null, '', path)
    }
  }, [tab, mounted, isAuthenticated, isGuestMode])

  const handleAuthSuccess = () => {
    setIsAuthenticated(true)
    setIsGuestMode(false)
    window.history.replaceState(null, '', '/')
  }

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } catch (err) {
      console.error('Logout error:', err)
    }
    setIsAuthenticated(false)
    setIsGuestMode(false)
    setTab(1)
    showSuccess('Logged out')
    window.history.replaceState(null, '', '/login')
  }

  const handleGuestMode = () => {
    localStorage.setItem('rchat_guest_mode', 'true')
    setIsGuestMode(true)
    window.history.replaceState(null, '', '/')
  }

  const handleExitGuestMode = () => {
    localStorage.removeItem('rchat_guest_mode')
    setIsGuestMode(false)
    setTab(0) // Go to register page usually? Or login.
    window.history.replaceState(null, '', '/register')
  }

  if (!mounted) {
    return null
  }

  if (isAuthenticated) {
    return <Dashboard isGuest={false} onLogout={handleLogout} />
  }

  if (isGuestMode) {
    return <Dashboard isGuest={true} onCreateAccount={handleExitGuestMode} />
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 4 }}>
        <Paper sx={{ p: 3 }}>
          <h1 style={{ textAlign: 'center' }}>RChat</h1>

          <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)} sx={{ mb: 2 }}>
            <Tab label="Register" />
            <Tab label="Login" />
          </Tabs>

          {tab === 0 ? (
            <RegisterForm onSuccess={handleAuthSuccess} onSwitchToLogin={() => setTab(1)} />
          ) : (
            <LoginForm onSuccess={handleAuthSuccess} onSwitchToRegister={() => setTab(0)} />
          )}

          <Box sx={{ mt: 2, textAlign: 'center' }}>
            <Button variant="text" onClick={handleGuestMode} fullWidth>
              Skip to RChat (Guest Mode)
            </Button>
          </Box>
        </Paper>
      </Box>
    </Container>
  )
}
