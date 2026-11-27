'use client'

import { useId, useState, type ReactNode } from 'react'
import { MoreVertical, SlidersHorizontal, X } from 'lucide-react'
import {
  MEMBER_SORTS,
  SORT_LABELS,
  chipsOf,
  dayEnd,
  dayLabel,
  dayOf,
  dayStart,
  dropChip,
  filtering,
  lastDay,
  toggleRole,
  type MemberFilters,
  type MemberSort,
} from '../lib/member_filters'
import { longPress } from './context_menu'
import { fieldCls, textBtn } from './ui'

// The member search of server settings, the same on hosted servers and P2P rooms: a search
// field, filters shown as removable chips, and rows that open the member's action menu by
// right-click, long-press or their More button. A table on wide screens, a list on narrow ones.

export interface FilterChoices {
  roles: { id: string; name: string }[]
  // Codes or passwords members joined with; null when the viewer may not filter by them.
  via: { id: string; label: string }[] | null
  // Account dates (hosted servers).
  created: boolean
}

const chipCls = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${
    on
      ? 'border-transparent bg-secondary-container text-on-secondary-container'
      : 'border-outline text-on-surface-variant hover:bg-surface-container-highest'
  }`

const label = 'text-xs font-medium text-on-surface-variant'

const clearedFilters = {
  roles: [],
  joinedAfter: null,
  joinedBefore: null,
  createdAfter: null,
  createdBefore: null,
  via: null,
} satisfies Partial<MemberFilters>

function DayRange({
  what,
  after,
  before,
  onChange,
}: {
  what: string
  after: number | null
  before: number | null
  onChange: (after: number | null, before: number | null) => void
}) {
  const id = useId()
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className={label}>{what}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}f`} className="text-xs text-on-surface-variant">
          From
        </label>
        <input
          id={`${id}f`}
          type="date"
          value={after === null ? '' : dayOf(after)}
          onChange={e => onChange(dayStart(e.target.value), before)}
          className={`${fieldCls} max-w-40 flex-none py-1`}
        />
        <label htmlFor={`${id}t`} className="text-xs text-on-surface-variant">
          To
        </label>
        <input
          id={`${id}t`}
          type="date"
          value={before === null ? '' : lastDay(before)}
          onChange={e => onChange(after, dayEnd(e.target.value))}
          className={`${fieldCls} max-w-40 flex-none py-1`}
        />
      </div>
    </fieldset>
  )
}

