'use client'

import type { ReactNode, Ref } from 'react'
import { ChevronDown, FolderPlus, Hash, Lock, Plus, Volume2 } from 'lucide-react'
import {
  unfolded,
  unfoldedRows,
  type CategoryEntry,
  type ChannelDraft,
  type ChannelEntry,
  type Channels,
  type ChannelsState,
  type EndingsState,
  type ListEntry,
  type SeparatorEntry,
} from '../lib/place/channels'
import { CategoryLine, ChannelSeparatorRow } from './channel_separator'
import { categoryStyleOf } from '../lib/categories'
import { longPress } from './context_menu'
import { IconButton, SideRow } from './controls'
import type { DragSpec } from './drag'
import { Row, Stack, Surface } from './layout'
import { Masked, renameFieldCls } from './ui'
import { enterKey } from '../lib/keys'
import { useLive } from '../lib/place/react'
import { MutedIcon } from './notify_menu'
import { PingBadge } from './ping_badge'
import { useLoaded, useServerLooks } from '../lib/place/use_looks'
import { ChannelEnd } from './typing_indicator'
import { look as moves } from '../lib/motion/play'

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

// The end of a category's header for the channels its fold hides: their pings, else who types in
// them and whether any is unread.
function FoldedEnd({ ends, hidden }: { ends: EndingsState; hidden: ChannelEntry[] }) {
  const found = hidden.flatMap(c => ends.of.get(c.key) ?? [])
  const pings = found.reduce((n, e) => n + e.pings, 0)
  if (pings > 0) return <PingBadge count={pings} className="ml-auto" />
  const typers = [...new Set(found.flatMap(e => e.typers))]
  return <ChannelEnd typers={typers} pings={0} unread={found.some(e => e.unread)} />
}

function NameField({
  channels,
  draft,
  blurSubmits,
}: {
  channels: Channels
  draft: ChannelDraft
  blurSubmits: boolean
}) {
  return (
    <input
      autoFocus
      value={draft.name}
      maxLength={draft.max ?? undefined}
      onChange={e => channels.nameDraft(e.target.value)}
      onKeyDown={e => {
        if (enterKey(e)) channels.submitDraft()
        if (e.key === 'Escape') channels.dropDraft()
      }}
      onBlur={blurSubmits ? channels.submitDraft : undefined}
      placeholder="channel name"
      aria-label={draft.mode === 'create' ? 'New channel name' : 'Channel name'}
      className={`${renameFieldCls} min-w-0 flex-1`}
    />
  )
}

// The field in a channel's place while it is renamed.
function RenameField({ channels, draft }: { channels: Channels; draft: ChannelDraft }) {
  return (
    <Surface as="span" pad="sm" inset="bar" tone="plain" radius="none">
      <Row as="span" gap="none">
        <NameField channels={channels} draft={draft} blurSubmits />
      </Row>
    </Surface>
  )
}

// The field that names a new channel, with its kind and what it takes.
function CreateField({
  channels,
  draft,
}: {
  channels: Channels
  draft: ChannelDraft & { mode: 'create' }
}) {
  const kind = (k: 'text' | 'voice') => (
    <IconButton
      icon={k === 'text' ? Hash : Volume2}
      label={k === 'text' ? 'Text channel' : 'Voice channel'}
      size="sm"
      shape="square"
      pressed={draft.kind === k}
      onMouseDown={e => e.preventDefault()}
      onClick={() => channels.setDraftKind(k)}
    />
  )
  return (
    <Surface
      as="span"
      pad="sm"
      gap="2xs"
      tone="plain"
      radius="none"
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) channels.submitDraft()
      }}
    >
      <Row as="span" gap="sm">
        <Row as="span" gap="3xs" place="shrink-0">
          {kind('text')}
          {kind('voice')}
        </Row>
        <NameField channels={channels} draft={draft} blurSubmits={false} />
      </Row>
      {draft.kind === 'text' && draft.textOnly !== null && (
        <Row as="label" gap="sm" onMouseDown={e => e.preventDefault()}>
          <input
            type="checkbox"
            className="accent-primary"
            checked={draft.textOnly}
            onChange={e => channels.setDraftTextOnly(e.target.checked)}
          />
          <span className="text-sm">Text only</span>
        </Row>
      )}
    </Surface>
  )
}

