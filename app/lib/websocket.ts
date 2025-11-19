import { useEffect, useRef, useState } from 'react'

export interface ServerMessage {
  type: string
  [key: string]: any
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface WebSocketHook {
  isConnected: boolean
  connectionStatus: ConnectionStatus
  sendMessage: (message: any) => void
  lastMessage: ServerMessage | null
  reconnectAttempts: number
}

const MAX_RECONNECT_DELAY = 30000
const INITIAL_RECONNECT_DELAY = 1000

export function useWebSocket(url: string): WebSocketHook {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const shouldReconnectRef = useRef(true)

  useEffect(() => {
    if (!url) return

    shouldReconnectRef.current = true
    connect()

    return () => {
      shouldReconnectRef.current = false
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const connect = () => {
    if (!shouldReconnectRef.current || !url) return

    setConnectionStatus('connecting')

    const token = localStorage.getItem('auth_token')
    const wsUrlWithAuth = token ? `${url}?token=${token}` : url

    const ws = new WebSocket(wsUrlWithAuth)

    ws.onopen = () => {
      setConnectionStatus('connected')
      setReconnectAttempts(0)
      console.log('WebSocket connected')
    }

    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        setLastMessage(message)
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err)
      }
    }

    ws.onerror = error => {
      console.error('WebSocket error:', error)
    }

    ws.onclose = () => {
      setConnectionStatus('disconnected')
      console.log('WebSocket disconnected')

      if (shouldReconnectRef.current) {
        const delay = Math.min(
          INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
          MAX_RECONNECT_DELAY
        )
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`)

        setReconnectAttempts(prev => prev + 1)
        reconnectTimeoutRef.current = setTimeout(connect, delay)
      }
    }

    wsRef.current = ws
  }

  const sendMessage = (message: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    sendMessage,
    lastMessage,
    reconnectAttempts,
  }
}
