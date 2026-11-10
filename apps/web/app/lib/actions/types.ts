import type { LucideIcon } from 'lucide-react'
import type { InboxEntry } from '../inbox'
import type { Folder } from '../nav_layout'
import type { Contact } from '../p2p/contacts'
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
  // `author`: the picked row's or the bar's anchor's; `more`: the bar's More menu, without what
  // the bar shows.
  | { kind: 'selection'; list: string; author?: UserRef | null; more?: boolean }
  | { kind: 'member'; user: UserRef; server: string | null; where: MemberWhere }
  | { kind: 'server'; server: string; folder: string | null; at: number }
  // `p2p`: a folder of the P2P servers' rail.
  | { kind: 'folder'; folder: Folder; p2p?: boolean }
  | { kind: 'channel'; server: string; channel: Channel }
  | { kind: 'category'; server: string; category: Category }
  | { kind: 'dm'; dm: DmSummary; where: 'sidebar' | 'home' }
  // The rail's home button and the instance badge.
  | { kind: 'home' }
  // A link preview under a message; `banner`: it shows an image.
  | { kind: 'embed'; message: Message; ord: number; banner: boolean }
  // A timestamp in a message's text: `ts` in milliseconds, `token` as written.
  | { kind: 'timestamp'; ts: number; token: string }
  // An inbox row, with its panel's open and mark-read.
  | { kind: 'inbox'; entry: InboxEntry; open(): void; read(): void }
  // A Home card: `read`, what marking it read would mark now.
  | {
      kind: 'card'
      key: string
      open(): void
      read: string[]
      markRead(): void
      forget?(): void
    }
  // The call buttons' chevron: how a call or video call with the DM's other person connects.
  | { kind: 'call'; dm: DmSummary; video: boolean }
  // A P2P contact; `me`: this account's P2P key, which names the DM's room.
  | { kind: 'p2p_contact'; c: Contact; me: string | null }

export interface ActionCtx {
  s: RChatState
  via: Via
  target: Target
  // The target's place, else the open one.
  server: string | null
  channel: Channel | null
  dm: DmSummary | null
  // The message list: the target message's, channel's or DM's, else the open thread, channel or
  // DM.
  list: string | null
  message: Message | null
  // The target member, a message target's author unless a webhook, a DM target's other person,
  // else the open profile card's.
  member: UserRef | null
}

export interface ArgChoice {
  value: string
  label: string
  subtitle?: string
  icon?: LucideIcon
  // A #rrggbb dot before the label.
  swatch?: string
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

// One row of an action that lists several (a person, a relay): id `<action id>_<key>`. `args`
// fill the action's steps.
export interface Expansion {
  key: string
  label: string
  subtitle?: string
  name?: boolean
  subtitleName?: boolean
  icon?: LucideIcon
  danger?: boolean
  checked?: boolean
  radio?: boolean
  wrap?: boolean
  args?: Args
}

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
  // The icon for this context; `icon` stays the static one.
  iconFor?(ctx: ActionCtx): LucideIcon
  // Whether this context's row is shown as danger; `danger` stays the static flag.
  dangerFor?(ctx: ActionCtx): boolean
  wrap?: boolean
  // The label is a name (blurred in streamer mode).
  name?: boolean
  // Menu position, default 500; ties keep registration order.
  order?: number
  // The position in this context's menu; `order` stays the static one.
  orderFor?(ctx: ActionCtx): number
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
  // Rows in place of the action's own, in the palette and in the menus it joins.
  expand?(ctx: ActionCtx): Expansion[]
}
