'use client'

import type { ReactNode, Ref } from 'react'
import { ChevronDown, ChevronRight, Hash, Lock, Plus } from 'lucide-react'
import {
  unfolded,
  type CategoryEntry,
  type ChannelEntry,
  type Channels,
  type ChannelsState,
} from '../lib/place/channels'
import { longPress } from './context_menu'
import { IconButton } from './controls'
import type { DragSpec } from './drag'
import { Row, Stack, Surface } from './layout'
import { Masked } from './ui'

function PrivateIcon() {
  return (
    <span title="Private channel" aria-label="Private channel" role="img" className="flex shrink-0">
      <Lock size={12} />
    </span>
  )
}

// How a list's channels and categories are moved by dragging.
export interface ChannelDrag {
  scope: Ref<HTMLDivElement>
  channel: (channel: ChannelEntry) => DragSpec | undefined
  category: (category: CategoryEntry) => DragSpec | undefined
  // The drop zone of a category's channels (null: the channels outside any), and the one the
  // categories themselves are ordered in.
  zoneOf: (category: string | null) => string
  categoriesZone: string
  // A channel is being dragged, and the zone it is over.
  moving: boolean
  over: string | null
}

// The channels of a server or a room in their categories, whichever place they are in. A voice
// channel's row, the end of a row (badges, who types) and the fields that add or rename a channel
// are the caller's.
export function ChannelList({
  channels,
  state,
  look,
  end,
  voice,
  categoryEnd,
  replace,
  createRow,
  onAdd,
  drag,
  rowProps,
  categoryProps,
}: {
  channels: Channels
  state: ChannelsState
  // How a row shows what you have not read (`bold`) or have muted.
  look: (channel: ChannelEntry) => { muted: boolean; bold: boolean }
  end: (channel: ChannelEntry) => ReactNode
  voice: (channel: ChannelEntry) => ReactNode
  // The end of a category's header, given the channels its fold hides.
  categoryEnd?: (category: CategoryEntry, hidden: ChannelEntry[]) => ReactNode
  // What stands in a channel's place (the field that renames it), or null.
  replace?: (channel: ChannelEntry) => ReactNode
  // The field that adds a channel to a category (null: outside any), while it is open.
  createRow?: (category: string | null) => ReactNode
  // Opens that field for a category.
  onAdd?: (category: CategoryEntry) => void
  drag?: ChannelDrag
  rowProps?: (channel: ChannelEntry) => Record<`data-${string}`, string>
  categoryProps?: (category: CategoryEntry) => Record<`data-${string}`, string>
}) {
  const textRow = (c: ChannelEntry) => {
    const { muted, bold } = look(c)
    return (
      <button
        key={c.key}
        {...rowProps?.(c)}
        onClick={() => channels.open(c.key)}
        {...longPress((x, y) => channels.channelMenu(c.key, x, y), drag?.channel(c))}
        className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm pointer-coarse:min-h-11 ${
          c.active
            ? 'bg-secondary-container text-on-secondary-container'
            : `hover:bg-surface-container hover:text-on-surface ${
                bold ? 'font-semibold text-on-surface' : 'text-on-surface-variant'
              } ${muted ? 'opacity-60' : ''}`
        }`}
      >
        <Hash size={16} className="shrink-0" />
        <span className="truncate">
          <Masked text={c.name} own={state.ownPlace} />
        </span>
        {c.private && <PrivateIcon />}
        {end(c)}
      </button>
    )
  }
  const row = (c: ChannelEntry) => replace?.(c) ?? (c.kind === 'voice' ? voice(c) : textRow(c))
  const zoneCls = (zone: string | undefined, empty: boolean) =>
    `flex flex-col rounded-lg transition-colors ${
      drag?.moving && empty ? 'mx-2 min-h-8 border-2 border-dashed border-outline-variant' : ''
    } ${drag?.moving && zone !== undefined && drag.over === zone ? 'bg-primary-container/40' : ''}`

  const categoryBlock = (category: CategoryEntry) => {
    const visible = unfolded(category)
    const hidden = category.channels.filter(c => !visible.includes(c))
    const zone = drag?.zoneOf(category.key)
    return (
      <Surface
        key={category.key}
        data-drag-box
        pad="none"
        tone="plain"
        radius="md"
        place="group/cat"
      >
        <Surface pad="sm" inset="bar" tone="plain" radius="none">
          <Row gap="none">
            <button
              {...categoryProps?.(category)}
              aria-expanded={category.open}
              onClick={() => channels.setOpen(category.key, !category.open)}
              {...longPress(
                (x, y) => channels.categoryMenu(category.key, x, y),
                drag?.category(category)
              )}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pr-1 pl-2 text-xs font-medium tracking-wider text-on-surface-variant uppercase outline-offset-[-2px] hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11"
            >
              {category.open ? (
                <ChevronDown size={14} className="shrink-0" />
              ) : (
                <ChevronRight size={14} className="shrink-0" />
              )}
              <span className="truncate">
                <Masked text={category.name} own={state.ownPlace} />
              </span>
              {categoryEnd?.(category, hidden)}
            </button>
            {state.canManage && onAdd && (
              <IconButton
                icon={Plus}
                label={`Create channel in ${category.name}`}
                tooltip="Create channel"
                size="sm"
                onClick={() => onAdd(category)}
                place="md:opacity-0 md:group-hover/cat:opacity-100 md:focus-visible:opacity-100 pointer-coarse:opacity-100"
              />
            )}
          </Row>
        </Surface>
        <div
          data-drop-zone={zone}
          data-drop-label={zone === undefined ? undefined : category.name}
          className={zoneCls(zone, visible.length === 0)}
        >
          {visible.map(row)}
          {createRow?.(category.key)}
        </div>
      </Surface>
    )
  }

  const loose = drag?.zoneOf(null)
  return (
    <div ref={drag?.scope} className="flex-1 overflow-y-auto pb-3">
      <Stack gap="md">
        <div
          data-drop-zone={loose}
          data-drop-label={loose === undefined ? undefined : 'No category'}
          className={zoneCls(
            loose,
            state.uncategorized.length === 0 && state.categories.length > 0
          )}
        >
          {state.uncategorized.map(row)}
          {createRow?.(null)}
        </div>
        {state.categories.length > 0 && (
          <Stack data-drop-zone={drag?.categoriesZone} gap="md">
            {state.categories.map(categoryBlock)}
          </Stack>
        )}
        {state.empty !== null && (
          <Surface pad="lg" inset="bar" tone="plain" radius="none">
            <p className="text-sm text-on-surface-variant">{state.empty}</p>
          </Surface>
        )}
      </Stack>
    </div>
  )
}
