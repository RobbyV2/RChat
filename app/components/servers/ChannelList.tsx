'use client'

import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  IconButton,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Menu,
  MenuItem,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import TagIcon from '@mui/icons-material/Tag'
import DeleteIcon from '@mui/icons-material/Delete'
import { useState } from 'react'
import type { Channel } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'

interface ChannelListProps {
  channels: Channel[]
  selectedChannelId?: string
  onChannelSelect: (channelId: string) => void
  onCreateChannel: (name: string) => Promise<void>
  onDeleteChannel: (channelId: string) => Promise<void>
  onRenameChannel: (channelId: string, name: string) => Promise<void>
  isAdmin?: boolean
  isSiteAdmin?: boolean
}

export default function ChannelList({
  channels,
  selectedChannelId,
  onChannelSelect,
  onCreateChannel,
  onDeleteChannel,
  onRenameChannel,
  isAdmin = false,
  isSiteAdmin = false,
}: ChannelListProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [loading, setLoading] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; channel: Channel } | null>(
    null
  )
  const [channelToRename, setChannelToRename] = useState<Channel | null>(null)
  const { showError, showSuccess } = useNotifications()

  const handleCreate = async () => {
    if (!channelName.trim()) return

    setLoading(true)
    try {
      await onCreateChannel(channelName)
      setChannelName('')
      setDialogOpen(false)
      showSuccess(`Channel "${channelName}" created successfully`)
    } catch (err: any) {
      console.error('Failed to create channel:', err)
      showError(err?.message || 'Failed to create channel')
    } finally {
      setLoading(false)
    }
  }

  const handleContextMenu = (event: React.MouseEvent, channel: Channel) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, channel })
  }

  const handleCloseContextMenu = () => {
    setContextMenu(null)
  }

  const handleRenameClick = () => {
    if (!contextMenu) return
    setChannelToRename(contextMenu.channel)
    setChannelName(contextMenu.channel.name)
    setRenameDialogOpen(true)
    setContextMenu(null)
  }

  const handleRename = async () => {
    if (!channelName.trim() || !channelToRename) return

    setLoading(true)
    try {
      await onRenameChannel(channelToRename.id, channelName)
      setChannelName('')
      setRenameDialogOpen(false)
      setChannelToRename(null)
      showSuccess('Channel renamed successfully')
    } catch (err: any) {
      console.error('Failed to rename channel:', err)
      showError(err?.message || 'Failed to rename channel')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteClick = async () => {
    if (!contextMenu) return

    const channel = contextMenu.channel
    setContextMenu(null)

    if (channels.length <= 1) {
      showError('Cannot delete the last channel')
      return
    }

    if (!window.confirm(`Are you sure you want to delete "${channel.name}"?`)) {
      return
    }

    try {
      await onDeleteChannel(channel.id)
      showSuccess('Channel deleted successfully')
    } catch (err: any) {
      console.error('Failed to delete channel:', err)
      showError(err?.message || 'Failed to delete channel')
    }
  }

  const canManage = isAdmin || isSiteAdmin

  return (
    <Box sx={{ width: 200, borderRight: 1, borderColor: 'divider', height: '100%' }}>
      <Box
        sx={{
          p: 2,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography variant="subtitle1">Channels</Typography>
        {canManage && (
          <IconButton size="small" onClick={() => setDialogOpen(true)}>
            <AddIcon />
          </IconButton>
        )}
      </Box>

      <List>
        {channels.map(channel => (
          <ListItem key={channel.id} disablePadding>
            <ListItemButton
              selected={selectedChannelId === channel.id}
              onClick={() => onChannelSelect(channel.id)}
              onContextMenu={e => handleContextMenu(e, channel)}
            >
              <TagIcon fontSize="small" sx={{ mr: 1 }} />
              <ListItemText
                primary={channel.name}
                secondary={`${channel.message_count} messages`}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>Create New Channel</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Channel Name"
            fullWidth
            value={channelName}
            onChange={e => setChannelName(e.target.value)}
            onKeyPress={e => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={loading || !channelName.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={renameDialogOpen} onClose={() => setRenameDialogOpen(false)}>
        <DialogTitle>Rename Channel</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Channel Name"
            fullWidth
            value={channelName}
            onChange={e => setChannelName(e.target.value)}
            onKeyPress={e => {
              if (e.key === 'Enter') handleRename()
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRenameDialogOpen(false)
              setChannelName('')
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleRename} disabled={loading || !channelName.trim()}>
            Rename
          </Button>
        </DialogActions>
      </Dialog>

      {canManage && (
        <Menu
          open={contextMenu !== null}
          onClose={handleCloseContextMenu}
          anchorReference="anchorPosition"
          anchorPosition={
            contextMenu !== null ? { top: contextMenu.y, left: contextMenu.x } : undefined
          }
        >
          <MenuItem onClick={handleRenameClick}>Rename Channel</MenuItem>
          {channels.length > 1 && (
            <MenuItem onClick={handleDeleteClick} sx={{ color: 'error.main' }}>
              Delete Channel
            </MenuItem>
          )}
        </Menu>
      )}
    </Box>
  )
}
