'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Hash,
  KeyRound,
  MessageSquare,
  ScrollText,
  Server,
  Shield,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import {
  AUDIT_GROUPS,
  NO_FILTERS,
  auditQuery,
  changesOf,
  factsOf,
  isNameValue,
  isNameFact,
  fieldLabel,
  groupOf,
  sentence,
  valueText,
  type AuditFilters,
  type AuditGroup,
} from '../lib/audit'
import { fullTimeOf, relativeTime } from '../lib/timestamps'
import type { AuditEntry, UserRef } from '../lib/types'
import { nameWithUsername } from '../lib/display_name'
import { useMemberSearch } from './server_settings'
import { UserAvatar } from './user_avatar'
import { Dialog, Masked, Sentinel, fieldCls } from './ui'
import { NameWithUsername } from './display_name'

const TEXT_DEBOUNCE = 300
const SUGGESTIONS = 5

const ICONS: Record<AuditGroup, LucideIcon> = {
  member: Users,
  role: Shield,
  channel: Hash,
  server: Server,
  access: KeyRound,
  message: MessageSquare,
  webhook: Webhook,
}

const smallField = `${fieldCls} w-full`

interface LogState {
  list: AuditEntry[]
  next: string | null
  loading: boolean
  loaded: boolean
}

const EMPTY: LogState = { list: [], next: null, loading: false, loaded: false }

export default function AuditLogDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'audit_log' ? <AuditLog server={dialog.server} /> : null
}

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return out
}

