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
  'media viewer',
  'placeholders',
  'images',
  'banners',
  'toolbars',
  'navigation',
  'sidebar rows',
] as const
export type Owner = (typeof OWNERS)[number]

// When a slot's animation plays: `both` plays on enter and reversed on exit, `hold` plays while
// pressed, hovered or dragged and reversed after, `change` plays when a value or place changes,
// `loop` plays for as long as it shows.
export type Plays = 'both' | 'enter' | 'exit' | 'change' | 'hold' | 'loop'

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
  'lightbox',
  'lightbox.slide',
  'skeleton.shimmer',
  'image.reveal',
  'banner.unread',
  'toolbar.hover',
  'nav.indicator',
  'typing.channel',
] as const
export type SlotId = (typeof SLOT_IDS)[number]

// The slots the style sheet moves (a state or a loop the page already shows); the engine plays
// the rest on the element that enters, leaves or changes.
export const LOOK_IDS = [
  'press',
  'hover',
  'drag',
  'toggle',
  'expand',
  'skeleton.shimmer',
  'toolbar.hover',
  'nav.indicator',
  'typing.channel',
] as const satisfies readonly SlotId[]
export type LookSlot = (typeof LOOK_IDS)[number]
export type PlaySlot = Exclude<SlotId, LookSlot>
export const PLAY_IDS = SLOT_IDS.filter(
  (id): id is PlaySlot => !(LOOK_IDS as readonly string[]).includes(id)
)
export const isLook = (id: SlotId): id is LookSlot => (LOOK_IDS as readonly string[]).includes(id)

export interface Slot {
  id: SlotId
  where: string
  owner: Owner
  plays: Plays
  // The start frame is measured at run time (first, last, invert, play).
  flip?: true
  // Plays only for an element that came or went on its own, never as part of a larger tree.
  solo?: true
  // Plays only for one new element at the end of a list that was already there.
  tail?: true
  // What Settings calls the slot.
  label: string
}

export const SLOTS: readonly Slot[] = [
  {
    id: 'dialog',
    where: 'dialogs open and close',
    owner: 'dialogs',
    plays: 'both',
    label: 'Dialogs',
  },
  { id: 'sheet', where: 'bottom sheets', owner: 'sheets', plays: 'both', label: 'Sheets' },
  { id: 'menu', where: 'context menus, popovers', owner: 'menus', plays: 'both', label: 'Menus' },
  { id: 'tooltip', where: 'tooltips', owner: 'tooltips', plays: 'both', label: 'Tooltips' },
  {
    id: 'panel',
    where: 'right panels (members, pins, search, plugin panels)',
    owner: 'panels',
    plays: 'both',
    label: 'Side panels',
  },
  {
    id: 'drawer',
    where: 'mobile drawers (rail, channel list)',
    owner: 'drawers',
    plays: 'both',
    label: 'Drawers',
  },
  {
    id: 'thread',
    where: 'the thread panel',
    owner: 'thread panel',
    plays: 'both',
    label: 'Thread panel',
  },
  {
    id: 'route',
    where: 'changing channel, DM, server, settings page or plugin page',
    owner: 'route outlet',
    plays: 'enter',
    label: 'Changing page',
  },
  {
    id: 'message.arrive',
    where: 'a new message at the bottom, while scrolled to the bottom',
    owner: 'message list',
    plays: 'enter',
    label: 'Messages arriving',
    tail: true,
  },
  {
    id: 'message.send',
    where: 'your message going from pending to sent',
    owner: 'message list',
    plays: 'enter',
    label: 'Messages sent',
  },
  {
    id: 'message.remove',
    where: 'a deleted message',
    owner: 'message list',
    plays: 'exit',
    label: 'Messages removed',
    solo: true,
  },
  {
    id: 'reaction.add',
    where: 'a reaction chip appears',
    owner: 'reactions',
    plays: 'enter',
    label: 'Reactions',
    solo: true,
  },
  {
    id: 'reaction.count',
    where: 'a reaction count changes',
    owner: 'reactions',
    plays: 'change',
    label: 'Reaction counts',
  },
  {
    id: 'badge',
    where: 'unread and ping badges appear or grow',
    owner: 'badges',
    plays: 'enter',
    label: 'Badges',
    solo: true,
  },
  {
    id: 'press',
    where: 'buttons, tiles, list rows on press',
    owner: 'buttons',
    plays: 'hold',
    label: 'Pressing',
  },
  {
    id: 'hover',
    where: 'rail tiles, cards on hover (fine pointers only)',
    owner: 'rail tiles',
    plays: 'hold',
    label: 'Hovering',
  },
  {
    id: 'reorder',
    where: 'rail tiles, channels, folder contents, list reorders',
    owner: 'rail tiles',
    plays: 'change',
    flip: true,
    label: 'Reordering',
  },
  { id: 'drag', where: 'drag lift and drop', owner: 'drag', plays: 'hold', label: 'Dragging' },
  {
    id: 'toast',
    where: 'toasts and notices',
    owner: 'toasts',
    plays: 'both',
    label: 'Notices',
    solo: true,
  },
  {
    id: 'typing',
    where: 'the typing line appears and goes',
    owner: 'typing line',
    plays: 'both',
    label: 'Typing line',
    solo: true,
  },
  {
    id: 'call.tile',
    where: 'call tiles join, leave, change size',
    owner: 'call tiles',
    plays: 'both',
    label: 'Call tiles',
    solo: true,
  },
  {
    id: 'palette',
    where: 'the palette opens and closes',
    owner: 'palette',
    plays: 'both',
    label: 'Command palette',
  },
  { id: 'toggle', where: 'switch thumbs', owner: 'switches', plays: 'change', label: 'Switches' },
  {
    id: 'expand',
    where: 'category and section chevrons, collapsing content',
    owner: 'categories',
    plays: 'both',
    label: 'Collapsing',
  },
  {
    id: 'lightbox',
    where: 'the media viewer opens and closes, over a blurred backdrop',
    owner: 'media viewer',
    plays: 'both',
    label: 'Media viewer',
  },
  {
    id: 'lightbox.slide',
    where: 'going to the next or previous attachment in the media viewer',
    owner: 'media viewer',
    plays: 'change',
    label: 'Media viewer, next and previous',
  },
  {
    id: 'skeleton.shimmer',
    where: 'a sheen across loading placeholders',
    owner: 'placeholders',
    plays: 'loop',
    label: 'Loading placeholders',
  },
  {
    id: 'image.reveal',
    where: 'an image shows once it has loaded',
    owner: 'images',
    plays: 'enter',
    label: 'Images loading',
  },
  {
    id: 'banner.unread',
    where: 'the new messages banner shows and goes',
    owner: 'banners',
    plays: 'both',
    label: 'New messages banner',
  },
  {
    id: 'toolbar.hover',
    where: 'the message toolbar and the video download pill on hover',
    owner: 'toolbars',
    plays: 'hold',
    label: 'Hover toolbars',
  },
  {
    id: 'nav.indicator',
    where: 'the pill beside the open server, and the open channel or tab',
    owner: 'navigation',
    plays: 'change',
    label: 'Navigation markers',
  },
  {
    id: 'typing.channel',
    where: 'the typing dots in chats and on channel and DM rows',
    owner: 'sidebar rows',
    plays: 'loop',
    label: 'Typing dots',
  },
]

export const slotOf = (id: string): Slot | undefined => SLOTS.find(s => s.id === id)
