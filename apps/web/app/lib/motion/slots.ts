// The component groups that host slots.
export const OWNERS = [
  'dialogs',
  'sheets',
  'menus',
  'tooltips',
  'panels',
  'drawers',
  'thread panel',
  'route outlet',
  'message list',
  'reactions',
  'badges',
  'buttons',
  'rail tiles',
  'drag',
  'toasts',
  'typing line',
  'call tiles',
  'palette',
  'switches',
  'categories',
] as const
export type Owner = (typeof OWNERS)[number]

// When a slot's animation plays: `both` plays on enter and reversed on exit, `hold` plays while
// pressed, hovered or dragged and reversed after, `change` plays when a value or place changes.
export type Plays = 'both' | 'enter' | 'exit' | 'change' | 'hold'

export const SLOT_IDS = [
  'dialog',
  'sheet',
  'menu',
  'tooltip',
  'panel',
  'drawer',
  'thread',
  'route',
  'message.arrive',
  'message.send',
  'message.remove',
  'reaction.add',
  'reaction.count',
  'badge',
  'press',
  'hover',
  'reorder',
  'drag',
  'toast',
  'typing',
  'call.tile',
  'palette',
  'toggle',
  'expand',
] as const
export type SlotId = (typeof SLOT_IDS)[number]

export interface Slot {
  id: SlotId
  where: string
  owner: Owner
  plays: Plays
  // The start frame is measured at run time (first, last, invert, play).
  flip?: true
}

export const SLOTS: readonly Slot[] = [
  { id: 'dialog', where: 'dialogs open and close', owner: 'dialogs', plays: 'both' },
  { id: 'sheet', where: 'bottom sheets', owner: 'sheets', plays: 'both' },
  { id: 'menu', where: 'context menus, popovers', owner: 'menus', plays: 'both' },
  { id: 'tooltip', where: 'tooltips', owner: 'tooltips', plays: 'both' },
  {
    id: 'panel',
    where: 'right panels (members, pins, search, plugin panels)',
    owner: 'panels',
    plays: 'both',
  },
  { id: 'drawer', where: 'mobile drawers (rail, channel list)', owner: 'drawers', plays: 'both' },
  { id: 'thread', where: 'the thread panel', owner: 'thread panel', plays: 'both' },
  {
    id: 'route',
    where: 'changing channel, DM, server, settings page or plugin page',
    owner: 'route outlet',
    plays: 'enter',
  },
  {
    id: 'message.arrive',
    where: 'a new message at the bottom, while scrolled to the bottom',
    owner: 'message list',
    plays: 'enter',
  },
  {
    id: 'message.send',
    where: 'your message going from pending to sent',
    owner: 'message list',
    plays: 'enter',
  },
  { id: 'message.remove', where: 'a deleted message', owner: 'message list', plays: 'exit' },
  { id: 'reaction.add', where: 'a reaction chip appears', owner: 'reactions', plays: 'enter' },
  { id: 'reaction.count', where: 'a reaction count changes', owner: 'reactions', plays: 'change' },
  { id: 'badge', where: 'unread and ping badges appear or grow', owner: 'badges', plays: 'enter' },
  { id: 'press', where: 'buttons, tiles, list rows on press', owner: 'buttons', plays: 'hold' },
  {
    id: 'hover',
    where: 'rail tiles, cards on hover (fine pointers only)',
    owner: 'rail tiles',
    plays: 'hold',
  },
  {
    id: 'reorder',
    where: 'rail tiles, channels, folder contents, list reorders',
    owner: 'rail tiles',
    plays: 'change',
    flip: true,
  },
  { id: 'drag', where: 'drag lift and drop', owner: 'drag', plays: 'hold' },
  { id: 'toast', where: 'toasts and notices', owner: 'toasts', plays: 'both' },
  { id: 'typing', where: 'the typing line appears and goes', owner: 'typing line', plays: 'both' },
  {
    id: 'call.tile',
    where: 'call tiles join, leave, change size',
    owner: 'call tiles',
    plays: 'both',
  },
  { id: 'palette', where: 'the palette opens and closes', owner: 'palette', plays: 'both' },
  { id: 'toggle', where: 'switch thumbs', owner: 'switches', plays: 'change' },
  {
    id: 'expand',
    where: 'category and section chevrons, collapsing content',
    owner: 'categories',
    plays: 'both',
  },
]

export const slotOf = (id: string): Slot | undefined => SLOTS.find(s => s.id === id)
