import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Typography,
  Chip,
  Menu,
  MenuItem,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import { useState } from 'react'
import type { Server } from '@/app/lib/api'
import { authApi, serverApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'
import { handleApiError, pluralize } from '@/app/lib/utils'
import ServerMembersDialog from './ServerMembersDialog'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SortableServerItemProps {
  server: Server
  selectedServerId?: string
  onServerSelect: (serverName: string) => void
  onContextMenu: (e: React.MouseEvent, server: Server) => void
  currentUser: any
}

function SortableServerItem({
  server,
  selectedServerId,
  onServerSelect,
  onContextMenu,
  currentUser,
}: SortableServerItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: server.name,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : 0,
    position: 'relative' as const,
    touchAction: 'none',
  }

  return (
    <ListItem ref={setNodeRef} style={style} disablePadding {...attributes} {...listeners}>
      <ListItemButton
        selected={selectedServerId === server.name}
        onClick={() => onServerSelect(server.name)}
        onContextMenu={e => onContextMenu(e, server)}
      >
        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="body1">{server.name}</Typography>
              {server.creator_username === currentUser?.username && (
                <Chip label="Owner" size="small" color="secondary" sx={{ height: 18 }} />
              )}
            </Box>
          }
          secondary={`${pluralize(server.member_count, 'member')} • ${pluralize(server.channel_count, 'channel')}`}
        />
      </ListItemButton>
    </ListItem>
  )
}

interface ServerListProps {
  servers: Server[]
  selectedServerId?: string
  onServerSelect: (serverName: string) => void
  onCreateServer: (name: string) => Promise<void>
  onJoinServer: (name: string) => Promise<void>
  onLeaveServer?: () => Promise<void>
  onDeleteServer?: () => Promise<void>
  onReorder?: (servers: Server[]) => void
}

