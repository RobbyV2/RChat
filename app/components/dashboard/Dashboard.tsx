'use client'

import { useState, useEffect } from 'react'
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Button,
  CircularProgress,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
  Alert,
  AlertTitle,
  Divider,
} from '@mui/material'
import ForumIcon from '@mui/icons-material/Forum'
import PersonIcon from '@mui/icons-material/Person'
import ServerList from '../servers/ServerList'
import ChannelList from '../servers/ChannelList'
import MessageList from '../chat/MessageList'
import MessageInput from '../chat/MessageInput'
import DirectMessageList from '../dm/DirectMessageList'
import DirectMessageChat from '../dm/DirectMessageChat'
import MemberList from '../servers/MemberList'
import LocalTime from '../ui/LocalTime'
import ConnectionStatus from '../ui/ConnectionStatus'
import AdminPanel from '../admin/AdminPanel'
import { authApi, serverApi, channelApi, messagesApi, dmApi } from '@/app/lib/api'
import type { Server, Channel, Message, DirectMessage } from '@/app/lib/api'
import { useWebSocket } from '@/app/lib/websocket'
import { useNotifications } from '@/app/lib/notifications'

interface DashboardProps {
  isGuest?: boolean
  onLogout?: () => void
  onCreateAccount?: () => void
}

const GUEST_SERVERS_KEY = 'rchat_guest_servers'

