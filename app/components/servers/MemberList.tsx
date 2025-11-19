'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
  Menu,
  MenuItem,
  Chip,
  Divider,
} from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord'
import { serverApi } from '@/app/lib/api'
import type { ServerMember } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'

interface MemberListProps {
  serverName: string
  currentUsername?: string
  isAdmin?: boolean
  isSiteAdmin?: boolean
  isCreator?: boolean
  refreshTrigger?: number
  members?: ServerMember[]
  isGuest?: boolean
  onStartDm?: (username: string) => void
}

export default function MemberList({
  serverName,
  currentUsername,
  isAdmin = false,
  isSiteAdmin = false,
  isCreator = false,
  refreshTrigger,
  members: externalMembers,
  isGuest = false,
  onStartDm,
}: MemberListProps) {
  const [internalMembers, setInternalMembers] = useState<ServerMember[]>([])
  const [menuAnchor, setMenuAnchor] = useState<{ mouseX: number; mouseY: number } | null>(null)
  const [selectedMember, setSelectedMember] = useState<ServerMember | null>(null)
  const [loading, setLoading] = useState(true)
  const { showSuccess, showError } = useNotifications()

  const members = externalMembers || internalMembers

  const loadMembers = useCallback(async () => {
    try {
      setLoading(true)
      let memberList
      if (isGuest) {
        const response = await fetch(`/api/public/servers/${serverName}/members`)
        if (response.ok) {
          memberList = await response.json()
        } else {
          memberList = []
        }
      } else {
        memberList = await serverApi.listMembers(serverName)
      }
      setInternalMembers(memberList)
    } catch (err) {
      console.error('Failed to load members:', err)
    } finally {
      setLoading(false)
    }
  }, [isGuest, serverName])

  useEffect(() => {
    if (!externalMembers) {
      loadMembers()
    } else {
      setLoading(false)
    }
  }, [serverName, refreshTrigger, externalMembers, isGuest, loadMembers])

  const handleContextMenu = (event: React.MouseEvent, member: ServerMember) => {
    event.preventDefault()
    if (isGuest && !isSiteAdmin) return

    setMenuAnchor({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
    })
    setSelectedMember(member)
  }

  const handleClose = () => {
    setMenuAnchor(null)
  }

  const handlePromote = async (member: ServerMember) => {
    handleClose()
    try {
      await serverApi.updateMemberRole(serverName, member.username, 'admin')
      await loadMembers()
      showSuccess(`Promoted ${member.username} to admin`)
    } catch (err: any) {
      showError(err.message || 'Failed to promote member')
    }
  }

  const handleDemote = async (member: ServerMember) => {
    handleClose()
    try {
      await serverApi.updateMemberRole(serverName, member.username, 'member')
      await loadMembers()
      showSuccess(`Demoted ${member.username} to member`)
    } catch (err: any) {
      showError(err.message || 'Failed to demote member')
    }
  }

  const handleTransferOwnership = async (member: ServerMember) => {
    handleClose()
    if (
      !confirm(
        `Are you sure you want to transfer ownership of ${serverName} to ${member.username}? You will be demoted to a regular member.`
      )
    ) {
      return
    }
    try {
      await serverApi.transferOwnership(serverName, member.username)
      await loadMembers()
      showSuccess(`Ownership transferred to ${member.username}`)
    } catch (err: any) {
      showError(err.message || 'Failed to transfer ownership')
    }
  }

  const handleServerBan = async (member: ServerMember) => {
    handleClose()

    if (!member || !member.username) {
      showError('Invalid member selected')
      return
    }

    if (
      !confirm(
        `Are you sure you want to BAN ${member.username} from this server? They will be removed and cannot rejoin.`
      )
    ) {
      return
    }

    try {
      await serverApi.removeMember(serverName, member.username)
      await loadMembers()
      showSuccess(`Banned ${member.username} from server`)
    } catch (err: any) {
      showError(err.message || 'Failed to ban member')
    }
  }

  const handleBan = async (member: ServerMember) => {
    handleClose()

    if (!member || !member.username) {
      showError('Invalid member selected')
      return
    }

    if (
      !confirm(
        `Are you sure you want to SITE-BAN ${member.username}? This will delete their account and ALL messages.`
      )
    ) {
      return
    }

    try {
      const encodedUsername = encodeURIComponent(member.username)
      const response = await fetch(`/api/admin/users/${encodedUsername}/ban`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('auth_token')}`,
        },
      })

      if (!response.ok) {
        throw new Error('Failed to ban user')
      }

      showSuccess(`Site-banned user ${member.username}`)
      await loadMembers()
    } catch (err: any) {
      showError(err.message || 'Failed to ban user')
    }
  }

  const handleDm = (member: ServerMember) => {
    handleClose()
    if (onStartDm) onStartDm(member.username)
  }

  if (loading) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">Loading members...</Typography>
      </Box>
    )
  }

  const onlineMembers = members.filter(m => m.is_online === 1)
  const offlineMembers = members.filter(m => m.is_online === 0)

  const renderMember = (member: ServerMember) => (
    <ListItem key={member.username} disablePadding>
      <ListItemButton onContextMenu={e => handleContextMenu(e, member)} sx={{ py: 0.5 }}>
        <FiberManualRecordIcon
          fontSize="small"
          sx={{
            mr: 1,
            color: member.is_online === 1 ? 'success.main' : 'text.disabled',
            fontSize: 12,
          }}
        />
        <PersonIcon fontSize="small" sx={{ mr: 1 }} />
        <ListItemText
          primary={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2">{member.username}</Typography>
              {member.role === 'admin' && (
                <Chip label="Admin" size="small" color="primary" sx={{ height: 18 }} />
              )}
            </Box>
          }
        />
      </ListItemButton>
    </ListItem>
  )

  return (
    <Box
      sx={{ width: 250, borderLeft: 1, borderColor: 'divider', height: '100%', overflow: 'auto' }}
    >
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography variant="subtitle1">Members ({members.length})</Typography>
      </Box>

      <List dense>
        {onlineMembers.length > 0 && (
          <>
            <Box sx={{ px: 2, py: 1, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary" fontWeight="bold">
                ONLINE — {onlineMembers.length}
              </Typography>
            </Box>
            {onlineMembers.map(renderMember)}
          </>
        )}

        {offlineMembers.length > 0 && (
          <>
            {onlineMembers.length > 0 && <Divider sx={{ my: 1 }} />}
            <Box sx={{ px: 2, py: 1, bgcolor: 'action.hover' }}>
              <Typography variant="caption" color="text.secondary" fontWeight="bold">
                OFFLINE — {offlineMembers.length}
              </Typography>
            </Box>
            {offlineMembers.map(renderMember)}
          </>
        )}
      </List>

      <Menu
        open={menuAnchor !== null}
        onClose={handleClose}
        anchorReference="anchorPosition"
        anchorPosition={
          menuAnchor !== null ? { top: menuAnchor.mouseY, left: menuAnchor.mouseX } : undefined
        }
      >
        {!isGuest && onStartDm && (
          <MenuItem onClick={() => handleDm(selectedMember!)}>Direct Message</MenuItem>
        )}

        {isAdmin &&
          currentUsername &&
          selectedMember &&
          selectedMember.username.toLowerCase() !== currentUsername.toLowerCase() &&
          (selectedMember.role === 'member' ? (
            <MenuItem onClick={() => handlePromote(selectedMember)}>Promote to Admin</MenuItem>
          ) : (
            <MenuItem onClick={() => handleDemote(selectedMember)}>Demote to Member</MenuItem>
          ))}

        {isCreator &&
          currentUsername &&
          selectedMember &&
          selectedMember.username.toLowerCase() !== currentUsername.toLowerCase() && (
            <MenuItem onClick={() => handleTransferOwnership(selectedMember)}>
              Transfer Ownership
            </MenuItem>
          )}

        {isAdmin &&
          currentUsername &&
          selectedMember &&
          selectedMember.username.toLowerCase() !== currentUsername.toLowerCase() && (
            <MenuItem onClick={() => handleServerBan(selectedMember)} sx={{ color: 'error.main' }}>
              Server Ban
            </MenuItem>
          )}

        {isSiteAdmin &&
          currentUsername &&
          selectedMember &&
          selectedMember.username.toLowerCase() !== currentUsername.toLowerCase() && (
            <MenuItem
              onClick={() => handleBan(selectedMember)}
              sx={{ color: 'error.dark', fontWeight: 'bold' }}
            >
              Site Ban
            </MenuItem>
          )}
      </Menu>
    </Box>
  )
}
