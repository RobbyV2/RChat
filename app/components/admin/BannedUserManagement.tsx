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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  DialogContentText,
  TextField,
  TablePagination,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import { authApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'
import { handleApiError } from '@/app/lib/utils'

interface BannedUser {
  username: string
  banned_at: string
  banned_by: string
  reason?: string
}

export default function BannedUserManagement() {
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [total, setTotal] = useState(0)
  const [selectedUser, setSelectedUser] = useState<BannedUser | null>(null)
  const [unbanDialogOpen, setUnbanDialogOpen] = useState(false)
  const { showError, showSuccess } = useNotifications()

  const loadBannedUsers = useCallback(async () => {
    try {
      setLoading(true)
      const offset = page * rowsPerPage
      const response = await fetch(
        `/api/admin/banned-users?limit=${rowsPerPage}&offset=${offset}&q=${encodeURIComponent(search)}`,
        {
          headers: authApi.getAuthHeaders(),
        }
      )
      if (!response.ok) {
        throw new Error('Failed to load banned users')
      }
      const data = await response.json()
      setBannedUsers(data.banned_users)
      setTotal(data.total)
    } catch (err: any) {
      handleApiError(err, 'load banned users', showError)
    } finally {
      setLoading(false)
    }
  }, [page, rowsPerPage, search, showError])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      loadBannedUsers()
    }, 300)
    return () => clearTimeout(timeoutId)
  }, [loadBannedUsers])

  const handleUnbanClick = (user: BannedUser) => {
    setSelectedUser(user)
    setUnbanDialogOpen(true)
  }

  const handleUnbanCancel = () => {
    setUnbanDialogOpen(false)
    setSelectedUser(null)
  }

  const handleUnbanConfirm = async () => {
    if (!selectedUser) return

    try {
      const response = await fetch(`/api/admin/banned-users/${selectedUser.username}`, {
        method: 'DELETE',
        headers: authApi.getAuthHeaders(),
      })
      if (!response.ok) {
        throw new Error('Failed to unban user')
      }
      showSuccess(`User ${selectedUser.username} has been unbanned`)
      await loadBannedUsers()
    } catch (err: any) {
      handleApiError(err, `unban user ${selectedUser.username}`, showError)
    } finally {
      setUnbanDialogOpen(false)
      setSelectedUser(null)
    }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Banned User Management</Typography>
        <TextField
          size="small"
          label="Search Banned Users"
          variant="outlined"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </Box>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Username</TableCell>
              <TableCell>Banned By</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Banned At</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {bannedUsers.map(user => (
              <TableRow key={user.username}>
                <TableCell>{user.username}</TableCell>
                <TableCell>{user.banned_by}</TableCell>
                <TableCell>{user.reason || 'N/A'}</TableCell>
                <TableCell>{new Date(user.banned_at).toLocaleString()}</TableCell>
                <TableCell align="right">
                  <IconButton
                    size="small"
                    onClick={() => handleUnbanClick(user)}
                    color="error"
                    title="Unban User"
                  >
                    <DeleteIcon />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {bannedUsers.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={5} align="center">
                  No banned users found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={total}
          page={page}
          onPageChange={(_, newPage) => setPage(newPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={e => {
            setRowsPerPage(parseInt(e.target.value, 10))
            setPage(0)
          }}
        />
      </TableContainer>

      <Dialog open={unbanDialogOpen} onClose={handleUnbanCancel}>
        <DialogTitle>Unban User</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to unban {selectedUser?.username}? This will remove them from the
            permanent blacklist, allowing them to register again.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleUnbanCancel}>Cancel</Button>
          <Button onClick={handleUnbanConfirm} color="primary">
            Unban User
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
