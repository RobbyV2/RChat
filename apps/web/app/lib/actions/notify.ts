// What muting and "Notification settings" share across the DM, channel, server and folder menus.

import {
  LEVELS,
  MUTE_CHOICES,
  SUPPRESS_LABELS,
  inheritedLevel,
  levelLabel,
  levelOf,
  muteUntilFor,
  ownRule,
  suppressedOf,
  type MuteUntil,
  type NotifyPrefs,
  type NotifyScope,
  type Suppress,
} from '../notify'
import { useStore } from '../store'
import type { Action, ActionCtx, ArgChoice, ArgStep, Scope, Target } from './types'

const SUPPRESS: Suppress[] = ['everyone', 'roles']

export const muteStep: ArgStep = {
  kind: 'choice',
  name: 'value',
  prompt: 'For how long',
  choices: () =>
    MUTE_CHOICES.map(c => ({ value: c.ms === null ? 'forever' : String(c.ms), label: c.label })),
}

export const muteUntil = (value: string): MuteUntil =>
  value === 'forever' ? 'forever' : muteUntilFor(Number(value), Date.now())

// A channel inherits its server's level until it has its own.
const inherits = (scope: NotifyScope) => scope.kind === 'channel' || scope.kind === 'p2pc'

const levelChoices = (p: NotifyPrefs, scope: NotifyScope): ArgChoice[] => {
  const own = ownRule(p, scope)?.level
  const level = levelOf(p, scope)
  const radios = LEVELS.map(l => ({
    value: l.level,
    label: l.label,
    radio: true,
    checked: inherits(scope) ? own === l.level : level === l.level,
  }))
  if (inherits(scope))
    return [
      {
        value: 'default',
        label: 'Use server default',
        subtitle: levelLabel(inheritedLevel(p, scope)),
        radio: true,
        checked: !own,
      },
      ...radios,
    ]
  if (scope.kind !== 'server') return radios
  return [
    ...radios,
    ...SUPPRESS.map(which => ({
      value: `suppress_${which}`,
      label: SUPPRESS_LABELS[which],
      checked: suppressedOf(p, scope.name, which),
    })),
  ]
}

const applyLevel = (scope: NotifyScope, value: string) => {
  const s = useStore.getState()
  const which = SUPPRESS.find(w => value === `suppress_${w}`)
  if (which && scope.kind === 'server')
    s.setNotifySuppress(scope.name, which, !suppressedOf(s.notifyPrefs, scope.name, which))
  else if (value === 'default' && inherits(scope)) s.setNotifyLevel(scope, null)
  else {
    const level = LEVELS.find(l => l.level === value)?.level
    if (level) s.setNotifyLevel(scope, level)
  }
}

// "Notification settings" for the menus of `targets`: the level radios, a channel's server
// default, a server's suppress checks.
export const notifySettings = (
  id: string,
  scope: Scope,
  targets: readonly Target['kind'][],
  of: (ctx: ActionCtx) => NotifyScope | null
): Action => ({
  id,
  title: 'Notification settings',
  scope,
  targets,
  order: 130,
  subtitle: ctx => {
    const at = of(ctx)
    if (!at) return undefined
    const p = ctx.s.notifyPrefs
    const label = levelLabel(levelOf(p, at))
    return inherits(at) && !ownRule(p, at)?.level ? `Server default (${label})` : label
  },
  args: [
    {
      kind: 'choice',
      name: 'value',
      prompt: 'Notify me about',
      choices: ctx => {
        const at = of(ctx)
        return at ? levelChoices(ctx.s.notifyPrefs, at) : []
      },
    },
  ],
  available: ctx => of(ctx) !== null,
  run: (ctx, { value }) => {
    const at = of(ctx)
    if (at) applyLevel(at, value)
  },
})
