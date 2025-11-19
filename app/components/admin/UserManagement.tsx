'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Typography,
  Chip,
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  DialogContentText,
} from '@mui/material'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import { authApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'
import { handleApiError } from '@/app/lib/utils'

interface User {
  username: string
  is_admin: number
  created_at: string
}

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const { showError, showSuccess } = useNotifications()
  const currentUser = authApi.getCurrentUser()

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/users', {
        headers: authApi.getAuthHeaders(),
      })
      if (!response.ok) {
        throw new Error('Failed to load users')
      }
      const data = await response.json()
      setUsers(data)
    } catch (err: any) {
      handleApiError(err, 'load users', showError)
    } finally {
      setLoading(false)
    }
  }, [showError])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, user: User) => {
    setAnchorEl(event.currentTarget)
    setSelectedUser(user)
  }

  const handleMenuClose = () => {
    setAnchorEl(null)
    // Do not clear selectedUser here, as it's needed for the dialog
  }

  const handleBanClick = () => {
    handleMenuClose()
    setBanDialogOpen(true)
  }

  const handleBanCancel = () => {
    setBanDialogOpen(false)
    setSelectedUser(null)
  }

  const handleBanConfirm = async () => {
    if (!selectedUser) return

    try {
      const response = await fetch(`/api/users/${selectedUser.username}/ban`, {
        method: 'POST',
        headers: authApi.getAuthHeaders(),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to ban user')
      }
      showSuccess(`User ${selectedUser.username} has been site-banned`)
      await loadUsers()
    } catch (err: any) {
      handleApiError(err, `ban user ${selectedUser.username}`, showError)
    } finally {
      setBanDialogOpen(false)
      setSelectedUser(null)
    }
  }

  if (loading) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>Loading users...</Typography>
      </Box>
    )
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        User Management
      </Typography>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Username</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Created At</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map(user => (
              <TableRow key={user.username}>
                <TableCell>{user.username}</TableCell>
                <TableCell>
                  {user.is_admin === 1 ? (
                    <Chip label="Site Admin" color="error" size="small" />
                  ) : (
                    <Chip label="User" size="small" />
                  )}
                </TableCell>
                <TableCell>{new Date(user.created_at).toLocaleString()}</TableCell>
                <TableCell align="right">
                  {user.username !== currentUser?.username && user.username !== 'system' && (
                    <IconButton size="small" onClick={e => handleMenuOpen(e, user)}>
                      <MoreVertIcon />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
        <MenuItem onClick={handleBanClick} sx={{ color: 'error.main' }}>
          Site Ban
        </MenuItem>
      </Menu>

      <Dialog open={banDialogOpen} onClose={handleBanCancel}>
        <DialogTitle>Site Ban User</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to SITE-BAN {selectedUser?.username}? This will permanently delete
            their account and all associated data (messages, files, server memberships).
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleBanCancel}>Cancel</Button>
          <Button onClick={handleBanConfirm} color="error">
            Site Ban User
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
