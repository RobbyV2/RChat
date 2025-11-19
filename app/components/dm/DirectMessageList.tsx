'use client'

import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import { useState } from 'react'
import type { DirectMessage } from '@/app/lib/api'
import { authApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'

interface DirectMessageListProps {
  dms: DirectMessage[]
  selectedDmId?: string
  onDmSelect: (dmId: string) => void
  onCreateDm: (username: string) => Promise<void>
}

export default function DirectMessageList({
  dms,
  selectedDmId,
  onDmSelect,
  onCreateDm,
}: DirectMessageListProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const { showError, showSuccess } = useNotifications()
  const currentUser = authApi.getCurrentUser()

  const getDmDisplayName = (dm: DirectMessage) => {
    if (!currentUser) return dm.username1
    if (dm.username1 === dm.username2) {
      return `${dm.username1} (You)`
    }
    return dm.username1 === currentUser.username ? dm.username2 : dm.username1
  }

  const handleCreate = async () => {
    if (!username.trim()) return

    setLoading(true)
    try {
      await onCreateDm(username)
      setUsername('')
      setDialogOpen(false)
      showSuccess(`Started DM with ${username}`)
    } catch (err: any) {
      console.error('Failed to create DM:', err)
      showError(err?.message || 'Failed to start DM')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Typography variant="subtitle1">Direct Messages</Typography>
        <Button size="small" fullWidth onClick={() => setDialogOpen(true)} sx={{ mt: 1 }}>
          New DM
        </Button>
      </Box>

      <List sx={{ overflowY: 'auto', flex: 1 }}>
        {dms.map(dm => (
          <ListItem key={dm.id} disablePadding>
            <ListItemButton selected={selectedDmId === dm.id} onClick={() => onDmSelect(dm.id)}>
              <PersonIcon fontSize="small" sx={{ mr: 1 }} />
              <ListItemText
                primary={getDmDisplayName(dm)}
                secondary={`${dm.message_count} messages`}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Start Direct Message</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Username"
            fullWidth
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyPress={e => {
              if (e.key === 'Enter') handleCreate()
            }}
            helperText="Enter a username to start a DM (you can DM yourself)"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={loading || !username.trim()}>
            Start DM
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
