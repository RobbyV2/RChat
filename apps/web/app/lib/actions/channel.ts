// The menus of a channel and of a category in the channel sidebar. Marking a channel read and
// muting it are the open place's commands (place.ts).

import { channelGroups } from '../categories'
import { useChannelEdit } from '../channel_edit'
import { sharing } from '../platform'
import { canDeleteChannel } from '../rules'
import { myPerms, useStore } from '../store'
import { Perm, hasPerm } from '../types'
import { signedIn } from './global'
import { notifySettings } from './notify'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

const copy = (text: string) => void sharing().copyText(text)

const channelOf = ({ target }: ActionCtx) => (target.kind === 'channel' ? target : null)

const categoryOf = ({ target }: ActionCtx) => (target.kind === 'category' ? target : null)

const manages = ({ s }: ActionCtx, server: string) =>
  signedIn(s) && hasPerm(myPerms(s, server), Perm.ManageChannels)

// Each category of the server, as the sidebar lists them.
const categoryIds = (ctx: ActionCtx, server: string) => {
  const detail = ctx.s.servers[server]
  return detail
    ? channelGroups(detail, manages(ctx, server)).categories.map(g => g.category.id)
    : []
}

const collapse = (ctx: ActionCtx, shut: boolean) => {
  const at = categoryOf(ctx)
  if (at) get().setCategoriesCollapsed(at.server, categoryIds(ctx, at.server), shut)
}

const onChannel = { scope: 'channel', targets: ['channel'] } as const
const onCategory = { scope: 'channel', targets: ['category'] } as const

export const channelActions: Action[] = [
  notifySettings('channel_notify', 'channel', ['channel'], ctx => {
    const at = channelOf(ctx)
    return at?.channel.kind === 'text'
      ? { kind: 'channel', id: at.channel.id, server: at.server }
      : null
  }),
  {
    id: 'channel_copy_id',
    title: 'Copy Channel ID',
    ...onChannel,
    order: 900,
    available: ctx => channelOf(ctx) !== null,
    run: ctx => {
      const at = channelOf(ctx)
      if (at) copy(String(at.channel.id))
    },
  },
  {
    id: 'channel_rename',
    title: 'Rename Channel',
    ...onChannel,
    order: 910,
    available: ctx => {
      const at = channelOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = channelOf(ctx)
      if (at)
        useChannelEdit
          .getState()
          .start({ mode: 'rename', server: at.server, id: at.channel.id }, at.channel.name)
    },
  },
  {
    id: 'channel_delete',
    title: 'Delete Channel',
    ...onChannel,
    order: 920,
    danger: true,
    args: [
      {
        kind: 'confirm',
        title: 'Delete Channel',
        body: ctx => {
          const c = channelOf(ctx)?.channel
          if (!c) return ''
          return c.kind === 'text'
            ? `Delete #${c.name}? Its messages are deleted for everyone.`
            : `Delete the voice channel ${c.name}?`
        },
        confirm: 'Delete',
      },
    ],
    available: ctx => {
      const at = channelOf(ctx)
      const channels = at && ctx.s.servers[at.server]?.channels
      return !!at && !!channels && manages(ctx, at.server) && canDeleteChannel(channels, at.channel)
    },
    run: ctx => {
      const at = channelOf(ctx)
      if (at) void get().deleteChannel(at.channel.id)
    },
  },
  {
    id: 'category_create_channel',
    title: 'Create channel here',
    ...onCategory,
    order: 100,
    available: ctx => {
      const at = categoryOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = categoryOf(ctx)
      if (!at) return
      const category = at.category.id
      get().setCategoriesCollapsed(at.server, [category], false)
      useChannelEdit
        .getState()
        .start({ mode: 'create', server: at.server, kind: 'text', category }, '')
    },
  },
  {
    id: 'category_rename',
    title: 'Rename category',
    ...onCategory,
    order: 110,
    available: ctx => {
      const at = categoryOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = categoryOf(ctx)
      if (at) get().openDialog({ kind: 'category', server: at.server, id: at.category.id })
    },
  },
  {
    id: 'category_delete',
    title: 'Delete category',
    ...onCategory,
    order: 120,
    danger: true,
    args: [
      {
        kind: 'confirm',
        title: 'Delete category',
        body: ctx =>
          `Delete the category ${categoryOf(ctx)?.category.name ?? ''}? Its channels are kept and move out of it.`,
        confirm: 'Delete',
      },
    ],
    available: ctx => {
      const at = categoryOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = categoryOf(ctx)
      if (at) void get().deleteCategory(at.category.id)
    },
  },
  {
    id: 'category_collapse_all',
    title: 'Collapse all',
    ...onCategory,
    order: 300,
    available: ctx => categoryOf(ctx) !== null,
    run: ctx => collapse(ctx, true),
  },
  {
    id: 'category_expand_all',
    title: 'Expand all',
    ...onCategory,
    order: 310,
    available: ctx => categoryOf(ctx) !== null,
    run: ctx => collapse(ctx, false),
  },
  {
    id: 'category_copy_id',
    title: 'Copy Category ID',
    ...onCategory,
    order: 900,
    available: ctx => categoryOf(ctx) !== null,
    run: ctx => {
      const at = categoryOf(ctx)
      if (at) copy(String(at.category.id))
    },
  },
]
