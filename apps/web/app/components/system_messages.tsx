'use client'

import { useStoreApi } from '../lib/client/react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Lock, LockOpen } from 'lucide-react'
import { errorText, useMask } from '../lib/store'
import { useLive } from '../lib/place/react'
import {
  systemMessagesOf,
  type SystemPlace,
  type SystemSettings,
} from '../lib/place/system_messages'
import {
  SITE_NAME,
  SYSTEM_CHANNEL_LABEL,
  SYSTEM_DEFAULT_NOTE,
  SYSTEM_JOIN_LABEL,
  SYSTEM_LEAVE_LABEL,
  bySite,
  isStorage,
  sealsFromHere,
  systemParts,
} from '../lib/system_messages'
import type { Message } from '../lib/types'
import { Button } from './controls'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { longPress } from './context_menu'
import { MessageTime } from './timestamp'
import { profileTrigger } from './profile_card'
import { fieldCls, FieldError } from './ui'
import { Name } from './name'
import { personCalled } from '../lib/names'
import { ShownName } from './shown_user'
import { Inset, Row, Stack } from './layout'

// "alice joined the party." with a green arrow, "alice left the server." with a red one, a
// storage line with a lock.
export function SystemNotice({
  m,
  server,
  divider,
  local = false,
  onMenu,
}: {
  m: Message
  server: string | null
  divider: ReactNode
  // A place that knows people by key: the name opens no profile.
  local?: boolean
  onMenu?: (m: Message, x: number, y: number) => void
}) {
  const store = useStoreApi()
  const [before, after] = systemParts(m)
  const join = m.kind === 'join'
  const storage = isStorage(m)
  const Arrow = storage ? (sealsFromHere(m) ? Lock : LockOpen) : join ? ArrowRight : ArrowLeft
  const tone = storage ? 'text-on-surface-variant' : join ? 'text-status-green' : 'text-error'
  return (
    <div data-row data-mid={m.id}>
      {divider}
      <Inset
        {...(onMenu ? longPress((x, y) => onMenu(m, x, y)) : {})}
        data-system={m.kind}
        row
        pad="lg"
        inset="line"
        gap="md"
        align="start"
        look={onMenu ? 'hover:bg-surface-container-low' : undefined}
      >
        <span className={`flex h-lh w-9 shrink-0 items-center justify-center ${tone}`}>
          <Arrow size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
          {before}
          {bySite(m) ? (
            <span className="font-medium text-on-surface">{SITE_NAME}</span>
          ) : local ? (
            <Name
              of={personCalled(m.author.display_name, m.author.username)}
              look="font-medium text-on-surface"
            />
          ) : (
            <ShownName
              user={m.author}
              server={server}
              link
              {...profileTrigger(store, m.author, server)}
              look="font-medium text-on-surface"
            />
          )}
          {after} <MessageTime ts={m.created_at} className="text-xs opacity-70" />
        </p>
      </Inset>
    </div>
  )
}

// Where a server's or a room's join and leave lines go and which of them show. Whoever may not
// change them reads them.
export function SystemMessagesSection({ place }: { place: SystemPlace }) {
  const at = systemMessagesOf(place)
  const shown = useLive(at.settings)
  const editor = useLive(at.editor)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const selectId = useId()
  const ready = shown.state === 'ready' ? shown : null
  const mask = useMask(!ready?.masked)
  const channelKey = ready?.choices
    .filter(c => c.channel !== undefined)
    .map(c => c.value)
    .join(',')
  useEffect(() => at.load(), [at, channelKey])
  if (!ready)
    return shown.state === 'failed' ? (
      <Row gap="sm">
        <p className="text-sm text-on-surface-variant">Couldn&apos;t load these settings.</p>
        <Button onClick={at.load}>Retry</Button>
      </Row>
    ) : (
      <p className="text-sm text-on-surface-variant">Loading…</p>
    )
  const locked = editor === null || saving
  const save = (patch: Partial<SystemSettings>) => {
    if (!editor || saving) return
    setSaving(true)
    setError(null)
    setDone(false)
    editor
      .save(patch)
      .then(
        () => setDone(true),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setSaving(false))
  }
  const { settings, choices } = ready
  return (
    <Stack gap="sm">
      <SettingNotes gap="2xs">
        <label htmlFor={selectId} className="text-sm text-on-surface">
          {SYSTEM_CHANNEL_LABEL}
        </label>
        <select
          id={selectId}
          value={settings.channel}
          disabled={locked}
          onChange={e => save({ channel: e.target.value })}
          className={`${fieldCls} max-w-80`}
        >
          {choices.map(c => (
            <option key={c.value} value={c.value}>
              {c.channel === undefined ? c.label : `#${mask(c.channel)}`}
            </option>
          ))}
        </select>
        <p className="text-xs text-on-surface-variant">{SYSTEM_DEFAULT_NOTE}</p>
      </SettingNotes>
      <Stack gap="none">
        <SettingSwitch
          label={SYSTEM_JOIN_LABEL}
          value={settings.join}
          disabled={locked}
          onChange={join => save({ join })}
        />
        <SettingSwitch
          label={SYSTEM_LEAVE_LABEL}
          value={settings.leave}
          disabled={locked}
          onChange={leave => save({ leave })}
        />
      </Stack>
      {(at.note !== null || error !== null || done) && (
        <SettingNotes gap="2xs">
          {done && !error && (
            <span role="status" className="text-xs text-on-surface">
              Saved.
            </span>
          )}
          <FieldError message={error} />
          {at.note !== null && <p className="text-xs text-on-surface-variant">{at.note}</p>}
        </SettingNotes>
      )}
    </Stack>
  )
}
