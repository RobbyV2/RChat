'use client'

import { useState } from 'react'
import { Box, Paper, Tabs, Tab, Typography, AppBar, Toolbar, IconButton } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import UserManagement from './UserManagement'
import ServerManagement from './ServerManagement'
import BannedUserManagement from './BannedUserManagement'

interface AdminPanelProps {
  onClose: () => void
}

export default function AdminPanel({ onClose }: AdminPanelProps) {
  const [tab, setTab] = useState(0)

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1300,
        bgcolor: 'background.default',
      }}
    >
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Site Administration Panel
          </Typography>
          <IconButton color="inherit" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)}>
          <Tab label="User Management" />
          <Tab label="Server Management" />
          <Tab label="Blacklisted Users" />
        </Tabs>
      </Box>

      <Box sx={{ p: 3, height: 'calc(100vh - 112px)', overflow: 'auto' }}>
        {tab === 0 && <UserManagement />}
        {tab === 1 && <ServerManagement />}
        {tab === 2 && <BannedUserManagement />}
      </Box>
    </Box>
  )
}
