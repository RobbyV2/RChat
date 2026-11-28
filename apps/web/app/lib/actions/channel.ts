// The menus of a channel and of a category in the channel sidebar. Marking a channel read and
// muting it are the open place's commands (place.ts).

import { viewingActions } from './viewing'
import { channelTarget } from '../viewing'
import {
  CATEGORY_STYLES,
  STYLE_NAMES,
  categoryStyleOf,
  channelGroups,
  layoutOrder,
  orderKeys,
} from '../categories'
import { sharing } from '../platform'
import { canDeleteChannel } from '../rules'
import { myPerms } from '../store'
import { Perm, hasPerm } from '../types'
import { signedIn } from './global'
import { notifySettings } from './notify'
import { HostedServer } from '../place/place'
import { systemChannelAction } from './system_channel'
import type { Action, ActionCtx } from './types'

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
  if (at)
    ctx.acct.store.getState().setCategoriesCollapsed(at.server, categoryIds(ctx, at.server), shut)
}

const separatorOf = ({ target }: ActionCtx) => (target.kind === 'separator' ? target : null)

const managedSeparator = (ctx: ActionCtx) => {
  const at = separatorOf(ctx)
  return at && manages(ctx, at.server) ? at : null
}

// Where a new separator goes: the end of the category acted on, else of the channels without
// one.
const newSeparatorAt = (ctx: ActionCtx) => {
  const t = ctx.target
  const at =
    t.kind === 'category'
      ? { server: t.server, category: t.category.id }
      : t.kind === 'server'
        ? { server: t.server, category: null }
        : null
  return at && manages(ctx, at.server) ? at : null
}

// The row a separator moves to one step up or down its list, null at the end.
const stepOf = (ctx: ActionCtx, step: -1 | 1) => {
  const at = managedSeparator(ctx)
  const detail = at && ctx.s.servers[at.server]
  if (!at || !detail) return null
  const keys = orderKeys(layoutOrder(detail), at.separator.category_id)
  const from = keys.indexOf(`s${at.separator.id}`)
  const to = from + step
  return from < 0 || to < 0 || to >= keys.length ? null : to
}

const moveStep = (step: -1 | 1) => (ctx: ActionCtx) => {
  const at = separatorOf(ctx)
  const to = stepOf(ctx, step)
  if (at && to !== null)
    ctx.acct.store
      .getState()
      .moveSeparator(at.server, at.separator.id, at.separator.category_id, to)
}

const onChannel = { scope: 'channel', targets: ['channel'] } as const
const onCategory = { scope: 'channel', targets: ['category'] } as const
const onSeparator = { scope: 'channel', targets: ['separator'] } as const

