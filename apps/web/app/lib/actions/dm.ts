// A DM's menu, in the sidebar and on Home's pinned DMs. Marking read, muting and closing are the
// open place's commands (place.ts), and adding or blocking the other person are member actions.

import { ArrowDownUp, AtSign, ExternalLink, ListFilter, Lock, PinOff, X } from 'lucide-react'
import { DM_SORTS, clearDmFilters, dmListPrefs, filtersOn, type DmListPrefs } from '../dm_list'
import type { NotifyScope } from '../notify'
import { sharing } from '../platform'
import type { DmSummary } from '../types'
import { EARLIER_ACTION, SEAL_LABEL, dmPlace, hostedDmSeal, sealReasonText } from '../sealing'
import { client } from '../client/client'
import { signedIn } from './global'
import { notifySettings } from './notify'
import type { Action, ActionCtx } from './types'

const dmAt = ({ s, target }: ActionCtx, where: 'sidebar' | 'home' | null): DmSummary | null =>
  signedIn(s) && target.kind === 'dm' && (where === null || target.where === where)
    ? target.dm
    : null

const pinned = ({ s }: ActionCtx, dm: DmSummary | null) =>
  dm !== null && s.layout.dmPinned.includes(dm.id)

const notifyScope = (ctx: ActionCtx): NotifyScope | null => {
  const dm = dmAt(ctx, 'sidebar')
  return dm && { kind: 'dm', id: dm.id }
}

const onDm = { scope: 'dm', targets: ['dm'] } as const

const listPrefs = ({ s }: ActionCtx) => dmListPrefs(s.layout)

// The DM list's sort and filter button shows these as its menu, with the list's own short labels;
// the palette lists them by their titles.
const onList = (ctx: ActionCtx) => ctx.target.kind === 'dm_list'

const forList = { scope: 'dm', targets: ['dm_list'] } as const

const SORT_TITLES: Record<DmListPrefs['sort'], string> = {
  recent: 'Sort DMs by recent activity',
  oldest: 'Sort DMs by oldest activity',
  name: 'Sort DMs by name',
  custom: 'Sort DMs in custom order',
}

const LIST_KEYWORDS = ['direct messages', 'sort', 'order', 'filter']

const sortActions: Action[] = DM_SORTS.map(({ sort, label }) => ({
  id: `dms_sort_${sort}`,
  title: SORT_TITLES[sort],
  label: ctx => (onList(ctx) ? label : SORT_TITLES[sort]),
  subtitle: ctx => (onList(ctx) && sort === 'custom' ? 'Drag to reorder' : undefined),
  ...forList,
  icon: ArrowDownUp,
  keywords: LIST_KEYWORDS,
  radio: true,
  checked: ctx => listPrefs(ctx).sort === sort,
  available: ctx => signedIn(ctx.s) && (onList(ctx) || listPrefs(ctx).sort !== sort),
  run: ({ acct }) => acct.store.getState().setDmList({ sort }),
}))

const toggle = (
  key: 'friends' | 'unread' | 'unreadTop',
  row: string,
  title: string,
  off: string
): Action => ({
  id: `dms_${key === 'unreadTop' ? 'unread_top' : `${key}_only`}`,
  title,
  label: ctx => (onList(ctx) ? row : listPrefs(ctx)[key] ? off : title),
  ...forList,
  icon: ListFilter,
  keywords: LIST_KEYWORDS,
  checked: ctx => listPrefs(ctx)[key],
  available: ctx => signedIn(ctx.s),
  run: ctx => ctx.acct.store.getState().setDmList({ [key]: !listPrefs(ctx)[key] }),
})

export const dmListActions: Action[] = [
  ...sortActions,
  toggle('unreadTop', 'Unread on top', 'Show unread DMs on top', 'Stop showing unread DMs on top'),
  toggle('friends', 'Friends only', 'Show only DMs with friends', 'Show DMs with everyone'),
  toggle('unread', 'Unread only', 'Show only unread DMs', 'Show read DMs too'),
  {
    id: 'dms_clear_filters',
    title: 'Clear DM filters',
    label: ctx => (onList(ctx) ? 'Clear filters' : 'Clear DM filters'),
    ...forList,
    icon: ListFilter,
    iconFor: ctx => (onList(ctx) ? X : ListFilter),
    keywords: LIST_KEYWORDS,
    available: ctx => signedIn(ctx.s) && filtersOn(listPrefs(ctx)) > 0,
    run: ctx => ctx.acct.store.getState().setDmList(clearDmFilters(listPrefs(ctx))),
  },
]

