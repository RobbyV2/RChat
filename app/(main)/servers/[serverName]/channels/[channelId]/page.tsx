import { Metadata } from 'next'
import Dashboard from '@/app/components/dashboard/Dashboard'
import { publicApi } from '@/app/lib/api'

interface Props {
  params: Promise<{
    serverName: string
    channelId: string
  }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { serverName: rawServerName, channelId } = await params
  const serverName = decodeURIComponent(rawServerName)
  let description = `Check out the latest messages in #${channelId} on ${serverName}.`

  try {
    const messages = await publicApi.getMessages(channelId, 5)

    if (Array.isArray(messages) && messages.length > 0) {
      const messagePreviews = messages
        .map(
          (m: any) =>
            `${m.sender_username}: ${m.content.substring(0, 50)}${m.content.length > 50 ? '...' : ''}`
        )
        .join('\n')
      description = `Last messages in #${channelId}:\n${messagePreviews}`
    }
  } catch (err) {
    console.error('Error fetching metadata:', err)
  }

  return {
    title: `#${channelId} in ${serverName} | RChat`,
    description: description,
    openGraph: {
      title: `#${channelId} in ${serverName} | RChat`,
      description: description,
    },
  }
}

export default async function ChannelPage({ params }: Props) {
  const { serverName, channelId } = await params
  return (
    <Dashboard initialServerName={decodeURIComponent(serverName)} initialChannelId={channelId} />
  )
}