export const channelActions: Action[] = [
  ...viewingActions(
    'channel',
    ctx => {
      const at = channelOf(ctx)
      return (
        at &&
        channelTarget(ctx.s.me?.username ?? null, 'instance', at.server, at.channel, ctx.acct.conn)
      )
    },
    ctx => {
      const at = channelOf(ctx)
      return !!at && manages(ctx, at.server)
    },
    (ctx, sensitive) => {
      const at = channelOf(ctx)
      if (at)
        void ctx.acct.store.getState().setChannelSensitive(at.server, at.channel.id, sensitive)
    }
  ),
  notifySettings('channel_notify', 'channel', ['channel'], ctx => {
    const at = channelOf(ctx)
    return at?.channel.kind === 'text'
      ? { kind: 'channel', id: at.channel.id, server: at.server }
      : null
  }),
  {
    id: 'channel_text_only',
    title: 'Enable text only',
    label: ctx => (channelOf(ctx)?.channel.text_only ? 'Disable text only' : 'Enable text only'),
    ...onChannel,
    order: 890,
    available: ctx => {
      const at = channelOf(ctx)
      return at?.channel.kind === 'text' && manages(ctx, at.server)
    },
    run: ctx => {
      const at = channelOf(ctx)
      if (at)
        void ctx.acct.store
          .getState()
          .setChannelTextOnly(at.server, at.channel.id, !at.channel.text_only)
    },
  },
  systemChannelAction('channel_system_here', 'channel', ['channel'], 895, ctx => {
    const at = channelOf(ctx)
    return (
      at && {
        place: HostedServer.open(ctx.acct, at.server),
        channel: at.channel.id,
        text: at.channel.kind === 'text',
      }
    )
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
        ctx.acct.channelEdit
          .getState()
          .start({ mode: 'rename', server: at.server, id: at.channel.id }, at.channel.name)
    },
  },
  {
    id: 'channel_permissions',
    title: 'Permissions',
    ...onChannel,
    order: 912,
    available: ctx => {
      const at = channelOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = channelOf(ctx)
      if (at)
        ctx.acct.store
          .getState()
          .openDialog({ kind: 'perms', server: at.server, channel: at.channel.id })
    },
  },
  {
    id: 'channel_perm_sync',
    title: 'Sync Permissions',
    subtitle: () => 'With its category',
    ...onChannel,
    order: 915,
    available: ctx => {
      const at = channelOf(ctx)
      const detail = at && ctx.s.servers[at.server]
      const current = detail?.channels.find(c => c.id === at?.channel.id) ?? at?.channel
      return (
        !!at &&
        !!current &&
        manages(ctx, at.server) &&
        current.perm_sync !== true &&
        !!detail?.categories?.some(c => c.id === current.category_id)
      )
    },
    run: ctx => {
      const at = channelOf(ctx)
      if (at) void ctx.acct.store.getState().syncChannelPerms(at.server, at.channel.id)
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
      if (at) void ctx.acct.store.getState().deleteChannel(at.channel.id)
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
      ctx.acct.store.getState().setCategoriesCollapsed(at.server, [category], false)
      ctx.acct.channelEdit
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
      if (at)
        ctx.acct.store
          .getState()
          .openDialog({ kind: 'category', server: at.server, id: at.category.id })
    },
  },
  {
    id: 'category_style',
    title: 'Category style',
    ...onCategory,
    order: 112,
    args: [
      {
        kind: 'choice',
        name: 'style',
        prompt: 'Style',
        choices: ctx =>
          CATEGORY_STYLES.map(value => ({
            value,
            label: STYLE_NAMES[value],
            radio: true,
            checked: categoryStyleOf(categoryOf(ctx)?.category.style) === value,
          })),
      },
    ],
    available: ctx => {
      const at = categoryOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: (ctx, { style }) => {
      const at = categoryOf(ctx)
      if (at && style !== undefined)
        void ctx.acct.store
          .getState()
          .renameCategory(at.category.id, at.category.name, categoryStyleOf(style))
    },
  },
  {
    id: 'channel_separator_create',
    title: 'Create separator',
    scope: 'channel',
    targets: ['server', 'category'],
    orderFor: ctx => (ctx.target.kind === 'category' ? 105 : 210),
    available: ctx => newSeparatorAt(ctx) !== null,
    run: ctx => {
      const at = newSeparatorAt(ctx)
      if (!at) return
      if (at.category !== null)
        ctx.acct.store.getState().setCategoriesCollapsed(at.server, [at.category], false)
      ctx.acct.store
        .getState()
        .openDialog({ kind: 'separator', server: at.server, category: at.category })
    },
  },
  {
    id: 'channel_separator_edit',
    title: 'Edit separator',
    ...onSeparator,
    order: 100,
    available: ctx => managedSeparator(ctx) !== null,
    run: ctx => {
      const at = managedSeparator(ctx)
      if (at)
        ctx.acct.store
          .getState()
          .openDialog({ kind: 'separator', server: at.server, id: at.separator.id })
    },
  },
  {
    id: 'channel_separator_move_up',
    title: 'Move up',
    ...onSeparator,
    order: 110,
    available: ctx => stepOf(ctx, -1) !== null,
    run: moveStep(-1),
  },
  {
    id: 'channel_separator_move_down',
    title: 'Move down',
    ...onSeparator,
    order: 111,
    available: ctx => stepOf(ctx, 1) !== null,
    run: moveStep(1),
  },
  {
    id: 'channel_separator_move_category',
    title: 'Move to category',
    ...onSeparator,
    order: 112,
    args: [
      {
        kind: 'choice',
        name: 'cat',
        prompt: 'Category',
        choices: ctx => {
          const at = managedSeparator(ctx)
          if (!at) return []
          const now = at.separator.category_id
          return [
            { value: '', label: 'No category', radio: true, checked: now === null },
            ...(ctx.s.servers[at.server]?.categories ?? []).map(c => ({
              value: String(c.id),
              label: c.name,
              radio: true,
              checked: now === c.id,
            })),
          ]
        },
      },
    ],
    available: ctx => {
      const at = managedSeparator(ctx)
      return !!at && (ctx.s.servers[at.server]?.categories?.length ?? 0) > 0
    },
    run: (ctx, { cat }) => {
      const at = managedSeparator(ctx)
      const detail = at && ctx.s.servers[at.server]
      const to = cat ? Number(cat) : null
      if (at && detail && cat !== undefined && to !== at.separator.category_id)
        ctx.acct.store
          .getState()
          .moveSeparator(at.server, at.separator.id, to, orderKeys(layoutOrder(detail), to).length)
    },
  },
  {
    id: 'channel_separator_delete',
    title: 'Delete separator',
    ...onSeparator,
    order: 120,
    danger: true,
    args: [
      {
        kind: 'confirm',
        title: 'Delete separator',
        body: ctx => {
          const label = separatorOf(ctx)?.separator.label
          return label
            ? `Delete the separator ${label}? The channels around it stay.`
            : 'Delete this separator? The channels around it stay.'
        },
        confirm: 'Delete',
      },
    ],
    available: ctx => managedSeparator(ctx) !== null,
    run: ctx => {
      const at = managedSeparator(ctx)
      if (at) void ctx.acct.store.getState().deleteSeparator(at.separator.id)
    },
  },
  {
    id: 'category_permissions',
    title: 'Permissions',
    ...onCategory,
    order: 115,
    available: ctx => {
      const at = categoryOf(ctx)
      return at !== null && manages(ctx, at.server)
    },
    run: ctx => {
      const at = categoryOf(ctx)
      if (at)
        ctx.acct.store
          .getState()
          .openDialog({ kind: 'perms', server: at.server, category: at.category.id })
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
      if (at) void ctx.acct.store.getState().deleteCategory(at.category.id)
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
