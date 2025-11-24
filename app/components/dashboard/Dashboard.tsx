'use client'

import { useState, useEffect } from 'react'
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Button,
  CircularProgress,
  Chip,
  Alert,
  AlertTitle,
  Divider,
} from '@mui/material'
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
import { authApi, serverApi, channelApi, messagesApi, dmApi, publicApi } from '@/app/lib/api'
import type { Server, Channel, Message, DirectMessage, ServerMember } from '@/app/lib/api'
import { useWebSocket } from '@/app/lib/websocket'
import { useNotifications, queueNotification } from '@/app/lib/notifications'

interface DashboardProps {
  isGuest?: boolean
  onLogout?: () => void
  onCreateAccount?: () => void
  initialServerName?: string
  initialChannelId?: string
  initialDmId?: string
  initialViewMode?: 'servers' | 'dms'
}

const GUEST_SERVERS_KEY = 'rchat_guest_servers'
const LAST_VISITED_KEY = 'rchat_last_visited'

export default function Dashboard({
  isGuest = false,
  onLogout,
  onCreateAccount,
  initialServerName,
  initialChannelId,
  initialDmId,
  initialViewMode,
}: DashboardProps) {
  const [servers, setServers] = useState<Server[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedServerName, setSelectedServerName] = useState<string | undefined>(
    initialServerName
  )
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(initialChannelId)
  const [viewMode, setViewMode] = useState<'servers' | 'dms'>(
    initialViewMode || (initialDmId ? 'dms' : 'servers')
  )
  const [dms, setDms] = useState<DirectMessage[]>([])
  const [selectedDmId, setSelectedDmId] = useState<string | undefined>(initialDmId)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [wsUrl, setWsUrl] = useState<string>('')
  const [members, setMembers] = useState<ServerMember[]>([])
  const [showAdminPanel, setShowAdminPanel] = useState(false)
  const [isGuestState, setIsGuestState] = useState(isGuest)
  const { showError, showSuccess } = useNotifications()

  useEffect(() => {
    const checkAdminParam = () => {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search)
        setShowAdminPanel(params.get('admin') === 'true')
      }
    }

    checkAdminParam()
    window.addEventListener('popstate', checkAdminParam)
    return () => window.removeEventListener('popstate', checkAdminParam)
  }, [])

  const handleOpenAdmin = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('admin', 'true')
    window.history.pushState(null, '', url.toString())
    setShowAdminPanel(true)
  }

  const handleCloseAdmin = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('admin')
    window.history.pushState(null, '', url.toString())
    setShowAdminPanel(false)
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const guest = localStorage.getItem('rchat_guest_mode') === 'true'
      if (!isGuest && guest) {
        setIsGuestState(true)
      } else if (
        !isGuest &&
        !guest &&
        !authApi.isAuthenticated() &&
        window.location.pathname !== '/'
      ) {
        window.location.href = '/'
      }

      const handleUnauthorized = () => {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('user')
        localStorage.removeItem('rchat_guest_mode')
        queueNotification({
          message: 'Your session has expired. Please log in again.',
          type: 'error',
        })
        window.location.href = '/login'
      }

      window.addEventListener('auth:unauthorized', handleUnauthorized)
      return () => window.removeEventListener('auth:unauthorized', handleUnauthorized)
    }
  }, [isGuest, onLogout])

  const user = isGuestState ? null : authApi.getCurrentUser()
  const { isConnected, connectionStatus, lastMessage, reconnectAttempts } = useWebSocket(wsUrl)

  useEffect(() => {
    if (typeof window === 'undefined') return

    let url = '/'
    if (viewMode === 'servers' && selectedServerName) {
      url = `/servers/${selectedServerName}`
      if (selectedChannelId) {
        url += `/channels/${selectedChannelId}`
      }
      localStorage.setItem(
        LAST_VISITED_KEY,
        JSON.stringify({
          type: 'server',
          serverName: selectedServerName,
          channelId: selectedChannelId,
        })
      )
    } else if (viewMode === 'dms' && selectedDmId) {
      url = `/dms/${selectedDmId}`
      localStorage.setItem(LAST_VISITED_KEY, JSON.stringify({ type: 'dm', dmId: selectedDmId }))
    } else if (viewMode === 'dms') {
      url = '/dms'
    }

    if (window.location.pathname !== url && !url.includes('undefined')) {
      window.history.replaceState(null, '', url)
    }
  }, [selectedServerName, selectedChannelId, selectedDmId, viewMode])

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

  const loadServers = async () => {
    let currentServers: Server[] = []

    const effectiveGuest =
      isGuest ||
      (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')

    if (effectiveGuest) {
      const storedServerNames = getGuestServers()
      if (initialServerName && !storedServerNames.includes(initialServerName)) {
        storedServerNames.push(initialServerName)
      }

      const serverDataPromises = storedServerNames.map(async name => {
        try {
          return await publicApi.lookupServer(name)
        } catch (err: any) {
          if (err?.status === 404 || err?.message?.includes('Not Found')) {
            return null
          }
          console.error(`Failed to fetch server ${name}:`, err)
        }
        return { name, creator_username: '', created_at: '', member_count: 0, channel_count: 0 }
      })

      const resolved = await Promise.all(serverDataPromises)
      const validServers = resolved.filter((s): s is Server => s !== null && s.created_at !== '')

      if (validServers.length !== storedServerNames.length) {
        saveGuestServers(validServers.map(s => s.name))
      }

      currentServers = validServers
      setServers(validServers)

      if (initialServerName && !validServers.some(s => s.name === initialServerName)) {
        console.warn(`Initial server ${initialServerName} not found/valid, falling back.`)
        if (validServers.length > 0) {
          setSelectedServerName(validServers[0].name)
        } else {
          setSelectedServerName(undefined)
        }
      }
    } else {
      try {
        const serverList = await serverApi.listServers()
        if (
          initialServerName &&
          !serverList.some(s => s.name === initialServerName) &&
          initialServerName !== 'RChat'
        ) {
          try {
            await serverApi.joinServer(initialServerName)
            const updatedList = await serverApi.listServers()
            currentServers = updatedList
            setServers(updatedList)
          } catch (err: any) {
            console.error('Failed to auto-join server:', err)
            currentServers = serverList
            setServers(serverList)
            if (initialServerName) {
              // Use the specific error message from the API if available, fallback to generic
              const errorMessage =
                err?.message || err?.error || `Failed to join server: ${initialServerName}`
              showError(errorMessage)
              setSelectedServerName(undefined)
            }
          }
        } else {
          currentServers = serverList
          setServers(serverList)
        }
      } catch (err) {
        console.error('Failed to load servers:', err)
      }
    }

    if (initialServerName && currentServers.some(s => s.name === initialServerName)) {
      setSelectedServerName(initialServerName)
    } else if (initialDmId) {
      setViewMode('dms')
      setSelectedDmId(initialDmId)
    } else if (!selectedServerName && !selectedDmId) {
      if (
        typeof window !== 'undefined' &&
        window.location.pathname === '/' &&
        localStorage.getItem(LAST_VISITED_KEY)
      ) {
        try {
          const lastVisited = JSON.parse(localStorage.getItem(LAST_VISITED_KEY) || '{}')
          if (lastVisited.type === 'server' && lastVisited.serverName) {
            if (currentServers.some(s => s.name === lastVisited.serverName)) {
              setSelectedServerName(lastVisited.serverName)
              if (lastVisited.channelId) {
                setSelectedChannelId(lastVisited.channelId)
              }
            } else if (currentServers.length > 0) {
              setSelectedServerName(currentServers[0].name)
            }
          } else if (lastVisited.type === 'dm' && lastVisited.dmId) {
            setViewMode('dms')
            setSelectedDmId(lastVisited.dmId)
          } else if (currentServers.length > 0) {
            setSelectedServerName(currentServers[0].name)
          }
        } catch (e) {
          console.error('Error parsing last visited:', e)
          if (currentServers.length > 0) setSelectedServerName(currentServers[0].name)
        }
      } else if (currentServers.length > 0) {
        setSelectedServerName(currentServers[0].name)
      }
    }
  }

  const loadChannels = async (serverName: string) => {
    const effectiveGuest =
      isGuest ||
      (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')

    try {
      const channelList: Channel[] = effectiveGuest
        ? await publicApi.getChannels(serverName)
        : await channelApi.listChannels(serverName)

      setChannels(channelList)
      if (channelList.length > 0) {
        setSelectedChannelId(prev => {
          const targetId = prev
          const exists = channelList.some(c => c.id === targetId)
          return exists ? targetId : channelList[0].id
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
    const effectiveGuest =
      isGuest ||
      (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')

    try {
      const messageList = effectiveGuest
        ? await publicApi.getMessages(channelId)
        : await messagesApi.get('channel', channelId)

      setMessages(messageList.reverse())
    } catch (err) {
      console.error('Failed to load messages:', err)
      showError('Failed to load messages')
    }
  }

  const loadMembers = async (serverName: string) => {
    const effectiveGuest =
      isGuest ||
      (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')

    try {
      let memberList: ServerMember[]
      if (effectiveGuest) {
        const response = await fetch(`/api/public/servers/${serverName}/members`)
        memberList = response.ok ? await response.json() : []
      } else {
        memberList = await serverApi.listMembers(serverName)
      }
      setMembers(memberList)
    } catch (err) {
      console.error('Failed to load members:', err)
      setMembers([])
    }
  }

  const loadDms = async () => {
    const effectiveGuest =
      isGuest ||
      (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')
    if (effectiveGuest) return

    try {
      const dmList = await dmApi.listDms()
      setDms(dmList)
    } catch (err) {
      console.error('Failed to load DMs:', err)
    }
  }

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setWsUrl(`ws://${window.location.host}/api/ws`)
    }
  }, [isGuestState])

  useEffect(() => {
    const init = async () => {
      await loadServers()
      const effectiveGuest =
        isGuest ||
        (typeof window !== 'undefined' && localStorage.getItem('rchat_guest_mode') === 'true')
      if (!effectiveGuest) {
        await loadDms()
      }
      setLoading(false)
    }
    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedServerName && servers.length > 0 && !loading) {
      const exists = servers.some(s => s.name === selectedServerName)
      if (!exists) {
        const fallback = servers.find(s => s.name === 'RChat') || servers[0]
        setSelectedServerName(fallback.name)
        showError(`You are no longer a member of ${selectedServerName}`)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, loading])

  useEffect(() => {
    if (!selectedServerName) return

    const loadData = async () => {
      await loadChannels(selectedServerName)
      await loadMembers(selectedServerName)

      if (!isGuestState && user) {
        if (user.is_admin) {
          setIsAdmin(true)
        } else {
          const memberList = await serverApi.listMembers(selectedServerName)
          const currentMember = memberList.find(m => m.username === user.username)
          setIsAdmin(currentMember?.role === 'admin')
        }
      }
    }

    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServerName])

  useEffect(() => {
    if (!selectedChannelId) return
    setMessages([])
    loadMessages(selectedChannelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId])

  useEffect(() => {
    if (!selectedDmId) return
    setMessages([])

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
          setMembers(prev =>
            prev.map(m =>
              m.username === msg.username ? { ...m, is_online: msg.is_online ? 1 : 0 } : m
            )
          )
        }
        break

      case 'user_banned':
        setMessages(prev => prev.filter(m => m.sender_username !== msg.username))
        setMembers(prev => prev.filter(m => m.username !== msg.username))

        if (user && msg.username === user.username) {
          localStorage.removeItem('auth_token')
          localStorage.removeItem('user')
          localStorage.removeItem('rchat_guest_mode')
          queueNotification({ message: 'You have been banned.', type: 'error' })
          window.location.href = '/login'
        }
        break

      case 'server_created':
        loadServers()
        break

      case 'server_member_joined':
        loadServers()
        if (msg.server_name === selectedServerName) {
          setMembers(prev => {
            if (prev.some(m => m.username === msg.username)) return prev
            return [
              ...prev,
              {
                server_name: msg.server_name,
                username: msg.username,
                role: 'member',
                joined_at: new Date().toISOString(),
                is_online: 1,
                last_seen: new Date().toISOString(),
              } as ServerMember,
            ]
          })
        }
        break

      case 'server_member_left':
        loadServers()
        if (msg.server_name === selectedServerName) {
          if (user && msg.username === user.username) {
            setSelectedServerName('RChat')
            showError('You have been removed from the server.')
          }
          setMembers(prev => prev.filter(m => m.username !== msg.username))
        }
        break

      case 'server_member_role_updated':
        if (msg.server_name === selectedServerName) {
          setMembers(prev =>
            prev.map(m => (m.username === msg.username ? { ...m, role: msg.new_role } : m))
          )
          if (user && msg.username === user.username) {
            showSuccess(`Your role has been updated to ${msg.new_role}`)
            // Trigger a reload of channels/permissions if needed
            // We can just toggle admin state if we want, but a full reload is safer
            // Actually isAdmin is calculated in useEffect[selectedServerName], so toggling server might help?
            // Or we can just force re-check.
            // We'll just rely on the fact that next action will check it, or user refreshes.
            // But for better UX, we could reload channels.
            if (selectedServerName) loadChannels(selectedServerName)
          } else {
            // Optional: toast for others
          }
        }
        break

      case 'server_deleted':
        if (isGuestState) {
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

      case 'file_downloaded':
        setMessages(prev =>
          prev.map(message => {
            if (!message.attachments) return message
            const updatedAttachments = message.attachments.map(att =>
              att.file_id === msg.file_id ? { ...att, download_count: msg.download_count } : att
            )
            const hasChange = message.attachments.some(
              (att, i) =>
                att.file_id === msg.file_id &&
                att.download_count !== updatedAttachments[i].download_count
            )
            return hasChange ? { ...message, attachments: updatedAttachments } : message
          })
        )
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage, selectedChannelId, selectedServerName, selectedDmId, viewMode])

  // Event handlers
  const handleSendMessage = async (content: string, fileId?: string) => {
    if (isGuestState) {
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
    if (isGuestState) {
      showError('Please create an account to create servers')
      return
    }

    await serverApi.createServer(name)
    await loadServers()
  }

  const handleJoinServer = async (name: string) => {
    if (isGuestState) {
      try {
        const server = await publicApi.lookupServer(name)
        const storedServerNames = getGuestServers()

        if (storedServerNames.includes(server.name)) {
          showError('Already joined this server')
          return
        }

        saveGuestServers([...storedServerNames, server.name])
        await loadServers()
        showSuccess('Joined server successfully')
      } catch (err: any) {
        const msg = err?.message || 'Failed to join server'
        if (msg.includes('Not Found') || err?.status === 404) {
          showError('Server not found')
        } else {
          showError(msg)
        }
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
    return <AdminPanel onClose={handleCloseAdmin} />
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" sx={{ mr: 2 }}>
            RChat{isGuestState ? ' - Guest Mode' : ` - ${user?.username}`}
          </Typography>
          {!isGuestState && user?.is_admin && (
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
                onClick={handleOpenAdmin}
                sx={{ mr: 2 }}
              >
                Admin Panel
              </Button>
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <ConnectionStatus status={connectionStatus} reconnectAttempts={reconnectAttempts} />
          <LocalTime />
          <Button color="inherit" onClick={isGuestState ? onCreateAccount : onLogout}>
            {isGuestState ? 'Create Account' : 'Logout'}
          </Button>
        </Toolbar>
      </AppBar>

      {isGuestState && (
        <Alert severity="info" sx={{ m: 1 }}>
          <AlertTitle>Guest Mode</AlertTitle>
          You are viewing in read-only mode. Create an account to send messages.
        </Alert>
      )}

      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Box
          sx={{
            width: 250,
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {!isGuestState && (
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
                if (isGuestState) {
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
                  if (isGuestState) {
                    showError('Please create an account')
                    return
                  }
                  await channelApi.createChannel(selectedServerName, name)
                  await loadChannels(selectedServerName)
                }}
                onDeleteChannel={async channelId => {
                  if (isGuestState) return
                  await channelApi.deleteChannel(selectedServerName, channelId)
                  await loadChannels(selectedServerName)
                  setSelectedChannelId(undefined)
                }}
                onRenameChannel={async (channelId, name) => {
                  if (isGuestState) return
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
                        !isGuestState
                          ? async messageId => {
                              await messagesApi.delete('channel', selectedChannelId, messageId)
                              await loadMessages(selectedChannelId)
                            }
                          : undefined
                      }
                      onStartDm={
                        isGuestState
                          ? undefined
                          : async username => {
                              const dm = await dmApi.createOrGetDm(username)
                              await loadDms()
                              setViewMode('dms')
                              setSelectedDmId(dm.id)
                            }
                      }
                    />
                    {isGuestState ? (
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
                isCreator={
                  user?.username ===
                  servers.find(s => s.name === selectedServerName)?.creator_username
                }
                members={members}
                isGuest={isGuestState}
                onStartDm={
                  isGuestState
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
                  !isGuestState
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