export default function Dashboard({ isGuest = false, onLogout, onCreateAccount }: DashboardProps) {
  const [servers, setServers] = useState<Server[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedServerName, setSelectedServerName] = useState<string>()
  const [selectedChannelId, setSelectedChannelId] = useState<string>()
  const [viewMode, setViewMode] = useState<'servers' | 'dms'>('servers')
  const [dms, setDms] = useState<DirectMessage[]>([])
  const [selectedDmId, setSelectedDmId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [wsUrl, setWsUrl] = useState<string>('')
  const [memberRefreshTrigger, setMemberRefreshTrigger] = useState(0)
  const [showAdminPanel, setShowAdminPanel] = useState(false)
  const { showError, showSuccess } = useNotifications()

  const user = isGuest ? null : authApi.getCurrentUser()
  const { isConnected, connectionStatus, lastMessage, reconnectAttempts } = useWebSocket(wsUrl)

  // Guest-specific helpers
  const getGuestServers = (): string[] => {
    if (typeof window === 'undefined') return ['RChat']
    const stored = localStorage.getItem(GUEST_SERVERS_KEY)
    const serverNames = stored ? JSON.parse(stored) : []

    if (!serverNames.includes('RChat')) {
      serverNames.unshift('RChat')
      localStorage.setItem(GUEST_SERVERS_KEY, JSON.stringify(serverNames))
    }

    return serverNames
  }

  const saveGuestServers = (serverNames: string[]) => {
    if (typeof window === 'undefined') return
    localStorage.setItem(GUEST_SERVERS_KEY, JSON.stringify(serverNames))
  }

  // Unified data loading functions
  const loadServers = async () => {
    if (isGuest) {
      const storedServerNames = getGuestServers()
      const serverDataPromises = storedServerNames.map(async name => {
        try {
          const response = await fetch(`/api/public/servers/lookup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server_name: name }),
          })
          if (response.ok) {
            return await response.json()
          }
          if (response.status === 404) {
            return null // Mark for deletion
          }
        } catch (err) {
          console.error(`Failed to fetch server ${name}:`, err)
        }
        return { name, creator_username: '', created_at: '', member_count: 0, channel_count: 0 }
      })

      const resolved = await Promise.all(serverDataPromises)
      const validServers = resolved.filter((s): s is Server => s !== null)

      if (validServers.length !== storedServerNames.length) {
        saveGuestServers(validServers.map(s => s.name))
      }

      setServers(validServers)
      if (validServers.length > 0 && !selectedServerName) {
        setSelectedServerName(validServers[0].name)
      }
    } else {
      try {
        const serverList = await serverApi.listServers()
        setServers(serverList)
        if (serverList.length > 0) {
          setSelectedServerName(prev => prev || serverList[0].name)
        }
      } catch (err) {
        console.error('Failed to load servers:', err)
      }
    }
  }

  const loadChannels = async (serverName: string) => {
    try {
      const channelList: Channel[] = isGuest
        ? await (await fetch(`/api/public/servers/${serverName}/channels`)).json()
        : await channelApi.listChannels(serverName)

      setChannels(channelList)
      if (channelList.length > 0) {
        setSelectedChannelId(prev => {
          const exists = channelList.some(c => c.id === prev)
          return exists ? prev : channelList[0].id
        })
      } else {
        setSelectedChannelId(undefined)
      }
    } catch (err) {
      console.error('Failed to load channels:', err)
      showError('Failed to load channels')
    }
  }

  const loadMessages = async (channelId: string) => {
    try {
      const messageList = isGuest
        ? await (await fetch(`/api/public/channels/${channelId}/messages?limit=50&offset=0`)).json()
        : await messagesApi.get('channel', channelId)

      setMessages(messageList.reverse())
    } catch (err) {
      console.error('Failed to load messages:', err)
      showError('Failed to load messages')
    }
  }

  const loadDms = async () => {
    if (isGuest) return

    try {
      const dmList = await dmApi.listDms()
      setDms(dmList)
    } catch (err) {
      console.error('Failed to load DMs:', err)
    }
  }

  // Initialize
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setWsUrl(`ws://${window.location.host}/api/ws`)
    }
  }, [isGuest])

  useEffect(() => {
    const init = async () => {
      await loadServers()
      if (!isGuest) {
        await loadDms()
      }
      setLoading(false)
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load channels and check admin status when server changes
  useEffect(() => {
    if (!selectedServerName) return

    const loadData = async () => {
      await loadChannels(selectedServerName)

      if (!isGuest && user) {
        if (user.is_admin) {
          setIsAdmin(true)
        } else {
          try {
            const members = await serverApi.listMembers(selectedServerName)
            const currentMember = members.find(m => m.username === user.username)
            setIsAdmin(currentMember?.role === 'admin')
          } catch (err) {
            console.error('Failed to check admin status:', err)
            setIsAdmin(false)
          }
        }
      }
    }

    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServerName])

  // Load messages when channel changes
  useEffect(() => {
    if (!selectedChannelId) return
    loadMessages(selectedChannelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId])

  // Load DM messages when DM changes
  useEffect(() => {
    if (!selectedDmId) return

    const loadDmMessages = async () => {
      try {
        const messageList = await messagesApi.get('direct_message', selectedDmId)
        setMessages(messageList.reverse())
      } catch (err) {
        console.error('Failed to load DM messages:', err)
        showError('Failed to load DM messages')
      }
    }

    loadDmMessages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDmId])

  // WebSocket message handling
  useEffect(() => {
    if (!lastMessage) return

    const msg = lastMessage as any
    console.log('WebSocket message received:', msg.type, msg)

    switch (lastMessage.type) {
      case 'new_message':
        if (viewMode === 'servers' && msg.channel_id === selectedChannelId) {
          setMessages(prev => [
            ...prev,
            {
              id: msg.message_id,
              channel_id: msg.channel_id,
              sender_username: msg.sender_username,
              content: msg.content,
              filtered_content: msg.filtered_content,
              content_type: msg.content_type || 'text',
              created_at: msg.created_at,
              filter_status: msg.filter_status,
              sender_profile_type: msg.sender_profile_type,
              sender_avatar_color: msg.sender_avatar_color,
              attachments: msg.attachments,
            },
          ])
        }
        break

      case 'user_online_status_changed':
        if (msg.server_name === selectedServerName) {
          setMemberRefreshTrigger(prev => prev + 1)
        }
        break

      case 'user_banned':
        if (user && msg.username === user.username) {
          showError('You have been banned.')
          if (onLogout) onLogout()
        } else {
          setMemberRefreshTrigger(prev => prev + 1)
        }
        break

      case 'server_created':
      case 'server_member_joined':
        loadServers()
        if (lastMessage.type === 'server_member_joined' && msg.server_name === selectedServerName) {
          setMemberRefreshTrigger(prev => prev + 1)
        }
        break

      case 'server_member_left':
        loadServers()
        if (msg.server_name === selectedServerName) {
          if (user && msg.username === user.username) {
            setSelectedServerName('RChat')
            showError('You have been removed from the server.')
          }
          setMemberRefreshTrigger(prev => prev + 1)
        }
        break

      case 'server_deleted':
        if (isGuest) {
          const stored = localStorage.getItem(GUEST_SERVERS_KEY)
          if (stored) {
            const servers = JSON.parse(stored) as string[]
            const newServers = servers.filter(s => s !== msg.server_name)
            localStorage.setItem(GUEST_SERVERS_KEY, JSON.stringify(newServers))
          }
        }
        loadServers()
        if (selectedServerName === msg.server_name) {
          setSelectedServerName(undefined)
          setSelectedChannelId(undefined)
        }
        break

      case 'channel_created':
      case 'channel_deleted':
      case 'channel_renamed':
        if (msg.server_name === selectedServerName && selectedServerName) {
          loadChannels(selectedServerName)
          if (lastMessage.type === 'channel_deleted' && msg.channel_id === selectedChannelId) {
            setSelectedChannelId(undefined)
          }
        }
        break

      case 'new_dm_message':
        if (viewMode === 'dms' && msg.dm_id === selectedDmId) {
          setMessages(prev => [
            ...prev,
            {
              id: msg.message_id,
              dm_id: msg.dm_id,
              sender_username: msg.sender_username,
              content: msg.content,
              filtered_content: msg.filtered_content,
              content_type: msg.content_type || 'text',
              created_at: msg.created_at,
              filter_status: msg.filter_status,
              sender_profile_type: msg.sender_profile_type,
              sender_avatar_color: msg.sender_avatar_color,
              attachments: msg.attachments,
            },
          ])
        }
        break

      case 'message_deleted':
        setMessages(prev => prev.filter(m => m.id !== msg.message_id))
        break

      case 'dm_created':
        if (msg.username1 === user?.username || msg.username2 === user?.username) {
          loadDms()
        }
        break

      case 'server_stats_updated':
        setServers(prev =>
          prev.map(server =>
            server.name === msg.server_name
              ? { ...server, member_count: msg.member_count, channel_count: msg.channel_count }
              : server
          )
        )
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage, selectedChannelId, selectedServerName, selectedDmId, viewMode])

  // Event handlers
  const handleSendMessage = async (content: string, fileId?: string) => {
    if (isGuest) {
      showError('Please create an account to send messages')
      return
    }

    if (!selectedChannelId) return

    try {
      await messagesApi.send('channel', selectedChannelId, content, 'text', fileId)
    } catch (err) {
      console.error('Failed to send message:', err)
      throw err
    }
  }

  const handleSendDmMessage = async (content: string, fileId?: string) => {
    if (!selectedDmId) return

    try {
      await messagesApi.send('direct_message', selectedDmId, content, 'text', fileId)
    } catch (err) {
      console.error('Failed to send DM:', err)
      throw err
    }
  }

  const handleCreateServer = async (name: string) => {
    if (isGuest) {
      showError('Please create an account to create servers')
      return
    }

    await serverApi.createServer(name)
    await loadServers()
  }

  const handleJoinServer = async (name: string) => {
    if (isGuest) {
      try {
        const response = await fetch(`/api/public/servers/lookup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_name: name }),
        })

        if (!response.ok) {
          throw new Error('Server not found')
        }

        const server = await response.json()
        const storedServerNames = getGuestServers()

        if (storedServerNames.includes(server.name)) {
          showError('Already joined this server')
          return
        }

        saveGuestServers([...storedServerNames, server.name])
        await loadServers()
        showSuccess('Joined server successfully')
      } catch (err: any) {
        showError(err?.message || 'Failed to join server')
      }
    } else {
      await serverApi.joinServer(name)
      await loadServers()
    }
  }

  const handleLeaveServer = async () => {
    await loadServers()
  }

  const handleDeleteServer = async () => {
    await loadServers()
  }

  if (loading) {
    return (
      <Box
        sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}
      >
        <CircularProgress />
      </Box>
    )
  }

  if (showAdminPanel) {
    return <AdminPanel onClose={() => setShowAdminPanel(false)} />
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ mr: 2 }}>
            RChat{isGuest ? ' - Guest Mode' : ` - ${user?.username}`}
          </Typography>
          {!isGuest && user?.is_admin && (
            <>
              <Chip
                label="Site Admin"
                color="error"
                size="small"
                sx={{ mr: 2, fontWeight: 'bold' }}
              />
              <Button
                variant="outlined"
                color="inherit"
                size="small"
                onClick={() => setShowAdminPanel(true)}
                sx={{ mr: 2 }}
              >
                Admin Panel
              </Button>
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <ConnectionStatus status={connectionStatus} reconnectAttempts={reconnectAttempts} />
          <LocalTime />
          <Button color="inherit" onClick={isGuest ? onCreateAccount : onLogout}>
            {isGuest ? 'Create Account' : 'Logout'}
          </Button>
        </Toolbar>
      </AppBar>

      {isGuest && (
        <Alert severity="info" sx={{ m: 1 }}>
          <AlertTitle>Guest Mode</AlertTitle>
          You are viewing in read-only mode. Create an account to send messages.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Unified Sidebar */}
        <Box
          sx={{
            width: 250,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {!isGuest && (
            <>
              <Box sx={{ height: '40%', minHeight: 200, display: 'flex', flexDirection: 'column' }}>
                <DirectMessageList
                  dms={dms}
                  selectedDmId={viewMode === 'dms' ? selectedDmId : undefined}
                  onDmSelect={dmId => {
                    setSelectedDmId(dmId)
                    setViewMode('dms')
                  }}
                  onCreateDm={async username => {
                    const dm = await dmApi.createOrGetDm(username)
                    await loadDms()
                    setSelectedDmId(dm.id)
                    setViewMode('dms')
                  }}
                />
              </Box>
              <Divider />
            </>
          )}
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <ServerList
              servers={servers}
              selectedServerId={viewMode === 'servers' ? selectedServerName : undefined}
              onServerSelect={serverName => {
                setSelectedServerName(serverName)
                setViewMode('servers')
              }}
              onCreateServer={handleCreateServer}
              onJoinServer={handleJoinServer}
              onLeaveServer={handleLeaveServer}
              onDeleteServer={handleDeleteServer}
              onReorder={async newServers => {
                setServers(newServers)
                if (isGuest) {
                  saveGuestServers(newServers.map(s => s.name))
                } else {
                  try {
                    await serverApi.reorderServers(newServers.map(s => s.name))
                  } catch (err) {
                    console.error('Failed to reorder servers:', err)
                    showError('Failed to save server order')
                  }
                }
              }}
            />
          </Box>
        </Box>

        {/* Main Content Area */}
        {viewMode === 'servers' ? (
          <>
            {selectedServerName && (
              <ChannelList
                channels={channels}
                selectedChannelId={selectedChannelId}
                onChannelSelect={setSelectedChannelId}
                isAdmin={isAdmin}
                isSiteAdmin={user?.is_admin}
                onCreateChannel={async name => {
                  if (isGuest) {
                    showError('Please create an account')
                    return
                  }
                  await channelApi.createChannel(selectedServerName, name)
                  await loadChannels(selectedServerName)
                }}
                onDeleteChannel={async channelId => {
                  if (isGuest) return
                  await channelApi.deleteChannel(selectedServerName, channelId)
                  await loadChannels(selectedServerName)
                  setSelectedChannelId(undefined)
                }}
                onRenameChannel={async (channelId, name) => {
                  if (isGuest) return
                  await channelApi.renameChannel(selectedServerName, channelId, name)
                  await loadChannels(selectedServerName)
                }}
              />
            )}

            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {selectedServerName ? (
                selectedChannelId ? (
                  <>
                    <MessageList
                      messages={messages}
                      isAdmin={isAdmin}
                      isSiteAdmin={user?.is_admin}
                      serverName={selectedServerName}
                      onDeleteMessage={
                        !isGuest
                          ? async messageId => {
                              await messagesApi.delete('channel', selectedChannelId, messageId)
                              await loadMessages(selectedChannelId)
                            }
                          : undefined
                      }
                      onStartDm={
                        isGuest
                          ? undefined
                          : async username => {
                              const dm = await dmApi.createOrGetDm(username)
                              await loadDms()
                              setViewMode('dms')
                              setSelectedDmId(dm.id)
                            }
                      }
                    />
                    {isGuest ? (
                      <Box
                        sx={{
                          p: 2,
                          borderTop: 1,
                          borderColor: 'divider',
                          bgcolor: 'action.disabledBackground',
                        }}
                      >
                        <Typography variant="body2" color="text.secondary" align="center">
                          Create an account to send messages
                        </Typography>
                      </Box>
                    ) : (
                      <MessageInput onSend={handleSendMessage} />
                    )}
                  </>
                ) : (
                  <Box
                    sx={{
                      flex: 1,
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Typography variant="h6" color="text.secondary">
                      Select a channel to view messages
                    </Typography>
                  </Box>
                )
              ) : (
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <Typography variant="h6" color="text.secondary">
                    Select a server to view channels
                  </Typography>
                </Box>
              )}
            </Box>

            {selectedServerName && (
              <MemberList
                serverName={selectedServerName}
                currentUsername={user?.username}
                isAdmin={isAdmin}
                isSiteAdmin={user?.is_admin}
                refreshTrigger={memberRefreshTrigger}
                isGuest={isGuest}
                onStartDm={
                  isGuest
                    ? undefined
                    : async username => {
                        const dm = await dmApi.createOrGetDm(username)
                        await loadDms()
                        setViewMode('dms')
                        setSelectedDmId(dm.id)
                      }
                }
              />
            )}
          </>
        ) : (
          <>
            {selectedDmId ? (
              <DirectMessageChat
                messages={messages}
                isAdmin={false}
                isSiteAdmin={user?.is_admin}
                onSendMessage={handleSendDmMessage}
                onStartDm={async username => {
                  const dm = await dmApi.createOrGetDm(username)
                  await loadDms()
                  setSelectedDmId(dm.id)
                }}
                onDeleteMessage={
                  !isGuest
                    ? async messageId => {
                        await messagesApi.delete('direct_message', selectedDmId, messageId)
                        const list = await messagesApi.get('direct_message', selectedDmId)
                        setMessages(list.reverse())
                      }
                    : undefined
                }
              />
            ) : (
              <Box
                sx={{
                  flex: 1,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Typography variant="h6" color="text.secondary">
                  Select a DM to view messages
                </Typography>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}
