'use client'

import { useAccount } from '../lib/client/react'

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
  peopleIn,
  sentence,
  valueText,
  type AuditFilters,
  type AuditGroup,
  type Part,
} from '../lib/audit'
import { fullTimeOf, relativeTime } from '../lib/timestamps'
import type { AuditEntry, UserRef } from '../lib/types'
import { nameWithUsername } from '../lib/display_name'
import { useMemberSearch } from './member_search'
import { UserAvatar } from './user_avatar'
import { Dialog, Masked, Sentinel, fieldCls } from './ui'
import { NameWithUsername } from './display_name'
import { Grid, Row, Stack, Surface } from './layout'
import { useLooksFor, useShown, useShownMembers } from './shown_user'
import { usePermissionRules } from './use_permission_rules'

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
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const openDialog = useStore(s => s.openDialog)
  const setError = useStore(s => s.setError)
  usePermissionRules()
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
  useLooksFor(server, peopleIn(log.list))

  const fetchFrom = useCallback(
    async (cursor: string | null, mine: number) => {
      const showError = inSession(setError)
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
        showError(errorText(e))
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
  const back = () => openDialog({ kind: 'server_settings', server, section: 'audit' })

  return (
    <Dialog full title="Audit Log" onClose={back}>
      <Stack gap="md">
        <Grid cols={2} gap="sm">
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
          <label className="min-w-0 text-xs text-on-surface-variant">
            <Row as="span" gap="sm">
              From
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={e => setFrom(e.target.value)}
                className={smallField}
              />
            </Row>
          </label>
          <label className="min-w-0 text-xs text-on-surface-variant">
            <Row as="span" gap="sm">
              To
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={e => setTo(e.target.value)}
                className={smallField}
              />
            </Row>
          </label>
        </Grid>
        {log.list.length > 0 && (
          <Stack as="ul" gap="3xs">
            {log.list.map(e => (
              <AuditRow key={e.id} entry={e} server={server} />
            ))}
          </Stack>
        )}
        {log.loaded && !log.loading && log.list.length === 0 && (
          <Surface tone="plain" pad="md">
            <p className="text-center text-sm text-on-surface-variant">
              {filtered ? 'Nothing matches these filters.' : 'Nothing has been logged yet.'}
            </p>
          </Surface>
        )}
        {log.loading && <p className="text-sm text-on-surface-variant">Loading…</p>}
        {log.next !== null && !log.loading && <Sentinel key={log.list.length} onVisible={more} />}
        {log.loaded && log.next === null && log.list.length > 0 && (
          <p className="text-center text-xs text-on-surface-variant">
            Entries are kept for 90 days.
          </p>
        )}
      </Stack>
    </Dialog>
  )
}

export function ActorHit({
  m: account,
  server,
  onPick,
}: {
  m: UserRef
  server: string
  onPick: (shown: UserRef) => void
}) {
  const m = useShownMembers(server)(account)
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onPick(m)}
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
            <ActorHit
              key={m.username}
              m={m}
              server={server}
              onPick={shown => pick(shown.username, nameWithUsername(shown))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Swatch({ field, value }: { field: string; value: unknown }) {
  if (!field.endsWith('color') || typeof value !== 'string') return null
  return (
    <>
      <span
        className="inline-block size-3 rounded-full border border-outline-variant align-middle"
        style={{ backgroundColor: value }}
      />{' '}
    </>
  )
}

// Someone an entry names, as the server shows them now, the username after the name.
function AuditPerson({ part, server }: { part: Part; server: string | null | undefined }) {
  const user = useShown(
    {
      username: part.by ?? '',
      display_name: part.text,
      avatar_kind: 'identicon',
      avatar_color: null,
    },
    server
  )
  return <NameWithUsername user={user} />
}

export function AuditRow({ entry, server = null }: { entry: AuditEntry; server?: string | null }) {
  const [open, setOpen] = useState(false)
  const group = groupOf(entry.action)
  const Icon = group ? ICONS[group] : ScrollText
  const changes = changesOf(entry)
  const facts = factsOf(entry)
  const expandable = !entry.hidden && (changes.length > 0 || facts.length > 0)
  const ms = entry.created_at * 1000
  const body = (
    <>
      <span className="shrink-0 rounded-full bg-secondary-container p-1.5 text-on-secondary-container">
        <Icon size={16} aria-hidden />
      </span>
      <Stack as="span" gap="none" place="flex-1">
        <span className="block text-sm break-words text-on-surface">
          {sentence(entry).map((p, i) =>
            p.name ? (
              <span key={i} className="streamer font-medium">
                {p.person ? (
                  <AuditPerson part={p} server={server} />
                ) : (
                  <Masked text={p.text} by={p.by} />
                )}
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
      </Stack>
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
        <Surface tone="plain" pad="sm">
          <Row gap="md" align="start">
            {body}
          </Row>
        </Surface>
      )}
      {open && expandable && (
        <div className="pr-2 pb-2 pl-12">
          <Surface tone="base" radius="md" pad="sm">
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {changes.map((c, i) => (
                <div key={`c${i}`} className="contents">
                  <dt className="text-on-surface-variant">{fieldLabel(c.field)}</dt>
                  <dd className="break-words text-on-surface">
                    {c.before !== null && (
                      <>
                        <Swatch field={c.field} value={c.before} />
                        <span className="text-on-surface-variant line-through decoration-on-surface-variant/60">
                          <span className={isNameValue(entry, c.field) ? 'streamer' : undefined}>
                            {valueText(c.field, c.before)}
                          </span>
                        </span>
                        {c.after !== null && <span className="text-on-surface-variant"> → </span>}
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
                  <dd
                    className={`break-words text-on-surface ${isNameFact(label) ? 'streamer' : ''}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Surface>
        </div>
      )}
    </li>
  )
}
