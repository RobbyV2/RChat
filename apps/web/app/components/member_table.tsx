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
import { Button, Chip, IconButton } from './controls'
import { Row, Stack, Surface, Inset } from './layout'
import { fieldCls, smallFieldCls } from './ui'
import { notAName } from '../lib/names'

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
    <Stack as="fieldset" gap="2xs">
      <legend className={label}>{what}</legend>
      <Row gap="sm" wrap>
        <label htmlFor={`${id}f`} className="text-xs text-on-surface-variant">
          From
        </label>
        <input
          id={`${id}f`}
          type="date"
          value={after === null ? '' : dayOf(after)}
          onChange={e => onChange(dayStart(e.target.value), before)}
          className={`${smallFieldCls} max-w-40 flex-none`}
        />
        <label htmlFor={`${id}t`} className="text-xs text-on-surface-variant">
          To
        </label>
        <input
          id={`${id}t`}
          type="date"
          value={before === null ? '' : lastDay(before)}
          onChange={e => onChange(after, dayEnd(e.target.value))}
          className={`${smallFieldCls} max-w-40 flex-none`}
        />
      </Row>
    </Stack>
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
    <Stack data-member-filters gap="sm">
      <Row gap="sm" wrap>
        <input
          type="search"
          value={value.q}
          onChange={e => onChange({ ...value, q: e.target.value })}
          placeholder="Search members"
          aria-label="Search members"
          className={`${fieldCls} min-w-40`}
        />
        <Button icon={SlidersHorizontal} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          Filters
        </Button>
        <select
          value={value.sort}
          onChange={e => onChange({ ...value, sort: e.target.value as MemberSort })}
          aria-label="Sort members"
          title="Sort members"
          className={`${smallFieldCls} text-on-surface`}
        >
          {sorts.map(s => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </Row>
      {chips.length > 0 && (
        <Row as="ul" aria-label="Filters in use" gap="xs" wrap>
          {chips.map(c => (
            <Surface
              key={`${c.kind}${c.id ?? ''}`}
              as="li"
              row
              pad="md"
              inset="sides"
              gap="2xs"
              tone="secondary"
              radius="full"
              text="sm"
              place="max-w-full"
            >
              <span className="truncate">{c.label}</span>
              <IconButton
                icon={X}
                label={notAName(`Remove ${c.label}`)}
                tone="inherit"
                size="sm"
                onClick={() => onChange(dropChip(value, c))}
              />
            </Surface>
          ))}
        </Row>
      )}
      {open && (
        <Surface pad="md" gap="md" tone="base">
          {choices.roles.length > 0 && (
            <Stack gap="2xs">
              <p className={label}>Roles</p>
              <Row gap="xs" wrap>
                {choices.roles.map(r => (
                  <Chip
                    key={r.id}
                    on={value.roles.includes(r.id)}
                    onClick={() => onChange(toggleRole(value, r.id))}
                  >
                    {r.name}
                  </Chip>
                ))}
              </Row>
            </Stack>
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
            <Stack as="label" gap="2xs">
              <span className={label}>Joined with</span>
              <select
                value={value.via ?? ''}
                onChange={e => onChange({ ...value, via: e.target.value || null })}
                className={`${smallFieldCls} max-w-full text-on-surface`}
              >
                <option value="">Any way</option>
                {choices.via.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.label || 'No label'}
                  </option>
                ))}
              </select>
            </Stack>
          )}
          {filtering({ ...value, q: '' }) && (
            <Button onClick={() => onChange({ ...value, ...clearedFilters })} place="self-start">
              Clear filters
            </Button>
          )}
        </Surface>
      )}
    </Stack>
  )
}

const columns = (created: boolean, joined: boolean) => {
  if (created && joined) return 'sm:cols-member-2'
  if (created || joined) return 'sm:cols-member-1'
  return 'sm:cols-member-0'
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
    <Stack role="table" aria-label={label} data-member-table gap="none">
      <Inset
        role="row"
        pad="sm"
        inset="sides"
        gap="md"
        text="xs"
        ink="muted"
        look={`font-medium ${columns(created, joined)}`}
        place="hidden sm:grid"
      >
        <span role="columnheader">Member</span>
        {joined && <span role="columnheader">Joined</span>}
        {created && <span role="columnheader">Account made</span>}
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </Inset>
      <Stack role="rowgroup" gap="none">
        {children}
      </Stack>
    </Stack>
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
    <Surface
      role="row"
      data-member-row={rowKey}
      {...longPress(menu)}
      pad="sm"
      inset="bar"
      gap="md"
      tone="plain"
      radius="lg"
      align="center"
      look={`cols-member-0 hover:bg-surface-container-highest ${columns(created, dated)}`}
      place="grid"
    >
      <Row role="cell" gap="sm">
        {avatar}
        <div className="min-w-0 flex-1">
          <Row gap="xs">
            {name}
            {badges}
          </Row>
          {facts && <div className="truncate text-xs text-on-surface-variant">{facts}</div>}
          {narrow && <div className="text-xs text-on-surface-variant sm:hidden">{narrow}</div>}
        </div>
      </Row>
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
      <Row role="cell" gap="none" justify="end">
        <IconButton
          icon={MoreVertical}
          label="Member actions"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            menu(r.left, r.bottom)
          }}
        />
      </Row>
    </Surface>
  )
}
