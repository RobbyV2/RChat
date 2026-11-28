'use client'

import { IconButton } from './controls'
import { personName } from '../lib/names'
import { Name } from './name'

import { useEffect, useState } from 'react'
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
import { useStore } from '../lib/store'
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
import { Dialog, Masked, fieldCls } from './ui'
import { auditPage } from '../lib/asks'
import { Loaded, More, useAccountPages } from './loaded'
import { Grid, Inset, Row, Stack, Surface } from './layout'
import { useLooksFor, useShown, useShownMembers } from './shown_user'
import { usePermissionRules } from './use_permission_rules'
import { useStable } from '../lib/stable_key'
import { time } from '../lib/platform/time'

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

export default function AuditLogDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'audit_log' ? <AuditLog server={dialog.server} /> : null
}

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const t = time().after(ms, () => setOut(value))
    return () => t()
  }, [value, ms])
  return out
}

// The entries of one page run, with the looks of the people they name.
function AuditRows({ entries, server }: { entries: AuditEntry[]; server: string }) {
  useLooksFor(server, peopleIn(entries))
  return (
    <Stack as="ul" gap="3xs">
      {entries.map(e => (
        <AuditRow key={e.id} entry={e} server={server} />
      ))}
    </Stack>
  )
}

function AuditLog({ server }: { server: string }) {
  const openDialog = useStore(s => s.openDialog)
  usePermissionRules()
  const [group, setGroup] = useState<AuditGroup | ''>('')
  const [actor, setActor] = useState('')
  const [targetText, setTargetText] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const target = useDebounced(targetText, TEXT_DEBOUNCE)
  const filters: AuditFilters = { ...NO_FILTERS, group, actor, target, from, to }
  const query = useStable(auditQuery(filters))
  const [log] = useAccountPages(auditPage(server, query), entry => entry.id, [server, query])

  const filtered = Object.keys(query).length > 0
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
        <Loaded
          load={log}
          what="the audit log"
          empty={
            <Surface tone="plain" pad="md">
              <p className="text-center text-sm text-on-surface-variant">
                {filtered ? 'Nothing matches these filters.' : 'Nothing has been logged yet.'}
              </p>
            </Surface>
          }
        >
          {found => (
            <>
              <AuditRows entries={found.items} server={server} />
              <More pages={found} auto />
              {found.more === null && !found.loadingMore && found.refusal === null && (
                <p className="text-center text-xs text-on-surface-variant">
                  Entries are kept for 90 days.
                </p>
              )}
            </>
          )}
        </Loaded>
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
    <Surface
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => onPick(m)}
      as="button"
      row
      pad="sm"
      inset="chip"
      gap="sm"
      tone="plain"
      radius="md"
      look="text-left hover:bg-surface-container-high"
      place="w-full"
    >
      <UserAvatar person={m} size={20} />
      <Name of={personName(m)} withUsername look="min-w-0 flex-1 truncate text-sm" />
    </Surface>
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
        onBlur={() => time().after(150, () => setOpen(false))}
        placeholder="Done by"
        title="Only entries by this member. Press Enter to use a username."
        aria-label="Done by"
        className={`${smallField} ${value ? 'streamer' : ''}`}
      />
      {value && (
        <IconButton
          icon={X}
          label="Clear member filter"
          size="sm"
          type="button"
          onClick={() => pick('', '')}
          place="absolute top-1/2 right-1.5 -translate-y-1/2"
        />
      )}
      {open && found.active && hits.length > 0 && (
        <Surface
          pad="2xs"
          tone="highest"
          radius="lg"
          elevation={2}
          place="absolute inset-x-0 top-full z-raised translate-y-1"
        >
          {hits.map(m => (
            <ActorHit
              key={m.username}
              m={m}
              server={server}
              onPick={shown => pick(shown.username, nameWithUsername(shown))}
            />
          ))}
        </Surface>
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
  return <Name of={personName(user)} withUsername />
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
      <Surface as="span" pad="xs" tone="secondary" radius="full" place="shrink-0">
        <Icon size={16} aria-hidden />
      </Surface>
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
          {relativeTime(ms, time().now())}
          {entry.hidden && ' · Details hidden'}
        </span>
      </Stack>
    </>
  )
  return (
    <li className="rounded-xl hover:bg-surface-container-highest">
      {expandable ? (
        <Inset
          as="button"
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Hide details' : 'Show details'}
          pad="sm"
          gap="md"
          row
          align="start"
          look="text-left"
          place="w-full"
        >
          {body}
          <ChevronDown
            size={16}
            aria-hidden
            className={`shrink-0 text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </Inset>
      ) : (
        <Surface tone="plain" pad="sm">
          <Row gap="md" align="start">
            {body}
          </Row>
        </Surface>
      )}
      {open && expandable && (
        <Inset pad="sm">
          <Surface tone="base" radius="md" pad="sm">
            <Grid as="dl" cols="pair" gap="md" lineGap="2xs" text="xs">
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
            </Grid>
          </Surface>
        </Inset>
      )}
    </li>
  )
}
