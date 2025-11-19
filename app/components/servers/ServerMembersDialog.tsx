'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
  Menu,
  MenuItem,
  Typography,
  CircularProgress,
  Box,
  Chip,
} from '@mui/material'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import { serverApi, authApi } from '@/app/lib/api'
import type { ServerMember } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'

interface ServerMembersDialogProps {
  open: boolean
  serverName: string
  onClose: () => void
}

export default function ServerMembersDialog({
  open,
  serverName,
  onClose,
}: ServerMembersDialogProps) {
  const [members, setMembers] = useState<ServerMember[]>([])
  const [loading, setLoading] = useState(false)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [selectedMember, setSelectedMember] = useState<ServerMember | null>(null)
  const { showSuccess, showError } = useNotifications()
  const currentUser = authApi.getCurrentUser()

  const loadMembers = useCallback(async () => {
    setLoading(true)
    try {
      const memberList = await serverApi.listMembers(serverName)
      setMembers(memberList)
    } catch (err: any) {
      showError(err?.message || 'Failed to load members')
    } finally {
      setLoading(false)
    }
  }, [serverName, showError])

  useEffect(() => {
    if (open) {
      loadMembers()
    }
  }, [open, serverName, loadMembers])

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, member: ServerMember) => {
    setAnchorEl(event.currentTarget)
    setSelectedMember(member)
  }

  const handleMenuClose = () => {
    setAnchorEl(null)
    setSelectedMember(null)
  }

  const handleServerBan = async () => {
    if (!selectedMember) return

    if (
      !confirm(
        `Are you sure you want to BAN ${selectedMember.username} from this server? They will be removed and cannot rejoin.`
      )
    ) {
      handleMenuClose()
      return
    }

    try {
      await serverApi.removeMember(serverName, selectedMember.username)
      showSuccess(`Banned ${selectedMember.username} from ${serverName}`)
      await loadMembers()
    } catch (err: any) {
      showError(err?.message || 'Failed to ban member')
    } finally {
      handleMenuClose()
    }
  }

  const handleToggleAdmin = async () => {
    if (!selectedMember) return

    const newRole = selectedMember.role === 'admin' ? 'member' : 'admin'
    const action = newRole === 'admin' ? 'promoted' : 'demoted'

    try {
      await serverApi.updateMemberRole(serverName, selectedMember.username, newRole)
      showSuccess(`${selectedMember.username} ${action} to ${newRole}`)
      await loadMembers()
    } catch (err: any) {
      showError(err?.message || `Failed to ${action} member`)
    } finally {
      handleMenuClose()
    }
  }

  const isCurrentUserAdmin =
    currentUser?.is_admin ||
    members.find(m => m.username === currentUser?.username)?.role === 'admin'

  const canManageMember = (member: ServerMember) => {
    if (member.username === currentUser?.username) return false
    if (!isCurrentUserAdmin) return false
    return true
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {serverName} - Members ({members.length})
      </DialogTitle>
      <DialogContent>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress />
          </Box>
        ) : members.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
            No members found
          </Typography>
        ) : (
          <List>
            {members.map(member => (
              <ListItem
                key={member.username}
                sx={{
                  borderBottom: 1,
                  borderColor: 'divider',
                  '&:last-child': { borderBottom: 0 },
                }}
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body1">{member.username}</Typography>
                      {member.role === 'admin' && (
                        <Chip label="Admin" size="small" color="primary" />
                      )}
                      {member.username === currentUser?.username && (
                        <Chip label="You" size="small" variant="outlined" />
                      )}
                    </Box>
                  }
                  secondary={`Joined ${new Date(member.joined_at).toLocaleDateString()}`}
                />
                {canManageMember(member) && (
                  <ListItemSecondaryAction>
                    <IconButton edge="end" onClick={e => handleMenuOpen(e, member)} size="small">
                      <MoreVertIcon />
                    </IconButton>
                  </ListItemSecondaryAction>
                )}
              </ListItem>
            ))}
          </List>
        )}

        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
          {selectedMember && (
            <>
              <MenuItem onClick={handleToggleAdmin}>
                {selectedMember.role === 'admin' ? 'Demote from Admin' : 'Promote to Admin'}
              </MenuItem>
              <MenuItem onClick={handleServerBan} sx={{ color: 'error.main' }}>
                Server Ban
              </MenuItem>
            </>
          )}
        </Menu>
      </DialogContent>
    </Dialog>
  )
}
