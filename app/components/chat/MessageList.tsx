'use client'

import { useState, useRef, useEffect } from 'react'
import { Box, Paper, Typography, Chip, Menu, MenuItem, Link, IconButton, Fab } from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import UserAvatar from '../ui/UserAvatar'
import type { Message } from '@/app/lib/api'
import { authApi, serverApi } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'

interface MessageListProps {
  messages: Message[]
  isAdmin?: boolean
  isSiteAdmin?: boolean
  serverName?: string // Context for Server Ban
  onDeleteMessage?: (messageId: string) => Promise<void>
  onStartDm?: (username: string) => Promise<void>
}

export default function MessageList({
  messages,
  isAdmin,
  isSiteAdmin,
  serverName,
  onDeleteMessage,
  onStartDm,
}: MessageListProps) {
  const [menuAnchor, setMenuAnchor] = useState<{ mouseX: number; mouseY: number } | null>(null)
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const { showSuccess, showError } = useNotifications()
  const currentUser = authApi.getCurrentUser()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)

  const uniqueMessages = messages.filter(
    (msg, index, self) => index === self.findIndex(m => m.id === msg.id)
  )

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      isAtBottomRef.current = true
      setShowScrollButton(false)
    }
  }

  const checkIfAtBottom = () => {
    if (!scrollRef.current) return true
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const threshold = 100
    return scrollHeight - scrollTop - clientHeight < threshold
  }

  const handleScroll = () => {
    const atBottom = checkIfAtBottom()
    isAtBottomRef.current = atBottom
    setShowScrollButton(!atBottom)
  }

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom()
    }
  }, [messages])

  const handleContextMenu = (event: React.MouseEvent, message: Message) => {
    event.preventDefault()
    if (!currentUser) return // Disable context menu for guests
    setMenuAnchor({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
    })
    setSelectedMessage(message)
  }

  const handleCloseContextMenu = () => {
    setMenuAnchor(null)
  }

  const handleDeleteMessage = async () => {
    if (!selectedMessage || !onDeleteMessage) return
    const msg = selectedMessage
    handleCloseContextMenu()
    try {
      await onDeleteMessage(msg.id)
      showSuccess('Message deleted')
    } catch (err: any) {
      showError(err?.message || 'Failed to delete message')
    }
  }

  const handleStartDmWithUser = async () => {
    if (!selectedMessage || !onStartDm) return
    const username = selectedMessage.sender_username
    handleCloseContextMenu()
    try {
      await onStartDm(username)
      showSuccess(`Started DM with ${username}`)
    } catch (err: any) {
      showError(err?.message || 'Failed to start DM')
    }
  }

  const handleServerBan = async () => {
    if (!selectedMessage || !serverName) return
    const username = selectedMessage.sender_username
    handleCloseContextMenu()

    if (
      !confirm(
        `Are you sure you want to BAN ${username} from this server? They will be removed and cannot rejoin.`
      )
    ) {
      return
    }

    try {
      await serverApi.removeMember(serverName, username)
      showSuccess(`Banned ${username} from server`)
    } catch (err: any) {
      showError(err?.message || 'Failed to ban user')
    }
  }

  const handleSiteBan = async () => {
    if (!selectedMessage) return
    const username = selectedMessage.sender_username
    handleCloseContextMenu()

    if (
      !confirm(
        `Are you sure you want to SITE-BAN ${username}? This will delete their account and ALL messages.`
      )
    ) {
      return
    }

    try {
      const encodedUsername = encodeURIComponent(username)
      const response = await fetch(`/api/admin/users/${encodedUsername}/ban`, {
        method: 'POST',
        headers: authApi.getAuthHeaders(),
      })

      if (!response.ok) {
        throw new Error('Failed to ban user')
      }

      showSuccess(`Site-banned user ${username}`)
    } catch (err: any) {
      showError(err.message || 'Failed to ban user')
    }
  }

  return (
    <Box
      sx={{
        flex: 1,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box ref={scrollRef} onScroll={handleScroll} sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
        {uniqueMessages.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', mt: 4 }}>
            No messages yet. Start the conversation!
          </Typography>
        ) : (
          uniqueMessages.map(message => (
            <Paper
              key={message.id}
              sx={{ p: 2, mb: 2, cursor: 'context-menu' }}
              onContextMenu={e => handleContextMenu(e, message)}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1 }}>
                <Box sx={{ mr: 2 }}>
                  <UserAvatar
                    username={message.sender_username}
                    profileType={message.sender_profile_type}
                    avatarColor={message.sender_avatar_color}
                  />
                </Box>

                <Box sx={{ flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                      {message.sender_username}
                    </Typography>

                    <Typography variant="caption" color="text.secondary" sx={{ ml: 2 }}>
                      {new Date(message.created_at).toLocaleString()}
                    </Typography>

                    {message.filter_status === 'filtered' && (
                      <Chip label="Filtered" size="small" color="warning" sx={{ ml: 1 }} />
                    )}
                  </Box>

                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                    {message.filtered_content || message.content}
                  </Typography>

                  {message.attachments && message.attachments.length > 0 && (
                    <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                      {message.attachments.map(attachment => {
                        const isImage = attachment.content_type.startsWith('image/')

                        if (isImage) {
                          return (
                            <Box
                              key={attachment.file_id}
                              sx={{ display: 'block', maxWidth: '100%' }}
                            >
                              <Box
                                component="img"
                                src={`/api/downloads/${attachment.file_id}`}
                                alt={attachment.original_name}
                                sx={{
                                  maxWidth: '400px',

                                  maxHeight: '300px',

                                  width: 'auto',

                                  height: 'auto',

                                  borderRadius: 1,

                                  cursor: 'pointer',

                                  display: 'block',
                                }}
                                onClick={() =>
                                  window.open(
                                    `/api/downloads/${attachment.file_id}`,

                                    '_blank'
                                  )
                                }
                              />

                              {/* Download link below image for clarity */}

                              <Link
                                href={`/api/downloads/${attachment.file_id}`}
                                download={attachment.original_name}
                                variant="caption"
                                sx={{ display: 'block', mt: 0.5, textDecoration: 'none' }}
                              >
                                {attachment.original_name}
                              </Link>
                            </Box>
                          )
                        }

                        // Non-image file card

                        return (
                          <Paper
                            key={attachment.file_id}
                            variant="outlined"
                            sx={{
                              p: 2,

                              display: 'flex',

                              alignItems: 'center',

                              gap: 2,

                              width: 'fit-content',

                              maxWidth: '100%',

                              bgcolor: 'background.paper',

                              borderRadius: 1,
                            }}
                          >
                            <Box
                              sx={{
                                color: 'primary.main',

                                display: 'flex',

                                alignItems: 'center',
                              }}
                            >
                              <InsertDriveFileIcon fontSize="large" />
                            </Box>

                            <Box sx={{ minWidth: 0 }}>
                              <Link
                                href={`/api/downloads/${attachment.file_id}`}
                                download={attachment.original_name}
                                variant="body2"
                                color="textPrimary"
                                sx={{
                                  fontWeight: 500,

                                  display: 'block',

                                  textDecoration: 'none',

                                  '&:hover': { textDecoration: 'underline' },

                                  whiteSpace: 'nowrap',

                                  overflow: 'hidden',

                                  textOverflow: 'ellipsis',

                                  maxWidth: '200px',
                                }}
                              >
                                {attachment.original_name}
                              </Link>

                              <Typography variant="caption" color="text.secondary">
                                {(attachment.size / 1024 / 1024).toFixed(2)} MB
                              </Typography>
                            </Box>

                            <IconButton
                              component="a"
                              href={`/api/downloads/${attachment.file_id}`}
                              download={attachment.original_name}
                              size="small"
                              color="primary"
                            >
                              <DownloadIcon />
                            </IconButton>
                          </Paper>
                        )
                      })}
                    </Box>
                  )}
                </Box>
              </Box>
            </Paper>
          ))
        )}
      </Box>

      {showScrollButton && (
        <Fab
          size="small"
          color="primary"
          onClick={scrollToBottom}
          sx={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            boxShadow: 3,
          }}
        >
          <KeyboardArrowDownIcon />
        </Fab>
      )}

      <Menu
        open={menuAnchor !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          menuAnchor !== null ? { top: menuAnchor.mouseY, left: menuAnchor.mouseX } : undefined
        }
      >
        {onStartDm && selectedMessage && currentUser?.username && (
          <MenuItem onClick={handleStartDmWithUser}>Send Direct Message</MenuItem>
        )}

        {serverName &&
          isAdmin &&
          selectedMessage &&
          currentUser &&
          selectedMessage.sender_username.toLowerCase() !== currentUser.username.toLowerCase() && (
            <MenuItem onClick={handleServerBan} sx={{ color: 'error.main' }}>
              Server Ban
            </MenuItem>
          )}

        {isSiteAdmin &&
          selectedMessage &&
          currentUser &&
          selectedMessage.sender_username.toLowerCase() !== currentUser.username.toLowerCase() && (
            <MenuItem onClick={handleSiteBan} sx={{ color: 'error.dark', fontWeight: 'bold' }}>
              Site Ban
            </MenuItem>
          )}

        {onDeleteMessage &&
          selectedMessage &&
          currentUser?.username &&
          (isAdmin ||
            isSiteAdmin ||
            selectedMessage.sender_username.toLowerCase() ===
              currentUser.username.toLowerCase()) && (
            <MenuItem onClick={handleDeleteMessage} sx={{ color: 'error.main' }}>
              Delete Message
            </MenuItem>
          )}
      </Menu>
    </Box>
  )
}
