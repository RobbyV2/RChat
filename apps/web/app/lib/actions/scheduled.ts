// Send later on the composer's Send button (right-click, long-press, Mod+Shift+Enter) and the
// palette, the account's scheduled messages, and the rows of their lists. Hosted and P2P drafts
// and rows read the same way.

import {
  CalendarClock,
  CalendarDays,
  Clock,
  Pencil,
  Play,
  RotateCcw,
  SendHorizontal,
  Sunrise,
  Trash2,
} from 'lucide-react'
import type { AccountSession } from '../client/session'
import {
  type ComposerDraft,
  isUnsent,
  type PresetKind,
  presetLabel,
  presetTime,
  PRESET_KINDS,
  type ScheduledRow,
  whenText,
} from '../scheduled'
import { signedIn } from './global'
import type { Action, ActionCtx, ArgChoice } from './types'
import { unnamed, notAName } from '../names'

const PICK = 'pick'

const PRESET_ICONS = { hour: Clock, tomorrow: Sunrise, monday: CalendarDays } as const

// The composer Send later reads from the palette: the last one shown for each account.
const open = new WeakMap<AccountSession, () => ComposerDraft | null>()

// Makes `now` the composer the palette's Send later reads; the answer takes it back, unless
// another composer took its place.
export const setOpenComposer = (acct: AccountSession, now: () => ComposerDraft | null) => {
  open.set(acct, now)
  return () => {
    if (open.get(acct) === now) open.delete(acct)
  }
}

const draftOf = ({ target, acct }: ActionCtx): ComposerDraft | null => {
  if (target.kind === 'composer') return target.now()
  if (target.kind === 'none') return open.get(acct)?.() ?? null
  return null
}

const rowOf = ({ target }: ActionCtx): ScheduledRow | null =>
  target.kind === 'scheduled' ? target.now() : null

const at = (kind: PresetKind, now: number) => presetTime(kind, new Date(now))

// The presets and the picker as choices; `blocked` dims them with the reason.
const choices = (blocked: string | null, now: number): ArgChoice[] => [
  ...PRESET_KINDS.map(kind => ({
    value: kind,
    label: notAName(presetLabel(kind, new Date(now))),
    subtitle: blocked ?? whenText(at(kind, now), now),
    icon: PRESET_ICONS[kind],
    disabled: blocked !== null,
  })),
  {
    value: PICK,
    label: unnamed('Pick a date and time'),
    subtitle: blocked ?? undefined,
    icon: CalendarClock,
    disabled: blocked !== null,
  },
]

const isPreset = (v: string): v is PresetKind => (PRESET_KINDS as readonly string[]).includes(v)

const composer = { scope: 'channel', targets: ['composer'] } as const

const preset = (kind: PresetKind, order: number): Action => ({
  id: `send_later_${kind}`,
  title: kind === 'hour' ? 'In 1 hour' : kind === 'tomorrow' ? 'Tomorrow morning' : 'Next Monday',
  icon: PRESET_ICONS[kind],
  ...composer,
  order,
  label: ctx => notAName(presetLabel(kind, new Date(ctx.acct.time.now()))),
  subtitle: ctx =>
    draftOf(ctx)?.blocked ?? whenText(at(kind, ctx.acct.time.now()), ctx.acct.time.now()),
  available: ctx => draftOf(ctx) !== null,
  disabled: ctx => !!draftOf(ctx)?.blocked,
  run: ctx => {
    const d = draftOf(ctx)
    if (d && !d.blocked) void d.schedule(at(kind, ctx.acct.time.now()))
  },
})

