export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: any
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }))
    const errorMessage = error.message || error.error || response.statusText

    if (
      response.status === 401 &&
      (errorMessage.includes('Invalid token') ||
        errorMessage.includes('expired') ||
        errorMessage.includes('malformed') ||
        errorMessage.includes('Auth error') ||
        errorMessage.includes('User no longer exists'))
    ) {
      console.warn('Authentication token invalid, clearing session and redirecting to login')
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('user')
        localStorage.removeItem('rchat_guest_mode')

        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/login'
        }
        window.dispatchEvent(new Event('auth:unauthorized'))
      }
    }

    throw new ApiError(errorMessage, response.status, error)
  }

  return response.json()
}

const getAuthHeaders = (): HeadersInit => {
  if (typeof window === 'undefined') return {}
  const token = localStorage.getItem('auth_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface UserResponse {
  username: string
  profile_type: string
  avatar_color?: string
  created_at: string
  is_admin: boolean
}

export interface RegisterRequest {
  username: string
  password?: string
  word_sequence?: string[]
  profile_type: string
  avatar_color?: string
}

export interface RegisterResponse {
  user: UserResponse
  token: string
  word_sequence?: string[]
}

export interface LoginRequest {
  username: string
  password?: string
  word_sequence?: string[]
}

export interface LoginResponse {
  user: UserResponse
  token: string
}

export const authApi = {
  async getWordSequence(username: string): Promise<string[]> {
    const response = await fetch(`/api/auth/word-sequence?username=${encodeURIComponent(username)}`)
    return handleResponse<string[]>(response)
  },

  async register(data: RegisterRequest): Promise<RegisterResponse> {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await handleResponse<RegisterResponse>(response)
    if (result.token) {
      localStorage.setItem('auth_token', result.token)
      localStorage.setItem('user', JSON.stringify(result.user))
    }
    return result
  },

  async login(data: LoginRequest): Promise<LoginResponse> {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await handleResponse<LoginResponse>(response)
    if (result.token) {
      localStorage.setItem('auth_token', result.token)
      localStorage.setItem('user', JSON.stringify(result.user))
    }
    return result
  },

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    localStorage.removeItem('auth_token')
    localStorage.removeItem('user')
  },

  getCurrentUser(): UserResponse | null {
    if (typeof window === 'undefined') return null
    const user = localStorage.getItem('user')
    return user ? JSON.parse(user) : null
  },

  getToken(): string | null {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('auth_token')
  },

  isAuthenticated(): boolean {
    return !!this.getToken()
  },

  getAuthHeaders,
}

export interface FileAttachment {
  file_id: string
  original_name: string
  content_type: string
  size: number
}

export interface Message {
  id: string
  channel_id?: string
  dm_id?: string
  sender_username: string
  content: string
  filtered_content?: string
  content_type: string
  created_at: string
  filter_status: string
  attachments?: FileAttachment[]
  sender_profile_type?: string
  sender_avatar_color?: string
}

export interface Server {
  name: string
  creator_username: string
  created_at: string
  member_count: number
  channel_count: number
}

export interface Channel {
  id: string
  server_name: string
  name: string
  created_at: string
  message_count: number
  position: number
}

export const messagesApi = {
  async send(
    targetType: 'channel' | 'direct_message',
    targetId: string,
    content: string,
    contentType: 'text' | 'markdown' = 'text',
    fileId?: string
  ): Promise<Message> {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_type: targetType,
        target_id: targetId,
        content,
        content_type: contentType,
        file_id: fileId,
      }),
    })
    return handleResponse<Message>(response)
  },

  async get(
    targetType: 'channel' | 'direct_message',
    targetId: string,
    limit = 50,
    offset = 0
  ): Promise<Message[]> {
    const response = await fetch(
      `/api/messages?target_type=${targetType}&target_id=${targetId}&limit=${limit}&offset=${offset}`,
      { headers: getAuthHeaders() }
    )
    return handleResponse<Message[]>(response)
  },

  async delete(
    targetType: 'channel' | 'direct_message',
    targetId: string,
    messageId: string
  ): Promise<void> {
    const path =
      targetType === 'channel'
        ? `/api/messages/channels/${targetId}/messages/${messageId}`
        : `/api/messages/dms/${targetId}/messages/${messageId}`

    const response = await fetch(path, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
    await handleResponse<void>(response)
  },
}

export interface ServerMember {
  server_name: string
  username: string
  role: 'member' | 'admin'
  joined_at: string
  last_seen: string
  is_online: number
  profile_type?: string
  avatar_color?: string
}

