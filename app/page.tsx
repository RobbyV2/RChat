'use client'

import { useState, useEffect } from 'react'
import { Container, Box, Paper, Tabs, Tab, Button } from '@mui/material'
import RegisterForm from './components/auth/RegisterForm'
import LoginForm from './components/auth/LoginForm'
import Dashboard from './components/dashboard/Dashboard'
import { authApi } from './lib/api'

export default function Home() {
  const [tab, setTab] = useState(0)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isGuestMode, setIsGuestMode] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setIsAuthenticated(authApi.isAuthenticated())
    const guestMode = localStorage.getItem('rchat_guest_mode') === 'true'
    if (guestMode && !authApi.isAuthenticated()) {
      setIsGuestMode(true)
    }
  }, [])

  const handleAuthSuccess = () => {
    setIsAuthenticated(true)
    setIsGuestMode(false)
  }

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } catch (err) {
      console.error('Logout error:', err)
    }
    setIsAuthenticated(false)
    setIsGuestMode(false)
  }

  const handleGuestMode = () => {
    localStorage.setItem('rchat_guest_mode', 'true')
    setIsGuestMode(true)
  }

  const handleExitGuestMode = () => {
    localStorage.removeItem('rchat_guest_mode')
    setIsGuestMode(false)
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
