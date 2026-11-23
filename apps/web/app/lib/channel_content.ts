import type { RChatState } from './store_types'

export function textOnlyDestination(
  s: Pick<RChatState, 'servers' | 'panel' | 'view'>,
  key: string | null
) {
  if (!key) return false
  const id = key.startsWith('c')
    ? Number(key.slice(1))
    : s.panel?.kind === 'thread' && key === `t${s.panel.root.id}`
      ? s.panel.root.channel_id
      : null
  if (id == null) return false
  if (s.view?.kind === 'channel') {
    const current = s.servers[s.view.server]?.channels.find(c => c.id === id)
    if (current) return current.text_only === true
  }
  return Object.values(s.servers).some(server =>
    server.channels.some(c => c.id === id && c.text_only)
  )
}