export const scheduledActions: Action[] = [
  preset('hour', 100),
  preset('tomorrow', 110),
  preset('monday', 120),
  {
    id: 'send_later_pick',
    title: 'Pick a date and time',
    icon: CalendarClock,
    ...composer,
    order: 130,
    subtitle: ctx => draftOf(ctx)?.blocked ?? undefined,
    available: ctx => draftOf(ctx) !== null,
    disabled: ctx => !!draftOf(ctx)?.blocked,
    run: ctx => {
      const d = draftOf(ctx)
      if (d && !d.blocked) d.pick()
    },
  },
  {
    id: 'send_later',
    title: 'Send later',
    keywords: ['schedule', 'scheduled'],
    icon: CalendarClock,
    scope: 'channel',
    group: 'commands',
    available: ctx => ctx.via === 'palette' && draftOf(ctx) !== null,
    args: [
      {
        kind: 'choice',
        name: 'when',
        prompt: 'When',
        choices: ctx => choices(draftOf(ctx)?.blocked ?? null, ctx.acct.time.now()),
      },
    ],
    run: (ctx, args) => {
      const d = draftOf(ctx)
      if (!d || d.blocked) return
      if (args.when === PICK) d.pick()
      else if (isPreset(args.when)) void d.schedule(at(args.when, ctx.acct.time.now()))
    },
  },
  {
    id: 'scheduled_open',
    title: 'Scheduled messages',
    keywords: ['send later', 'schedule'],
    icon: CalendarClock,
    scope: 'global',
    group: 'navigation',
    available: ({ s }) => signedIn(s),
    run: ({ acct }) => acct.store.getState().openDialog({ kind: 'scheduled' }),
  },
  {
    id: 'scheduled_edit',
    title: 'Edit',
    icon: Pencil,
    scope: 'message',
    targets: ['scheduled'],
    order: 100,
    available: ctx => {
      const r = rowOf(ctx)
      return r !== null && r.item.state !== 'sending' && r.item.poll === null
    },
    run: ctx => rowOf(ctx)?.edit(),
  },
  {
    id: 'scheduled_send_now',
    title: 'Send now',
    icon: SendHorizontal,
    scope: 'message',
    targets: ['scheduled'],
    order: 110,
    label: ctx => {
      const r = rowOf(ctx)
      return unnamed(r && isUnsent(r.item) ? 'Retry' : 'Send now')
    },
    iconFor: ctx => {
      const r = rowOf(ctx)
      return r && isUnsent(r.item) ? RotateCcw : SendHorizontal
    },
    available: ctx => {
      const r = rowOf(ctx)
      return r !== null && r.item.state !== 'sending' && r.item.state !== 'paused'
    },
    run: ctx => void rowOf(ctx)?.sendNow(),
  },
  {
    id: 'scheduled_resume',
    title: 'Resume',
    icon: Play,
    scope: 'message',
    targets: ['scheduled'],
    order: 110,
    available: ctx => rowOf(ctx)?.item.state === 'paused',
    run: ctx => void rowOf(ctx)?.resume(),
  },
  {
    id: 'scheduled_reschedule',
    title: 'Reschedule',
    icon: CalendarClock,
    scope: 'message',
    targets: ['scheduled'],
    order: 120,
    available: ctx => {
      const r = rowOf(ctx)
      return r !== null && r.item.state !== 'sending'
    },
    args: [
      {
        kind: 'choice',
        name: 'when',
        prompt: 'When',
        choices: ctx => choices(null, ctx.acct.time.now()),
      },
    ],
    run: (ctx, args) => {
      const r = rowOf(ctx)
      if (!r) return
      if (args.when === PICK) r.pick()
      else if (isPreset(args.when)) void r.reschedule(at(args.when, ctx.acct.time.now()))
    },
  },
  {
    id: 'scheduled_delete',
    title: 'Delete',
    icon: Trash2,
    danger: true,
    scope: 'message',
    targets: ['scheduled'],
    order: 300,
    available: ctx => {
      const r = rowOf(ctx)
      return r !== null && r.item.state !== 'sending'
    },
    args: [
      {
        kind: 'confirm',
        title: 'Delete Scheduled Message',
        body: () => 'It will not be sent.',
        confirm: 'Delete',
      },
    ],
    run: ctx => void rowOf(ctx)?.remove(),
  },
]