export default function ServerList({
  servers,
  selectedServerId,
  onServerSelect,
  onCreateServer,
  onJoinServer,
  onLeaveServer,
  onDeleteServer,
  onReorder,
}: ServerListProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogType, setDialogType] = useState<'create' | 'join'>('create')
  const [serverName, setServerName] = useState('')
  const [loading, setLoading] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [selectedServerContext, setSelectedServerContext] = useState<Server | null>(null)
  const [membersDialogOpen, setMembersDialogOpen] = useState(false)
  const [selectedServerForMembers, setSelectedServerForMembers] = useState<Server | null>(null)

  const currentUser = authApi.getCurrentUser()
  const { showError, showSuccess } = useNotifications()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (active.id !== over?.id && onReorder) {
      const oldIndex = servers.findIndex(s => s.name === active.id)
      const newIndex = servers.findIndex(s => s.name === over?.id)

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(servers, oldIndex, newIndex)
        onReorder(newOrder)
      }
    }
  }

  const handleSubmit = async () => {
    const trimmedName = serverName.trim()
    if (!trimmedName || trimmedName.length < 3) {
      return
    }

    setLoading(true)
    try {
      if (dialogType === 'create') {
        await onCreateServer(trimmedName)
      } else {
        await onJoinServer(trimmedName)
      }
      setServerName('')
      setDialogOpen(false)
    } catch (err: any) {
      console.error('Failed to create/join server:', err)
      alert(err.data?.message || err.message || 'Operation failed')
    } finally {
      setLoading(false)
    }
  }

  const handleContextMenu = (event: React.MouseEvent, server: Server) => {
    event.preventDefault()
    setMenuAnchor({ x: event.clientX, y: event.clientY })
    setSelectedServerContext(server)
  }

  const handleCloseContextMenu = () => {
    setMenuAnchor(null)
  }

  const handleManageMembers = (server: Server) => {
    setSelectedServerForMembers(server)

    setMembersDialogOpen(true)

    handleCloseContextMenu()
  }

  const handleLeaveServer = async (server: Server) => {
    handleCloseContextMenu()

    if (server.name === 'RChat') {
      showError('Cannot leave RChat server')

      return
    }

    if (!currentUser) {
      try {
        const stored = localStorage.getItem('rchat_guest_servers')

        if (stored) {
          const servers = JSON.parse(stored) as string[]

          const newServers = servers.filter(s => s !== server.name)

          localStorage.setItem('rchat_guest_servers', JSON.stringify(newServers))

          showSuccess(`Left server: ${server.name}`)

          if (onLeaveServer) {
            await onLeaveServer()
          }
        }
      } catch (err) {
        console.error('Failed to leave server in guest mode:', err)

        showError('Failed to leave server')
      }

      return
    }

    try {
      await serverApi.removeMember(server.name, currentUser.username)

      showSuccess(`Left server: ${server.name}`)

      if (onLeaveServer) {
        await onLeaveServer()
      }
    } catch (err: any) {
      handleApiError(err, `leave server ${server.name}`, showError)
    }
  }

  const handleDeleteServer = async (server: Server) => {
    handleCloseContextMenu()

    if (!server || !server.name) {
      showError('Invalid server selected')
      return
    }

    if (server.name === 'RChat') {
      showError('Cannot delete RChat server')
      return
    }

    if (!confirm(`Are you sure you want to delete server ${server.name}?`)) {
      return
    }

    try {
      await serverApi.deleteServer(server.name)
      showSuccess(`Deleted server: ${server.name}`)
      if (onDeleteServer) {
        await onDeleteServer()
      }
    } catch (err: any) {
      handleApiError(err, `delete server ${server.name}`, showError)
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Typography variant="h6">Servers</Typography>
      </Box>

      <List sx={{ overflowY: 'auto', flex: 1 }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={servers.map(s => s.name)} strategy={verticalListSortingStrategy}>
            {servers.map(server => (
              <SortableServerItem
                key={server.name}
                server={server}
                selectedServerId={selectedServerId}
                onServerSelect={onServerSelect}
                onContextMenu={handleContextMenu}
                currentUser={currentUser}
              />
            ))}
          </SortableContext>
        </DndContext>
      </List>

      <Box
        sx={{
          p: 2,

          display: 'flex',

          gap: 1,

          flexDirection: 'column',

          borderTop: 1,

          borderColor: 'divider',

          flexShrink: 0,
        }}
      >
        {currentUser && (
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => {
              setDialogType('create')

              setDialogOpen(true)
            }}
            fullWidth
          >
            Create Server
          </Button>
        )}

        <Button
          variant="text"
          onClick={() => {
            setDialogType('join')

            setDialogOpen(true)
          }}
          fullWidth
        >
          Join Server
        </Button>
      </Box>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>{dialogType === 'create' ? 'Create New Server' : 'Join Server'}</DialogTitle>

        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Server Name"
            fullWidth
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            onKeyPress={e => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>

          <Button
            onClick={handleSubmit}
            disabled={loading || !serverName.trim() || serverName.trim().length < 3}
          >
            {dialogType === 'create' ? 'Create' : 'Join'}
          </Button>
        </DialogActions>
      </Dialog>

      <Menu
        open={menuAnchor !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={menuAnchor !== null ? { top: menuAnchor.y, left: menuAnchor.x } : undefined}
      >
        {selectedServerContext && currentUser?.is_admin && (
          <MenuItem onClick={() => handleManageMembers(selectedServerContext)}>
            Manage Members
          </MenuItem>
        )}

        {selectedServerContext && (
          <MenuItem
            onClick={() => handleLeaveServer(selectedServerContext)}
            disabled={selectedServerContext.name === 'RChat'}
          >
            Leave Server
          </MenuItem>
        )}

        {selectedServerContext &&
          currentUser &&
          (currentUser.is_admin ||
            selectedServerContext.creator_username === currentUser.username) &&
          selectedServerContext.name !== 'RChat' && (
            <MenuItem
              onClick={() => handleDeleteServer(selectedServerContext)}
              sx={{ color: 'error.main' }}
            >
              Delete Server
            </MenuItem>
          )}
      </Menu>

      {selectedServerForMembers && (
        <ServerMembersDialog
          open={membersDialogOpen}
          serverName={selectedServerForMembers.name}
          onClose={() => setMembersDialogOpen(false)}
        />
      )}
    </Box>
  )
}