// A DM's "Encrypt stored messages", in the sidebar and header menus: either participant
// switches it, as the site allows.
const sealOf = (ctx: ActionCtx) => {
  const dm = dmAt(ctx, null)
  if (!dm || (ctx.target.kind === 'dm' && ctx.target.where === 'home')) return null
  return hostedDmSeal(dm.seal, ctx.s.settings)
}

const sealActions: Action[] = [
  {
    id: 'dm_seal',
    title: SEAL_LABEL,
    icon: Lock,
    ...onDm,
    order: 600,
    keywords: ['encrypt', 'storage'],
    available: ctx => sealOf(ctx) !== null,
    checked: ctx => sealOf(ctx)?.on ?? false,
    disabled: ctx => !(sealOf(ctx)?.available ?? false),
    subtitle: ctx => {
      const st = sealOf(ctx)
      return (st && sealReasonText(st, 'hosted')) ?? undefined
    },
    run: ctx => {
      const st = sealOf(ctx)
      const dm = dmAt(ctx, null)
      if (!st?.available || !dm) return
      void ctx.acct.api
        .setDmSeal(dm.id, !st.on)
        .catch(
          ctx.acct.lifetime.inSession((e: Error) => ctx.acct.store.getState().setError(e.message))
        )
    },
  },
  {
    id: 'dm_seal_earlier',
    title: EARLIER_ACTION,
    icon: Lock,
    ...onDm,
    order: 610,
    keywords: ['encrypt', 'storage'],
    available: ctx => {
      const st = sealOf(ctx)
      return st !== null && st.on && st.reason !== 'permission'
    },
    run: ctx => {
      const dm = dmAt(ctx, null)
      if (dm) ctx.acct.store.getState().openDialog({ kind: 'seal_earlier', place: dmPlace(dm.id) })
    },
  },
]

export const dmActions: Action[] = [
  {
    id: 'dm_open',
    title: 'Open',
    icon: ExternalLink,
    ...onDm,
    order: 100,
    available: ctx => dmAt(ctx, 'home') !== null,
    run: ({ acct, dm }) => {
      if (!dm || (client.shown() !== acct && !client.show(acct))) return
      void acct.store.getState().openDm(dm.id)
    },
  },
  notifySettings('dm_notify', 'dm', ['dm'], notifyScope),
  {
    id: 'dm_pin',
    title: 'Pin DM',
    ...onDm,
    order: 300,
    available: ctx => {
      const dm = dmAt(ctx, 'sidebar')
      return dm !== null && !pinned(ctx, dm)
    },
    run: ({ acct, dm }) => {
      if (dm) acct.store.getState().pinDm(dm.id)
    },
  },
  {
    id: 'dm_unpin',
    title: 'Unpin DM',
    icon: PinOff,
    ...onDm,
    order: 300,
    available: ctx => pinned(ctx, dmAt(ctx, null)),
    run: ({ acct, dm }) => {
      if (dm) acct.store.getState().unpinDm(dm.id)
    },
  },
  ...sealActions,
  {
    id: 'dm_copy_id',
    title: 'Copy DM ID',
    ...onDm,
    order: 930,
    available: ctx => dmAt(ctx, 'sidebar') !== null,
    run: ({ dm }) => {
      if (dm) void sharing().copyText(String(dm.id))
    },
  },
  {
    id: 'dm_copy_user_id',
    title: 'Copy User ID',
    icon: AtSign,
    ...onDm,
    order: 940,
    available: ctx => dmAt(ctx, 'sidebar') !== null,
    run: ({ dm }) => {
      if (dm) void sharing().copyText(dm.other.username)
    },
  },
]
