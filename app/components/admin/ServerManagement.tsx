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
  Menu,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  DialogContentText,
  TextField,
  TablePagination,
} from '@mui/material'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import { authApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'
import { handleApiError } from '@/app/lib/utils'

interface Server {
  name: string
  creator_username: string
  created_at: string
  member_count: number
  channel_count: number
}

export default function ServerManagement() {
  const [servers, setServers] = useState<Server[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [total, setTotal] = useState(0)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [selectedServer, setSelectedServer] = useState<Server | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const { showError, showSuccess } = useNotifications()

  const loadServers = useCallback(async () => {
    try {
      setLoading(true)
      const offset = page * rowsPerPage
      const response = await fetch(
        `/api/admin/servers?limit=${rowsPerPage}&offset=${offset}&q=${encodeURIComponent(search)}`,
        {
          headers: authApi.getAuthHeaders(),
        }
      )
      if (!response.ok) {
        throw new Error('Failed to load servers')
      }
      const data = await response.json()
      setServers(data.servers)
      setTotal(data.total)
    } catch (err: any) {
      handleApiError(err, 'load servers', showError)
    } finally {
      setLoading(false)
    }
  }, [page, rowsPerPage, search, showError])

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      loadServers()
    }, 300)
    return () => clearTimeout(timeoutId)
  }, [loadServers])

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, server: Server) => {
    setAnchorEl(event.currentTarget)
    setSelectedServer(server)
  }

  const handleMenuClose = () => {
    setAnchorEl(null)
  }

  const handleDeleteClick = () => {
    handleMenuClose()
    setDeleteDialogOpen(true)
  }

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false)
    setSelectedServer(null)
  }

  const handleDeleteConfirm = async () => {
    if (!selectedServer) return

    try {
      const response = await fetch(`/api/servers/${selectedServer.name}`, {
        method: 'DELETE',
        headers: authApi.getAuthHeaders(),
      })
      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to delete server')
      }
      showSuccess(`Server ${selectedServer.name} has been deleted`)
      await loadServers()
    } catch (err: any) {
      handleApiError(err, `delete server ${selectedServer.name}`, showError)
    } finally {
      setDeleteDialogOpen(false)
      setSelectedServer(null)
    }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Server Management</Typography>
        <TextField
          size="small"
          label="Search Servers"
          variant="outlined"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </Box>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Server Name</TableCell>
              <TableCell>Creator</TableCell>
              <TableCell>Members</TableCell>
              <TableCell>Channels</TableCell>
              <TableCell>Created At</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {servers.map(server => (
              <TableRow key={server.name}>
                <TableCell>{server.name}</TableCell>
                <TableCell>{server.creator_username}</TableCell>
                <TableCell>{server.member_count}</TableCell>
                <TableCell>{server.channel_count}</TableCell>
                <TableCell>{new Date(server.created_at).toLocaleString()}</TableCell>
                <TableCell align="right">
                  {server.name !== 'RChat' && (
                    <IconButton size="small" onClick={e => handleMenuOpen(e, server)}>
                      <MoreVertIcon />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {servers.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  No servers found.
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

      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
        <MenuItem onClick={handleDeleteClick} sx={{ color: 'error.main' }}>
          Delete Server
        </MenuItem>
      </Menu>

      <Dialog open={deleteDialogOpen} onClose={handleDeleteCancel}>
        <DialogTitle>Delete Server</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete server {selectedServer?.name}? This will permanently
            delete all channels, messages, and remove all members from this server.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete Server
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
