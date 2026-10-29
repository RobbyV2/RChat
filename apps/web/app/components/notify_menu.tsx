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
  untilText,
  type MuteUntil,
  type NotifyScope,
} from '../lib/notify'

const muteChoices = (apply: (until: MuteUntil) => void): ContextMenuItem[] =>
  MUTE_CHOICES.map(c => ({
    label: c.label,
    action: () => apply(muteUntilFor(c.ms, Date.now())),
  }))

// "Mute …" (or "Unmute …") and "Notification settings" for a channel, DM or server menu.
export const notifyMenuItems = (scope: NotifyScope, noun: string): ContextMenuItem[] => {
  const s = useStore.getState()
  const prefs = s.notifyPrefs
  const now = Date.now()
  const end = muteEnd(prefs, scope, now)
  const serverEnd =
    scope.kind === 'channel' && scope.server !== null
      ? muteEnd(prefs, { kind: 'server', name: scope.server }, now)
      : null
  const own = ownRule(prefs, scope)?.level
  const level = levelOf(prefs, scope)
  const radios: ContextMenuItem[] = LEVELS.map(({ level: l, label }) => ({
    label,
    radio: true,
    checked: scope.kind === 'channel' ? own === l : level === l,
    action: () => s.setNotifyLevel(scope, l),
  }))
  const settings: ContextMenuItem = {
    label: 'Notification settings',
    subtitle:
      scope.kind === 'channel' && !own
        ? `Server default (${levelLabel(level)})`
        : levelLabel(level),
    submenu:
      scope.kind === 'channel'
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

// "Mute folder" mutes each server in it; "Unmute folder" once all of them are muted.
export const folderNotifyItems = (servers: string[]): ContextMenuItem[] => {
  if (!servers.length) return []
  const s = useStore.getState()
  const now = Date.now()
  const ends = servers.map(name => muteEnd(s.notifyPrefs, { kind: 'server', name }, now))
  if (ends.every(e => e !== null)) {
    const same = ends.every(e => e === ends[0])
    return [
      {
        label: 'Unmute folder',
        subtitle: same && ends[0] !== null ? mutedText(ends[0], now) : undefined,
        icon: Bell,
        action: () => s.muteServers(servers, null),
      },
    ]
  }
  return [
    {
      label: 'Mute folder',
      icon: BellOff,
      submenu: muteChoices(until => s.muteServers(servers, until)),
    },
  ]
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
    if (scope.kind !== 'channel' || scope.server === null) return 'Muted'
    const server = muteEnd(s.notifyPrefs, { kind: 'server', name: scope.server }, now)
    return server !== null ? `Server muted ${untilText(server, now)}` : 'Muted'
  })
  if (!muted) return null
  return (
    <span title={title} aria-label={title} role="img" className={`flex shrink-0 ${className}`}>
      <BellOff size={size} aria-hidden />
    </span>
  )
}
