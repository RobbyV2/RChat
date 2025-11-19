import { Metadata } from 'next'
import Dashboard from '@/app/components/dashboard/Dashboard'
import { publicApi } from '@/app/lib/api'

interface Props {
  params: Promise<{
    serverName: string
  }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { serverName: rawServerName } = await params
  const serverName = decodeURIComponent(rawServerName)
  let description = `Join the conversation in ${serverName} on RChat.`

  try {
    // We can check if the server exists or get basic info to populate metadata better
    const server = await publicApi.lookupServer(serverName)
    if (server) {
      description = `Join ${server.member_count} members in ${serverName} on RChat.`
    }

    const channels = await publicApi.getChannels(serverName)

    if (Array.isArray(channels) && channels.length > 0) {
      const firstChannel = channels[0]

      const messages = await publicApi.getMessages(firstChannel.id, 5)

      if (Array.isArray(messages) && messages.length > 0) {
        const messagePreviews = messages
          .map(
            (m: any) =>
              `${m.sender_username}: ${m.content.substring(0, 50)}${m.content.length > 50 ? '...' : ''}`
          )
          .join('\n')
        description = `${description}\n\nLast messages:\n${messagePreviews}`
      }
    }
  } catch (err) {
    console.error('Error fetching metadata:', err)
  }

  return {
    title: `${serverName} | RChat`,
    description: description,
    openGraph: {
      title: `${serverName} | RChat`,
      description: description,
    },
  }
}

export default async function ServerPage({ params }: Props) {
  const { serverName } = await params
  return <Dashboard initialServerName={decodeURIComponent(serverName)} />
}
