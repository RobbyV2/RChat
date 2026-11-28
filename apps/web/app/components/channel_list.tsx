'use client'

import type { ReactNode, Ref } from 'react'
import { ChevronDown, ChevronRight, Hash, Lock, Plus } from 'lucide-react'
import {
  unfolded,
  unfoldedRows,
  type CategoryEntry,
  type ChannelEntry,
  type Channels,
  type ChannelsState,
  type ListEntry,
  type SeparatorEntry,
} from '../lib/place/channels'
import { CategoryLine, ChannelSeparatorRow, categoryNameCls } from './channel_separator'
import { longPress } from './context_menu'
import { IconButton } from './controls'
import type { DragSpec } from './drag'
import { Row, Stack, Surface, Inset } from './layout'
import { Masked } from './ui'
import { sideRowLook } from '../lib/controls'

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
  separator?: (separator: SeparatorEntry) => DragSpec | undefined
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
        className={`${sideRowLook} ${
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
  const listRow = (r: ListEntry) =>
    r.kind === 'channel' ? (
      row(r.channel)
    ) : (
      <ChannelSeparatorRow
        key={`sep:${r.separator.key}`}
        label={r.separator.label}
        style={r.separator.style}
        own={state.ownPlace}
        menu={(x, y) => channels.separatorMenu(r.separator.key, x, y)}
        drag={drag?.separator?.(r.separator)}
      />
    )
  const zoneCls = (zone: string | undefined, empty: boolean) =>
    `flex flex-col rounded-lg transition-colors ${
      drag?.moving && empty
        ? 'min-h-8 w-side-row self-center border-2 border-dashed border-outline-variant'
        : ''
    } ${drag?.moving && zone !== undefined && drag.over === zone ? 'bg-primary-container/40' : ''}`

  const categoryBlock = (category: CategoryEntry) => {
    const visible = unfoldedRows(category)
    const kept = unfolded(category)
    const hidden = category.channels.filter(c => !kept.includes(c))
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
            <Inset
              {...categoryProps?.(category)}
              aria-expanded={category.open}
              onClick={() => channels.setOpen(category.key, !category.open)}
              {...longPress(
                (x, y) => channels.categoryMenu(category.key, x, y),
                drag?.category(category)
              )}
              as="button"
              row
              pad="sm"
              inset="chip"
              gap="2xs"
              text="xs"
              ink="muted"
              look={`rounded-md font-medium -outline-offset-2 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11 ${categoryNameCls(category.style)}`}
              place="min-w-0 flex-1"
            >
              {category.open ? (
                <ChevronDown size={14} className="shrink-0" />
              ) : (
                <ChevronRight size={14} className="shrink-0" />
              )}
              <span className="truncate">
                <Masked text={category.name} own={state.ownPlace} />
              </span>
              <CategoryLine style={category.style} />
              {categoryEnd?.(category, hidden)}
            </Inset>
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
          {visible.map(listRow)}
          {createRow?.(category.key)}
        </div>
      </Surface>
    )
  }

  const loose = drag?.zoneOf(null)
  return (
    <div ref={drag?.scope} className="flex-1 overflow-y-auto">
      <Stack gap="md">
        <div
          data-drop-zone={loose}
          data-drop-label={loose === undefined ? undefined : 'No category'}
          className={zoneCls(loose, state.loose.length === 0 && state.categories.length > 0)}
        >
          {state.loose.map(listRow)}
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