export function MemberFilterBar({
  value,
  onChange,
  choices,
}: {
  value: MemberFilters
  onChange: (f: MemberFilters) => void
  choices: FilterChoices
}) {
  const [open, setOpen] = useState(false)
  const roleName = (id: string) => choices.roles.find(r => r.id === id)?.name ?? null
  const viaName = (id: string) => choices.via?.find(v => v.id === id)?.label || null
  const chips = chipsOf(value, { role: roleName, via: viaName, date: t => dayLabel(t) })
  const sorts = MEMBER_SORTS.filter(s => choices.created || !s.startsWith('created'))
  return (
    <div data-member-filters className="mb-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={value.q}
          onChange={e => onChange({ ...value, q: e.target.value })}
          placeholder="Search members"
          aria-label="Search members"
          className={`${fieldCls} min-w-40`}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className={`${textBtn} flex items-center gap-1.5`}
        >
          <SlidersHorizontal size={16} aria-hidden />
          Filters
        </button>
        <select
          value={value.sort}
          onChange={e => onChange({ ...value, sort: e.target.value as MemberSort })}
          aria-label="Sort members"
          title="Sort members"
          className="rounded-xl border border-outline bg-surface-container-high px-2 py-2 text-base text-on-surface md:text-sm"
        >
          {sorts.map(s => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      {chips.length > 0 && (
        <ul aria-label="Filters in use" className="flex flex-wrap gap-1.5">
          {chips.map(c => (
            <li
              key={`${c.kind}${c.id ?? ''}`}
              className="flex max-w-full items-center gap-1 rounded-full bg-secondary-container py-0.5 pr-0.5 pl-3 text-sm text-on-secondary-container"
            >
              <span className="truncate">{c.label}</span>
              <button
                type="button"
                title={`Remove ${c.label}`}
                aria-label={`Remove ${c.label}`}
                onClick={() => onChange(dropChip(value, c))}
                className="rounded-full p-1 hover:bg-surface-container-highest"
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="flex flex-col gap-3 rounded-2xl bg-surface-container px-3 py-3">
          {choices.roles.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className={label}>Roles</p>
              <div className="flex flex-wrap gap-1.5">
                {choices.roles.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={value.roles.includes(r.id)}
                    onClick={() => onChange(toggleRole(value, r.id))}
                    className={chipCls(value.roles.includes(r.id))}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <DayRange
            what="Joined"
            after={value.joinedAfter}
            before={value.joinedBefore}
            onChange={(joinedAfter, joinedBefore) =>
              onChange({ ...value, joinedAfter, joinedBefore })
            }
          />
          {choices.created && (
            <DayRange
              what="Account made"
              after={value.createdAfter}
              before={value.createdBefore}
              onChange={(createdAfter, createdBefore) =>
                onChange({ ...value, createdAfter, createdBefore })
              }
            />
          )}
          {choices.via && choices.via.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className={label}>Joined with</span>
              <select
                value={value.via ?? ''}
                onChange={e => onChange({ ...value, via: e.target.value || null })}
                className="max-w-full rounded-xl border border-outline bg-surface-container-high px-2 py-2 text-base text-on-surface md:text-sm"
              >
                <option value="">Any way</option>
                {choices.via.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.label || 'No label'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {filtering({ ...value, q: '' }) && (
            <button
              type="button"
              onClick={() => onChange({ ...value, ...clearedFilters })}
              className={`${textBtn} self-start`}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const columns = (created: boolean, joined: boolean) => {
  if (created && joined) return 'sm:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_2.25rem]'
  if (created || joined) return 'sm:grid-cols-[minmax(0,1fr)_6.5rem_2.25rem]'
  return 'sm:grid-cols-[minmax(0,1fr)_2.25rem]'
}

export function MemberTable({
  created,
  joined = true,
  label,
  children,
}: {
  created: boolean
  // Whether the table shows when members joined.
  joined?: boolean
  label: string
  children: ReactNode
}) {
  return (
    <div role="table" aria-label={label} data-member-table className="flex flex-col">
      <div
        role="row"
        className={`hidden gap-x-3 px-2 pb-1 text-xs font-medium text-on-surface-variant sm:grid ${columns(created, joined)}`}
      >
        <span role="columnheader">Member</span>
        {joined && <span role="columnheader">Joined</span>}
        {created && <span role="columnheader">Account made</span>}
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      <div role="rowgroup" className="flex flex-col">
        {children}
      </div>
    </div>
  )
}

export function MemberTableRow({
  rowKey,
  avatar,
  name,
  badges,
  facts,
  joinedAt,
  createdAt,
  created,
  joined: dated = true,
  menu,
}: {
  rowKey: string
  avatar: ReactNode
  name: ReactNode
  badges?: ReactNode
  // Roles, how they joined and the like, under the name.
  facts?: ReactNode
  // Unix seconds.
  joinedAt: number | null
  createdAt?: number | null
  created: boolean
  joined?: boolean
  menu: (x: number, y: number) => void
}) {
  const joined = !dated || joinedAt === null ? null : dayLabel(joinedAt)
  const made = createdAt === undefined || createdAt === null ? null : dayLabel(createdAt)
  const narrow = [joined && `Joined ${joined}`, created && made && `Account made ${made}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      role="row"
      data-member-row={rowKey}
      {...longPress(menu)}
      className={`grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-3 rounded-xl px-2 py-1.5 hover:bg-surface-container-highest ${columns(created, dated)}`}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {name}
            {badges}
          </div>
          {facts && <div className="truncate text-xs text-on-surface-variant">{facts}</div>}
          {narrow && <div className="text-xs text-on-surface-variant sm:hidden">{narrow}</div>}
        </div>
      </div>
      {dated && (
        <div role="cell" className="hidden text-xs text-on-surface-variant tabular-nums sm:block">
          {joined}
        </div>
      )}
      {created && (
        <div role="cell" className="hidden text-xs text-on-surface-variant tabular-nums sm:block">
          {made}
        </div>
      )}
      <div role="cell" className="flex justify-end">
        <button
          type="button"
          title="Member actions"
          aria-label="Member actions"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            menu(r.left, r.bottom)
          }}
          className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          <MoreVertical size={16} aria-hidden />
        </button>
      </div>
    </div>
  )
}