function AuditLog({ server }: { server: string }) {
  const openDialog = useStore(s => s.openDialog)
  const setError = useStore(s => s.setError)
  const [group, setGroup] = useState<AuditGroup | ''>('')
  const [actor, setActor] = useState('')
  const [targetText, setTargetText] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const target = useDebounced(targetText, TEXT_DEBOUNCE)
  const filters: AuditFilters = { ...NO_FILTERS, group, actor, target, from, to }
  const key = JSON.stringify(auditQuery(filters))
  const [log, setLog] = useState<LogState>(EMPTY)
  const epoch = useRef(0)

  const fetchFrom = useCallback(
    async (cursor: string | null, mine: number) => {
      setLog(s => ({ ...s, loading: true }))
      try {
        const page = await api.listAudit(server, cursor, JSON.parse(key))
        if (epoch.current !== mine) return
        setLog(s => {
          const base = cursor === null ? [] : s.list
          const seen = new Set(base.map(e => e.id))
          return {
            list: [...base, ...page.items.filter(e => !seen.has(e.id))],
            next: page.next,
            loading: false,
            loaded: true,
          }
        })
      } catch (e) {
        if (epoch.current !== mine) return
        setLog(s => ({ ...s, loading: false, loaded: true, next: null }))
        setError(errorText(e))
      }
    },
    [server, key, setError]
  )

  useEffect(() => {
    const mine = ++epoch.current
    setLog(EMPTY)
    void fetchFrom(null, mine)
  }, [fetchFrom])

  const more = useCallback(() => {
    if (log.loading || log.next === null) return
    void fetchFrom(log.next, epoch.current)
  }, [log, fetchFrom])

  const filtered = key !== '{}'
  const back = () => openDialog({ kind: 'server_settings', server })

  return (
    <Dialog full title="Audit Log" onClose={back}>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="col-span-2 sm:col-span-1">
          <span className="sr-only">Action type</span>
          <select
            value={group}
            onChange={e => setGroup(e.target.value as AuditGroup | '')}
            title="Action type"
            className={`${smallField} bg-surface-container-high`}
          >
            <option value="">All actions</option>
            {AUDIT_GROUPS.map(g => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <ActorField server={server} value={actor} onChange={setActor} />
        <input
          type="search"
          value={targetText}
          onChange={e => setTargetText(e.target.value)}
          placeholder="Target name"
          title="Only entries whose target name contains this"
          aria-label="Target name"
          className={`${smallField} col-span-2`}
        />
        <label className="flex min-w-0 items-center gap-2 text-xs text-on-surface-variant">
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={e => setFrom(e.target.value)}
            className={smallField}
          />
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs text-on-surface-variant">
          To
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={e => setTo(e.target.value)}
            className={smallField}
          />
        </label>
      </div>
      <ul className="space-y-0.5">
        {log.list.map(e => (
          <AuditRow key={e.id} entry={e} />
        ))}
      </ul>
      {log.loaded && !log.loading && log.list.length === 0 && (
        <p className="px-2 py-6 text-center text-sm text-on-surface-variant">
          {filtered ? 'Nothing matches these filters.' : 'Nothing has been logged yet.'}
        </p>
      )}
      {log.loading && <p className="px-2 py-3 text-sm text-on-surface-variant">Loading…</p>}
      {log.next !== null && !log.loading && <Sentinel key={log.list.length} onVisible={more} />}
      {log.loaded && log.next === null && log.list.length > 0 && (
        <p className="px-2 pt-3 text-center text-xs text-on-surface-variant">
          Entries are kept for 90 days.
        </p>
      )}
    </Dialog>
  )
}

export function ActorHit({ m, onPick }: { m: UserRef; onPick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-surface-container-high"
    >
      <UserAvatar
        username={m.username}
        avatarKind={m.avatar_kind}
        avatarColor={m.avatar_color}
        size={20}
      />
      <span className="streamer min-w-0 flex-1 truncate text-sm">
        <NameWithUsername user={m} />
      </span>
    </button>
  )
}

function ActorField({
  server,
  value,
  onChange,
}: {
  server: string
  value: string
  onChange: (username: string) => void
}) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const found = useMemberSearch(server, open ? text : '')
  const hits = found.list.slice(0, SUGGESTIONS)
  const pick = (username: string, shown: string) => {
    onChange(username)
    setText(shown)
    setOpen(false)
  }
  return (
    <div className="relative col-span-2 sm:col-span-1">
      <input
        type="text"
        value={text}
        onChange={e => {
          setText(e.target.value)
          setOpen(true)
          if (!e.target.value.trim()) onChange('')
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') pick(text.trim().toLowerCase(), text.trim())
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Done by"
        title="Only entries by this member. Press Enter to use a username."
        aria-label="Done by"
        className={`${smallField} ${value ? 'streamer pr-9' : ''}`}
      />
      {value && (
        <button
          type="button"
          title="Clear member filter"
          aria-label="Clear member filter"
          onClick={() => pick('', '')}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest"
        >
          <X size={14} />
        </button>
      )}
      {open && found.active && hits.length > 0 && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 rounded-xl bg-surface-container-highest p-1 shadow-elevation-2">
          {hits.map(m => (
            <ActorHit key={m.username} m={m} onPick={() => pick(m.username, nameWithUsername(m))} />
          ))}
        </div>
      )}
    </div>
  )
}

function Swatch({ field, value }: { field: string; value: unknown }) {
  if (!field.endsWith('color') || typeof value !== 'string') return null
  return (
    <span
      className="mr-1 inline-block size-3 rounded-full border border-outline-variant align-middle"
      style={{ backgroundColor: value }}
    />
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false)
  const group = groupOf(entry.action)
  const Icon = group ? ICONS[group] : ScrollText
  const changes = changesOf(entry)
  const facts = factsOf(entry)
  const expandable = !entry.hidden && (changes.length > 0 || facts.length > 0)
  const ms = entry.created_at * 1000
  const body = (
    <>
      <span className="mt-0.5 shrink-0 rounded-full bg-secondary-container p-1.5 text-on-secondary-container">
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm break-words text-on-surface">
          {sentence(entry).map((p, i) =>
            p.name ? (
              <span key={i} className="streamer font-medium">
                <Masked text={p.text} />
              </span>
            ) : (
              <span key={i}>{p.text}</span>
            )
          )}
        </span>
        <span
          className="block text-xs text-on-surface-variant"
          title={fullTimeOf(entry.created_at)}
        >
          {relativeTime(ms, Date.now())}
          {entry.hidden && ' · Details hidden'}
        </span>
      </span>
    </>
  )
  return (
    <li className="rounded-xl hover:bg-surface-container-highest">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Hide details' : 'Show details'}
          className="flex w-full items-start gap-3 px-2 py-2 text-left"
        >
          {body}
          <ChevronDown
            size={16}
            aria-hidden
            className={`mt-1 shrink-0 text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      ) : (
        <div className="flex items-start gap-3 px-2 py-2">{body}</div>
      )}
      {open && expandable && (
        <dl className="mx-2 mb-2 ml-12 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-surface-container p-2 text-xs">
          {changes.map((c, i) => (
            <div key={`c${i}`} className="contents">
              <dt className="text-on-surface-variant">{fieldLabel(c.field)}</dt>
              <dd className="break-words text-on-surface">
                {c.before !== null && (
                  <>
                    <span className="text-on-surface-variant line-through decoration-on-surface-variant/60">
                      <Swatch field={c.field} value={c.before} />
                      <span className={isNameValue(entry, c.field) ? 'streamer' : undefined}>
                        {valueText(c.field, c.before)}
                      </span>
                    </span>
                    {c.after !== null && <span className="px-1 text-on-surface-variant">→</span>}
                  </>
                )}
                {(c.after !== null || c.before === null) && (
                  <span>
                    <Swatch field={c.field} value={c.after} />
                    <span className={isNameValue(entry, c.field) ? 'streamer' : undefined}>
                      {valueText(c.field, c.after)}
                    </span>
                  </span>
                )}
              </dd>
            </div>
          ))}
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-on-surface-variant">{label}</dt>
              <dd className={`break-words text-on-surface ${isNameFact(label) ? 'streamer' : ''}`}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}