// The channels of a server or a room in their categories, whichever place they are in, with the
// fields that add or rename a channel. A voice channel's row is the caller's.
export function ChannelList({
  channels,
  state,
  voice,
  drag,
  rowProps,
  categoryProps,
}: {
  channels: Channels
  state: ChannelsState
  voice: (channel: ChannelEntry) => ReactNode
  drag?: ChannelDrag
  rowProps?: (channel: ChannelEntry) => Record<`data-${string}`, string>
  categoryProps?: (category: CategoryEntry) => Record<`data-${string}`, string>
}) {
  const ends = useLive(channels.ends)
  useLoaded(useServerLooks(ends.server), ends.ask)
  const textRow = (c: ChannelEntry) => {
    const end = ends.of.get(c.key)
    const muted = end?.muted ?? false
    const bold = end?.bold ?? false
    return (
      <SideRow
        key={c.key}
        {...rowProps?.(c)}
        onClick={() => channels.open(c.key)}
        {...longPress((x, y) => channels.channelMenu(c.key, x, y), drag?.channel(c))}
        tone={bold ? 'strong' : 'plain'}
        current={c.active}
        dim={muted}
      >
        <Hash size={16} className="shrink-0" />
        <span className="truncate">
          <Masked text={c.name} own={state.ownPlace} />
        </span>
        {c.private && <PrivateIcon />}
        {end && (
          <>
            <MutedIcon scope={end.scope} />
            <ChannelEnd typers={end.typers} pings={end.pings} unread={end.unread} />
          </>
        )}
      </SideRow>
    )
  }
  const draft = useLive(channels.draft)
  const row = (c: ChannelEntry) =>
    draft?.mode === 'rename' && draft.key === c.key ? (
      <RenameField key={c.key} channels={channels} draft={draft} />
    ) : c.kind === 'voice' ? (
      voice(c)
    ) : (
      textRow(c)
    )
  const createRow = (category: string | null) =>
    draft?.mode === 'create' && draft.category === category ? (
      <CreateField channels={channels} draft={draft} />
    ) : null
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
            <SideRow
              {...categoryProps?.(category)}
              onClick={() => channels.setOpen(category.key, !category.open)}
              {...longPress(
                (x, y) => channels.categoryMenu(category.key, x, y),
                drag?.category(category)
              )}
              tone="heading"
              open={category.open}
              caps={categoryStyleOf(category.style) === 'default'}
            >
              <ChevronDown
                size={14}
                {...moves('expand')}
                className={`shrink-0 ${category.open ? '' : '-rotate-90'}`}
              />
              <span className="truncate">
                <Masked text={category.name} own={state.ownPlace} />
              </span>
              <CategoryLine style={category.style} />
              <FoldedEnd ends={ends} hidden={hidden} />
            </SideRow>
            {state.canManage && (
              <IconButton
                icon={Plus}
                label={`Create channel in ${category.name}`}
                tooltip="Create channel"
                size="sm"
                onClick={() => channels.startCreate(category.key)}
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
          {createRow(category.key)}
        </div>
      </Surface>
    )
  }

  const loose = drag?.zoneOf(null)
  return (
    <>
      <Surface pad="lg" inset="bar" tone="plain" radius="none">
        <Row gap="sm" justify="between">
          <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
            Channels
          </span>
          {state.canManage && (
            <Row as="span" gap="3xs">
              <IconButton
                icon={FolderPlus}
                label="Create category"
                size="sm"
                onClick={e => channels.addCategory(e.clientX, e.clientY)}
              />
              <IconButton
                icon={Plus}
                label="Create channel"
                size="sm"
                onClick={() => channels.startCreate(null)}
              />
            </Row>
          )}
        </Row>
      </Surface>
      <div ref={drag?.scope} className="flex-1 overflow-y-auto">
        <Stack gap="md">
          <div
            data-drop-zone={loose}
            data-drop-label={loose === undefined ? undefined : 'No category'}
            className={zoneCls(loose, state.loose.length === 0 && state.categories.length > 0)}
          >
            {state.loose.map(listRow)}
            {createRow(null)}
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
    </>
  )
}
