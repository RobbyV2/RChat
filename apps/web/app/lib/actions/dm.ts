// A DM's menu, in the sidebar and on Home's pinned DMs. Marking read, muting and closing are the
// open place's commands (place.ts), and adding or blocking the other person are member actions.

import { AtSign, ExternalLink, PinOff } from 'lucide-react'
import { LEVELS, levelLabel, levelOf, type NotifyScope } from '../notify'
import { sharing } from '../platform'
import { useStore } from '../store'
import type { DmSummary } from '../types'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

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

export const dmActions: Action[] = [
  {
    id: 'dm_open',
    title: 'Open',
    icon: ExternalLink,
    ...onDm,
    order: 100,
    available: ctx => dmAt(ctx, 'home') !== null,
    run: ({ dm }) => {
      if (dm) void get().openDm(dm.id)
    },
  },
  {
    id: 'dm_notify',
    title: 'Notification settings',
    ...onDm,
    order: 130,
    subtitle: ctx => {
      const scope = notifyScope(ctx)
      return scope ? levelLabel(levelOf(ctx.s.notifyPrefs, scope)) : undefined
    },
    args: [
      {
        kind: 'choice',
        name: 'level',
        prompt: 'Notify me about',
        choices: ctx => {
          const scope = notifyScope(ctx)
          const level = scope && levelOf(ctx.s.notifyPrefs, scope)
          return LEVELS.map(l => ({
            value: l.level,
            label: l.label,
            radio: true,
            checked: level === l.level,
          }))
        },
      },
    ],
    available: ctx => notifyScope(ctx) !== null,
    run: (ctx, { level }) => {
      const scope = notifyScope(ctx)
      const pick = LEVELS.find(l => l.level === level)?.level
      if (scope && pick) get().setNotifyLevel(scope, pick)
    },
  },
  {
    id: 'dm_pin',
    title: 'Pin DM',
    ...onDm,
    order: 300,
    available: ctx => {
      const dm = dmAt(ctx, 'sidebar')
      return dm !== null && !pinned(ctx, dm)
    },
    run: ({ dm }) => {
      if (dm) get().pinDm(dm.id)
    },
  },
  {
    id: 'dm_unpin',
    title: 'Unpin DM',
    icon: PinOff,
    ...onDm,
    order: 300,
    available: ctx => pinned(ctx, dmAt(ctx, null)),
    run: ({ dm }) => {
      if (dm) get().unpinDm(dm.id)
    },
  },
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
