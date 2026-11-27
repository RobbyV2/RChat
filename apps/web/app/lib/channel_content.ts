import type { Channel } from './types'
import type { RChatState } from './store_types'

type Places = Pick<RChatState, 'servers' | 'panel' | 'view'>

// The hosted channel a draft key writes to: the channel itself, or the open thread's channel.
export function destinationChannel(
  s: Places,
  key: string | null
): { server: string; channel: Channel } | null {
  if (!key) return null
  const id = key.startsWith('c')
    ? Number(key.slice(1))
    : s.panel?.kind === 'thread' && key === `t${s.panel.root.id}`
      ? s.panel.root.channel_id
      : null
  if (id == null) return null
  if (s.view?.kind === 'channel') {
    const current = s.servers[s.view.server]?.channels.find(c => c.id === id)
    if (current) return { server: s.view.server, channel: current }
  }
  for (const [server, detail] of Object.entries(s.servers)) {
    const channel = detail.channels.find(c => c.id === id)
    if (channel) return { server, channel }
  }
  return null
}

export const textOnlyDestination = (s: Places, key: string | null) =>
  destinationChannel(s, key)?.channel.text_only === true
