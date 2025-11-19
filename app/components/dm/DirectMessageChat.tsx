'use client'

import { Box } from '@mui/material'
import MessageList from '../chat/MessageList'
import MessageInput from '../chat/MessageInput'
import type { Message } from '@/app/lib/api'

interface DirectMessageChatProps {
  messages: Message[]
  onSendMessage: (content: string, fileId?: string) => Promise<void>
  onStartDm?: (username: string) => Promise<void>
  onDeleteMessage?: (messageId: string) => Promise<void>
  isAdmin?: boolean
  isSiteAdmin?: boolean
}

export default function DirectMessageChat({
  messages,
  onSendMessage,
  onStartDm,
  onDeleteMessage,
  isAdmin,
  isSiteAdmin,
}: DirectMessageChatProps) {
  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <MessageList
        messages={messages}
        onStartDm={onStartDm}
        onDeleteMessage={onDeleteMessage}
        isAdmin={isAdmin}
        isSiteAdmin={isSiteAdmin}
      />
      <MessageInput onSend={onSendMessage} />
    </Box>
  )
}
