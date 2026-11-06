import type { LucideIcon } from 'lucide-react'
import type { Folder } from '../nav_layout'
import type { PaletteGroup } from '../palette'
import type { RChatState } from '../store_types'
import type { Category, Channel, DmSummary, Message, UserRef } from '../types'

export type Scope =
  | 'global'
  | 'server'
  | 'channel'
  | 'message'
  | 'member'
  | 'dm'
  | 'voice'
  | 'p2p'
  | 'report'
  | 'admin'

export type Via = 'menu' | 'palette' | 'key' | 'bar'

export type Args = Record<string, string>

export type MemberWhere =
  'list' | 'author' | 'friend' | 'request' | 'interacted' | 'dm' | 'profile' | 'palette'

export type Target =
  | { kind: 'none' }
  | { kind: 'message'; message: Message; list: string }
  | { kind: 'selection'; list: string }
  | { kind: 'member'; user: UserRef; server: string | null; where: MemberWhere }
  | { kind: 'server'; server: string; folder: string | null; at: number }
  | { kind: 'folder'; folder: Folder }
  | { kind: 'channel'; server: string; channel: Channel }
  | { kind: 'category'; server: string; category: Category }
  | { kind: 'dm'; dm: DmSummary; where: 'sidebar' | 'home' }
  // The rail's home button and the instance badge.
  | { kind: 'home' }

export interface ActionCtx {
  s: RChatState
  via: Via
  target: Target
  // The target's place, else the open one.
  server: string | null
  channel: Channel | null
  dm: DmSummary | null
  // The message list: the target message's, else the open thread, channel or DM.
  list: string | null
  message: Message | null
  // The target member, a message target's author unless a webhook, else the open profile card's.
  member: UserRef | null
}

export interface ArgChoice {
  value: string
  label: string
  subtitle?: string
  icon?: LucideIcon
  checked?: boolean
  radio?: boolean
  disabled?: boolean
  danger?: boolean
  name?: boolean
  wrap?: boolean
}

export type ArgStep =
  | {
      kind: 'choice'
      name: string
      prompt: string
      choices(ctx: ActionCtx, q: string): ArgChoice[]
    }
  | {
      kind: 'text'
      name: string
      prompt: string
      check?(text: string, ctx: ActionCtx): string | null
    }
  | { kind: 'confirm'; title: string; body(ctx: ActionCtx, args: Args): string; confirm: string }

export interface Action<A extends Args = Args> {
  id: string
  title: string
  keywords?: string[]
  icon?: LucideIcon
  scope: Scope
  available(ctx: ActionCtx): boolean
  run(ctx: ActionCtx, args: A): void | Promise<void>
  args?: ArgStep[]
  danger?: boolean
  // The menus, palette contexts and row lists it joins; none: the palette and keys only.
  targets?: readonly Target['kind'][]
  // Text for this context; `title` stays the static, searchable name.
  label?(ctx: ActionCtx): string
  subtitle?(ctx: ActionCtx): string | undefined
  wrap?: boolean
  // The label is a name (blurred in streamer mode).
  name?: boolean
  // Menu position, default 500; ties keep registration order.
  order?: number
  group?: PaletteGroup
  // A built-in shortcut, as in SHORTCUTS.
  hint?: string
  disabled?(ctx: ActionCtx): boolean
  checked?(ctx: ActionCtx): boolean
  radio?: boolean
  // false: in its targets' palette context and row lists, not in their context menus.
  menu?: boolean
  // What a menu row does instead of asking the steps.
  menuRun?(ctx: ActionCtx): void
  keepOpen?: boolean
  slash?: string
  parse?(text: string): string | null
}
