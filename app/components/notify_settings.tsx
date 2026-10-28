'use client'

import { useState, useSyncExternalStore } from 'react'
import { useStore } from '../lib/store'
import { notifications, type Permission } from '../lib/platform'
import { ruleSummary, type NotifyScope, type Rule } from '../lib/notify'
import { SettingSwitch } from './admin_panel'
import { sectionCls, textBtn } from './server_settings'

interface Override {
  key: string
  scope: NotifyScope
  name: string
  hint?: string
  prefix?: string
  rule: Rule
}

const groupCls = 'px-2 pt-3 pb-1 text-xs font-medium text-on-surface-variant'

const subscribePermission = (cb: () => void) => notifications().onPermissionChange(cb)
const readPermission = () => notifications().permission()
const serverPermission = (): Permission => 'default'

function DesktopSwitch() {
  const on = useStore(s => s.notifyPrefs.desktop)
  const setDesktop = useStore(s => s.setDesktopNotify)
  const [help, setHelp] = useState<string | null>(null)
  const permission = useSyncExternalStore(subscribePermission, readPermission, serverPermission)
  const blocked =
    "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."

  const toggle = (next: boolean) => {
    setHelp(null)
    if (!next) {
      setDesktop(false)
      return
    }
    const now = notifications().permission()
    if (now === 'unsupported') {
      setHelp("This browser can't show desktop notifications.")
      return
    }
    if (now === 'granted') {
      setDesktop(true)
      return
    }
    if (now === 'denied') {
      setHelp(blocked)
      return
    }
    void notifications()
      .requestPermission()
      .then(p => {
        if (p === 'granted') setDesktop(true)
        else setHelp(p === 'denied' ? blocked : 'Permission was not granted.')
      })
  }

  return (
    <>
      <SettingSwitch
        label="Desktop notifications"
        value={on && permission === 'granted'}
        onChange={toggle}
      />
      {help ? (
        <p role="alert" className="mt-2 px-2 text-xs text-error">
          {help}
        </p>
      ) : (
        <p className="mt-2 px-2 text-xs text-on-surface-variant">
          Shows a system notification for anything that would pop up here, while this tab is in the
          background. Streamer mode leaves out names and message text.
        </p>
      )}
    </>
  )
}

function OverrideRow({ o, now }: { o: Override; now: number }) {
  const reset = useStore(s => s.resetNotify)
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-container">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-on-surface">
          {o.prefix}
          <span className="streamer">{o.name}</span>
          {o.hint && (
            <span className="text-on-surface-variant">
              {' · '}
              <span className="streamer">{o.hint}</span>
            </span>
          )}
        </span>
        <span className="truncate text-xs text-on-surface-variant">{ruleSummary(o.rule, now)}</span>
      </span>
      <button className={`${textBtn} shrink-0`} onClick={() => reset(o.scope)}>
        Reset
      </button>
    </li>
  )
}

function Group({ title, list, now }: { title: string; list: Override[]; now: number }) {
  if (!list.length) return null
  return (
    <>
      <p className={groupCls}>{title}</p>
      <ul className="flex flex-col">
        {list.map(o => (
          <OverrideRow key={o.key} o={o} now={now} />
        ))}
      </ul>
    </>
  )
}

const useOverrides = () => {
  const prefs = useStore(s => s.notifyPrefs)
  const me = useStore(s => s.me)
  const servers = useStore(s => s.servers)
  const guestNames = useStore(s => s.guestNames)
  const dms = useStore(s => s.dms)
  const serverName = (name: string) =>
    servers[name]?.display_name ??
    me?.servers.find(x => x.name === name)?.display_name ??
    guestNames[name] ??
    name
  const channelOf = (id: number) => {
    for (const detail of Object.values(servers)) {
      const c = detail.channels.find(x => x.id === id)
      if (c) return { name: c.name, server: detail.display_name }
    }
    return null
  }
  const serverList: Override[] = Object.entries(prefs.servers).map(([name, rule]) => ({
    key: `s:${name}`,
    scope: { kind: 'server', name },
    name: serverName(name),
    rule,
  }))
  const channelList: Override[] = Object.entries(prefs.channels).map(([id, rule]) => {
    const c = channelOf(Number(id))
    return {
      key: `c:${id}`,
      scope: { kind: 'channel', id: Number(id), server: null },
      prefix: c ? '#' : undefined,
      name: c ? c.name : `Channel ${id}`,
      hint: c?.server,
      rule,
    }
  })
  const dmList: Override[] = Object.entries(prefs.dms).map(([id, rule]) => {
    const dm = dms.find(d => d.id === Number(id))
    return {
      key: `d:${id}`,
      scope: { kind: 'dm', id: Number(id) },
      name: dm ? dm.other.display_name : `DM ${id}`,
      rule,
    }
  })
  return { serverList, channelList, dmList }
}

export function NotificationsSection() {
  const resetAll = useStore(s => s.resetAllNotify)
  const { serverList, channelList, dmList } = useOverrides()
  const any = serverList.length + channelList.length + dmList.length > 0
  const now = Date.now()
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className={sectionCls}>Desktop</p>
        <DesktopSwitch />
      </section>
      <section>
        <div className="flex items-center justify-between gap-2">
          <p className={sectionCls}>Custom settings</p>
          {any && (
            <button className={`${textBtn} -mt-2`} onClick={resetAll}>
              Reset all
            </button>
          )}
        </div>
        <p className="px-2 text-xs text-on-surface-variant">
          Servers notify you for @mentions, replies and reactions. DMs notify you for every message.
          Right-click or long-press a server, channel or DM to mute it or change this.
        </p>
        {any ? (
          <>
            <Group title="Servers" list={serverList} now={now} />
            <Group title="Channels" list={channelList} now={now} />
            <Group title="DMs" list={dmList} now={now} />
          </>
        ) : (
          <p className="mt-4 px-2 text-sm text-on-surface-variant">No custom settings yet.</p>
        )}
      </section>
    </div>
  )
}
