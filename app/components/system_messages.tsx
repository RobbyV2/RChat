'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { api } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import { choiceId, systemChoices, systemParts } from '../lib/system_messages'
import type { Message, SystemMessages } from '../lib/types'
import { SettingSwitch } from './admin_panel'
import { longPress } from './context_menu'
import { fmtTime, nameTriggerCls } from './message_pane'
import { profileTrigger } from './profile_card'
import { FieldError, fieldCls, sectionCls, textBtn } from './ui'

// "alice joined the party." with a green arrow, "alice left the server." with a red one.
export function SystemNotice({
  m,
  server,
  divider,
  onMenu,
}: {
  m: Message
  server: string | null
  divider: ReactNode
  onMenu: (m: Message, x: number, y: number) => void
}) {
  const [before, after] = systemParts(m)
  const join = m.kind === 'join'
  const Arrow = join ? ArrowRight : ArrowLeft
  return (
    <div data-row data-mid={m.id}>
      {divider}
      <div
        {...longPress((x, y) => onMenu(m, x, y))}
        data-system={m.kind}
        className="flex items-start gap-3 px-4 py-1 hover:bg-surface-container-low"
      >
        <span
          className={`flex w-9 shrink-0 justify-center pt-0.5 ${join ? 'text-status-green' : 'text-error'}`}
        >
          <Arrow size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
          {before}
          <span
            {...profileTrigger(m.author, server)}
            className={`streamer font-medium text-on-surface ${nameTriggerCls}`}
          >
            {m.author.display_name}
          </span>
          {after}
          <span className="ml-2 text-xs opacity-70">{fmtTime(m.created_at)}</span>
        </p>
      </div>
    </div>
  )
}

export function ServerSystemMessages({ server }: { server: string }) {
  const channels = useStore(s => s.servers[server]?.channels)
  const [saved, setSaved] = useState<SystemMessages | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [tick, setTick] = useState(0)
  const selectId = useId()
  const channelKey = channels?.map(c => c.id).join(',')
  useEffect(() => {
    let live = true
    api.systemMessages(server).then(
      s => {
        if (live) setSaved(s)
      },
      () => {
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [server, tick, channelKey])
  const save = (patch: Partial<SystemMessages>) => {
    if (!saved) return
    setSaving(true)
    setError(null)
    setDone(false)
    setSaved({ ...saved, ...patch })
    api
      .updateSystemMessages(server, patch)
      .then(
        s => {
          setSaved(s)
          setDone(true)
        },
        (err: unknown) => {
          setSaved(saved)
          setError(errorText(err))
        }
      )
      .finally(() => setSaving(false))
  }
  return (
    <>
      <p className={sectionCls}>System messages</p>
      {saved ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={selectId} className="text-sm text-on-surface">
            Channel for join and leave messages
          </label>
          <select
            id={selectId}
            value={saved.channel_id === null ? '' : String(saved.channel_id)}
            disabled={saving}
            onChange={e => save({ channel_id: choiceId(e.target.value) })}
            className={`${fieldCls} max-w-80`}
          >
            {systemChoices(channels ?? [], saved.channel_id).map(c => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-on-surface-variant">
            The default channel is the first text channel.
          </p>
          <div className="-mx-2 flex flex-col">
            <SettingSwitch
              label="Show a message when someone joins"
              value={saved.join_messages}
              onChange={v => (saving ? undefined : save({ join_messages: v }))}
            />
            <SettingSwitch
              label="Show a message when someone leaves"
              value={saved.leave_messages}
              onChange={v => (saving ? undefined : save({ leave_messages: v }))}
            />
          </div>
          {done && !error && (
            <span role="status" className="text-xs text-on-surface">
              Saved.
            </span>
          )}
          <FieldError message={error} />
        </div>
      ) : failed ? (
        <p className="flex items-center gap-2 text-sm text-on-surface-variant">
          Couldn&apos;t load these settings.
          <button
            type="button"
            onClick={() => {
              setFailed(false)
              setTick(t => t + 1)
            }}
            className={textBtn}
          >
            Retry
          </button>
        </p>
      ) : (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      )}
    </>
  )
}