export const serverApi = {
  async createServer(name: string): Promise<Server> {
    const response = await fetch('/api/servers', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return handleResponse<Server>(response)
  },

  async joinServer(serverName: string): Promise<Server> {
    const response = await fetch('/api/servers/join', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_name: serverName }),
    })
    return handleResponse<Server>(response)
  },

  async listServers(): Promise<Server[]> {
    const response = await fetch('/api/servers', {
      headers: getAuthHeaders(),
    })
    return handleResponse<Server[]>(response)
  },

  async reorderServers(serverNames: string[]): Promise<void> {
    const response = await fetch('/api/servers/reorder', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_names: serverNames }),
    })
    await handleResponse<void>(response)
  },

  async listMembers(serverName: string): Promise<ServerMember[]> {
    const response = await fetch(`/api/servers/${serverName}/members`, {
      headers: getAuthHeaders(),
    })
    return handleResponse<ServerMember[]>(response)
  },

  async removeMember(serverName: string, username: string): Promise<void> {
    const response = await fetch(`/api/servers/${serverName}/members/${username}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
    await handleResponse<void>(response)
  },

  async updateMemberRole(
    serverName: string,
    username: string,
    role: 'member' | 'admin'
  ): Promise<void> {
    const response = await fetch(`/api/servers/${serverName}/members/${username}`, {
      method: 'PATCH',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    await handleResponse<void>(response)
  },

  async transferOwnership(serverName: string, newOwner: string): Promise<void> {
    const response = await fetch(`/api/servers/${serverName}/transfer-ownership`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner: newOwner }),
    })
    await handleResponse<void>(response)
  },

  async deleteServer(serverName: string): Promise<void> {
    const response = await fetch(`/api/servers/${serverName}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
    await handleResponse<void>(response)
  },
}

export const channelApi = {
  async createChannel(serverName: string, name: string): Promise<Channel> {
    const response = await fetch(`/api/channels/servers/${serverName}/channels`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return handleResponse<Channel>(response)
  },

  async listChannels(serverName: string): Promise<Channel[]> {
    const response = await fetch(`/api/channels/servers/${serverName}/channels`, {
      headers: getAuthHeaders(),
    })
    return handleResponse<Channel[]>(response)
  },

  async deleteChannel(serverName: string, channelId: string): Promise<void> {
    const response = await fetch(`/api/channels/servers/${serverName}/channels/${channelId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
    await handleResponse<void>(response)
  },

  async renameChannel(serverName: string, channelId: string, name: string): Promise<Channel> {
    const response = await fetch(`/api/channels/servers/${serverName}/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return handleResponse<Channel>(response)
  },
}

export interface FileMetadata {
  id: string
  original_name: string
  file_name: string
  content_type: string
  size: number
  file_hash: string
  upload_time: string
  expires_at?: string
  download_count: number
  uploader_id: string
  is_deleted: number
}

export const fileApi = {
  async uploadFile(name: string, contentType: string, data: string): Promise<FileMetadata> {
    const response = await fetch('/api/files/files', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content_type: contentType, data }),
    })
    return handleResponse(response)
  },

  async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`/api/files/files/${fileId}`, {
      headers: getAuthHeaders(),
    })
    if (!response.ok) {
      throw new ApiError('Failed to download file', response.status)
    }
    return response.blob()
  },

  async listFiles(): Promise<FileMetadata[]> {
    const response = await fetch('/api/files/files', {
      headers: getAuthHeaders(),
    })
    return handleResponse(response)
  },

  async deleteFile(fileId: string): Promise<{ success: boolean }> {
    const response = await fetch(`/api/files/files/${fileId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
    return handleResponse(response)
  },
}

export interface DirectMessage {
  id: string
  username1: string
  username2: string
  created_at: string
  last_message_at?: string
  message_count: number
}

export const dmApi = {
  async createOrGetDm(otherUsername: string): Promise<DirectMessage> {
    const response = await fetch('/api/dms', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ other_username: otherUsername }),
    })
    return handleResponse<DirectMessage>(response)
  },

  async listDms(): Promise<DirectMessage[]> {
    const response = await fetch('/api/dms', {
      headers: getAuthHeaders(),
    })
    return handleResponse<DirectMessage[]>(response)
  },
}

const getBaseUrl = () => {
  if (typeof window !== 'undefined') return ''
  return process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3000'
}

export const publicApi = {
  async lookupServer(name: string): Promise<Server> {
    const response = await fetch(`${getBaseUrl()}/api/public/servers/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_name: name }),
    })
    return handleResponse<Server>(response)
  },

  async getChannels(serverName: string): Promise<Channel[]> {
    const response = await fetch(`${getBaseUrl()}/api/public/servers/${serverName}/channels`)
    return handleResponse<Channel[]>(response)
  },

  async getMessages(channelId: string, limit = 50, offset = 0): Promise<Message[]> {
    const response = await fetch(
      `${getBaseUrl()}/api/public/channels/${channelId}/messages?limit=${limit}&offset=${offset}`
    )
    return handleResponse<Message[]>(response)
  },
}
