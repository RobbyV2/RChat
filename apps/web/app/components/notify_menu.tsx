'use client'

import { Bell, BellOff } from 'lucide-react'
import { scopeMuted, useStore, type ContextMenuItem } from '../lib/store'
import {
  LEVELS,
  MUTE_CHOICES,
  inheritedLevel,
  levelLabel,
  levelOf,
  muteEnd,
  muteUntilFor,
  mutedText,
  ownRule,
  parentScope,
  untilText,
  SUPPRESS_LABELS,
  suppressedOf,
  type MuteUntil,
  type Suppress,
  type NotifyScope,
} from '../lib/notify'

const muteChoices = (apply: (until: MuteUntil) => void): ContextMenuItem[] =>
  MUTE_CHOICES.map(c => ({
    label: c.label,
    action: () => apply(muteUntilFor(c.ms, Date.now())),
  }))

// "Mute …" (or "Unmute …") and "Notification settings" for a P2P channel, DM or server menu.
export const notifyMenuItems = (scope: NotifyScope, noun: string): ContextMenuItem[] => {
  const s = useStore.getState()
  const prefs = s.notifyPrefs
  const now = Date.now()
  const end = muteEnd(prefs, scope, now)
  const parent = parentScope(scope)
  const child = scope.kind === 'channel' || scope.kind === 'p2pc'
  const serverEnd = parent ? muteEnd(prefs, parent, now) : null
  const own = ownRule(prefs, scope)?.level
  const level = levelOf(prefs, scope)
  const radios: ContextMenuItem[] = LEVELS.map(({ level: l, label }) => ({
    label,
    radio: true,
    checked: child ? own === l : level === l,
    action: () => s.setNotifyLevel(scope, l),
  }))
  const settings: ContextMenuItem = {
    label: 'Notification settings',
    subtitle: child && !own ? `Server default (${levelLabel(level)})` : levelLabel(level),
    submenu: child
      ? [
          {
            label: 'Use server default',
            subtitle: levelLabel(inheritedLevel(prefs, scope)),
            radio: true,
            checked: !own,
            action: () => s.setNotifyLevel(scope, null),
          },
          ...radios,
        ]
      : scope.kind === 'server'
        ? [
            ...radios,
            ...(['everyone', 'roles'] as Suppress[]).map(which => {
              const on = suppressedOf(prefs, scope.name, which)
              return {
                label: SUPPRESS_LABELS[which],
                checked: on,
                action: () => s.setNotifySuppress(scope.name, which, !on),
              }
            }),
          ]
        : radios,
  }
  const mute: ContextMenuItem =
    end !== null
      ? {
          label: `Unmute ${noun}`,
          subtitle: mutedText(end, now),
          icon: Bell,
          action: () => s.muteScope(scope, null),
        }
      : {
          label: `Mute ${noun}`,
          subtitle: serverEnd !== null ? `Server muted ${untilText(serverEnd, now)}` : undefined,
          icon: BellOff,
          submenu: muteChoices(until => s.muteScope(scope, until)),
        }
  return [mute, settings]
}

// The muted marker on rows and tiles; the tooltip says until when.
export function MutedIcon({
  scope,
  size = 14,
  className = '',
}: {
  scope: NotifyScope
  size?: number
  className?: string
}) {
  const muted = useStore(s => scopeMuted(s, scope))
  const title = useStore(s => {
    const now = Date.now()
    const own = muteEnd(s.notifyPrefs, scope, now)
    if (own !== null) return mutedText(own, now)
    const parent = parentScope(scope)
    if (!parent) return 'Muted'
    const server = muteEnd(s.notifyPrefs, parent, now)
    return server !== null ? `Server muted ${untilText(server, now)}` : 'Muted'
  })
  if (!muted) return null
  return (
    <span title={title} aria-label={title} role="img" className={`flex shrink-0 ${className}`}>
      <BellOff size={size} aria-hidden />
    </span>
  )
}
