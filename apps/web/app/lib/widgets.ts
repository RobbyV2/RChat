import type { Message } from './types'
export type WidgetMode = 'public_read' | 'public_chat' | 'members' | 'read_link' | 'voice'

export interface WidgetConfig {
  channel_id: number
  mode: WidgetMode
  composer: boolean
  enabled: boolean
  origins: string[]
}
export interface Widget extends WidgetConfig {
  id: string
  server: string
  read_key?: string
}
export interface WidgetRoomMetadata {
  server: string
  channel_id: number
  kind: 'text' | 'voice'
  sensitive?: boolean
}
export interface WidgetRoom extends WidgetRoomMetadata {
  name: string
  participate: boolean
  messages: Message[]
  users: string[]
}
export function widgetUrl(origin: string, widget: Widget) {
  const url = new URL('/widget/', origin)
  url.searchParams.set('id', widget.id)
  if (widget.read_key) url.hash = new URLSearchParams({ key: widget.read_key }).toString()
  return url.toString()
}
export function embedCode(url: string, voice: boolean) {
  return `<iframe src="${url}" title="${voice ? 'Voice room' : 'Channel chat'}" width="400" height="480" style="max-width:100%;border:0"${voice ? ' allow="microphone"' : ''}></iframe>`
}
export function parentOrigin() {
  if (window.parent === window) return location.origin
  const parent = location.ancestorOrigins?.[0] || document.referrer
  return parent ? new URL(parent).origin : null
}
