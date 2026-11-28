'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Slash, X } from 'lucide-react'
import {
  TRIS,
  TRI_TEXT,
  clearBlock,
  groupItems,
  matchItems,
  modeBlock,
  orderSubjects,
  ruleItems,
  subjectKind,
  triBlock,
  triOf,
  viewAs,
  withRows,
  withTri,
  type PermItem,
  type RuleRow,
  type RuleSource,
  type Tri,
} from '../lib/perm_source'
import { hasBit, type Ow } from '../lib/perms'
import { Row, Stack, Surface } from './layout'
import { fieldCls, smallFieldCls, textBtn } from './ui'

// The rules of a channel or category, for hosted servers and P2P rooms alike: the subjects with a
// rule (@everyone, roles, members), each permission of the selected one as Allow, Inherit or
// Deny, member rules that override or combine with their roles, and what a subject holds there.

const TRI_ICON = { allow: Check, inherit: Slash, deny: X } as const

const triCls = (tri: Tri, on: boolean) =>
  on
    ? tri === 'allow'
      ? 'bg-primary text-on-primary'
      : tri === 'deny'
        ? 'bg-error text-on-error'
        : 'bg-surface-container-highest text-on-surface'
    : 'text-on-surface-variant enabled:hover:bg-surface-container-highest'

function TriControl({
  item,
  value,
  blockOf,
  onPick,
}: {
  item: PermItem
  value: Tri
  blockOf: (tri: Tri) => string | null
  onPick: (tri: Tri) => void
}) {
  return (
    <div
      role="group"
      aria-label={item.label}
      className="flex shrink-0 overflow-hidden rounded-full border border-outline-variant"
    >
      {TRIS.map(tri => {
        const Icon = TRI_ICON[tri]
        const on = tri === value
        const block = on ? null : blockOf(tri)
        const name = `${TRI_TEXT[tri]} ${item.label}`
        return (
          <button
            key={tri}
            type="button"
            aria-pressed={on}
            aria-label={name}
            title={block ?? name}
            disabled={!!block}
            onClick={() => !on && onPick(tri)}
            className={`flex h-8 w-9 items-center justify-center disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11 ${triCls(tri, on)}`}
          >
            <Icon size={14} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

export interface SubjectChoice {
  subject: string
  label: string
}

export function RuleEditor({
  src,
  label,
  render,
  addable,
  roleOrder,
  memberPicker,
  empty,
  children,
}: {
  src: RuleSource
  // A subject's name as text (labels), and as shown in the list.
  label: (subject: string) => string
  render: (subject: string) => ReactNode
  // Roles (and @everyone) that may get a rule, highest first.
  addable: SubjectChoice[]
  roleOrder: string[]
  memberPicker?: (pick: (subject: string) => void) => ReactNode
  empty?: string
  children?: ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const [adding, setAdding] = useState('')
  const [q, setQ] = useState('')
  const [as, setAs] = useState('')
  // Rules as our own writes leave them (null: taken away) until the place shows them. Writes go
  // one at a time, each from the rule the one before left, so quick changes keep each other.
  const [local, setLocal] = useState<Record<string, RuleRow | null>>({})
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight = useRef(0)
  const shownKey = JSON.stringify(src.rows)
  useEffect(() => {
    if (inFlight.current === 0) setLocal({})
  }, [shownKey])
  const enqueue = (run: () => Promise<unknown>) => {
    inFlight.current += 1
    queue.current = queue.current
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        inFlight.current -= 1
        if (inFlight.current === 0) setLocal({})
      })
  }
  const view = withRows(src, [
    ...src.rows.filter(r => !(r.subject in local)),
    ...Object.values(local).filter((r): r is RuleRow => r !== null),
  ])
  const listed = new Set(view.rows.map(r => r.subject))
  const subjects = orderSubjects(
    [...listed, ...pending.filter(s => !listed.has(s))],
    src.everyone,
    roleOrder,
    label
  )
  const current = selected && subjects.includes(selected) ? selected : (subjects[0] ?? null)
  const add = (subject: string) => {
    if (!listed.has(subject)) setPending(p => [...p.filter(x => x !== subject), subject])
    setSelected(subject)
  }
  const remove = (subject: string) => {
    setPending(p => p.filter(x => x !== subject))
    if (!listed.has(subject)) return
    setLocal(l => ({ ...l, [subject]: null }))
    enqueue(() => src.clear(subject))
  }
  const items = ruleItems(src.ruleset, src.place)
  const row = current ? view.rows.find(r => r.subject === current) : undefined
  const put = (subject: string, rule: Ow, merge: boolean) => {
    const none = rule.allow === 0 && rule.deny === 0
    if (none) setPending(p => [...p.filter(x => x !== subject), subject])
    setLocal(l => ({ ...l, [subject]: none ? null : { subject, ...rule, merge } }))
    enqueue(() => src.write(subject, rule, merge))
  }
  const pick = (bit: number, tri: Tri) => {
    if (current) put(current, withTri(row, bit, tri), row?.merge ?? false)
  }
  const picker = memberPicker?.(add)
  const choices = addable.filter(c => !listed.has(c.subject) && !pending.includes(c.subject))
  const shown = groupItems(matchItems(items, q))
  const viewable = orderSubjects(
    [...new Set([src.everyone, ...roleOrder, ...subjects])],
    src.everyone,
    roleOrder,
    label
  )
  const viewed = as && viewable.includes(as) ? as : null
  return (
    <Surface data-rule-editor pad="sm" gap="sm" tone="low" radius="lg">
      {children}
      {subjects.length === 0 && empty && <p className="text-xs text-on-surface-variant">{empty}</p>}
      <Stack as="ul" aria-label="Rules" gap="2xs">
        {subjects.map(s => {
          const name = label(s)
          const block = clearBlock(view, s)
          return (
            <Surface
              key={s}
              as="li"
              data-rule-subject={s}
              title={listed.has(s) && block ? block : undefined}
              pad="none"
              tone={s === current ? 'secondary' : 'plain'}
              radius="lg"
            >
              <Row gap="2xs">
                <Surface
                  as="button"
                  type="button"
                  aria-pressed={s === current}
                  onClick={() => setSelected(s)}
                  pad="sm"
                  inset="sides"
                  gap="xs"
                  row
                  tone="plain"
                  radius="lg"
                  text="sm"
                  look="min-h-9 text-left pointer-coarse:min-h-11"
                  place="min-w-0 flex-1"
                >
                  {render(s)}
                </Surface>
                <Surface
                  as="button"
                  type="button"
                  onClick={() => remove(s)}
                  disabled={listed.has(s) && !!block}
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                  pad="xs"
                  row
                  tone="plain"
                  radius="full"
                  justify="center"
                  ink="muted"
                  look="hover:bg-surface-container-highest hover:text-error disabled:opacity-40 pointer-coarse:size-11"
                  place="shrink-0 disabled:pointer-events-none"
                >
                  <X size={14} />
                </Surface>
              </Row>
            </Surface>
          )
        })}
      </Stack>
      <Row gap="sm" align="start" wrap>
        {choices.length > 0 && (
          <span className="flex min-w-48 flex-1">
            <Row as="span" gap="sm" place="flex-1">
              <select
                value={adding}
                onChange={e => setAdding(e.target.value)}
                title="Add role"
                aria-label="Add role"
                className={fieldCls}
              >
                <option value="">Add role…</option>
                {choices.map(c => (
                  <option key={c.subject} value={c.subject}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (!adding) return
                  add(adding)
                  setAdding('')
                }}
                className={textBtn}
              >
                Add
              </button>
            </Row>
          </span>
        )}
        {picker && <div className="flex min-w-48 flex-1">{picker}</div>}
      </Row>
      {current && (
        <Surface
          as="section"
          data-rule-for={current}
          aria-label={`Permissions for ${label(current)}`}
          pad="sm"
          gap="sm"
          tone="plain"
          radius="none"
          border="top"
        >
          <p className="text-xs font-medium text-on-surface-variant">
            Permissions for <span className="streamer">{label(current)}</span>
          </p>
          {src.merges && subjectKind(current, src.everyone) === 'member' && (
            <Row role="group" aria-label="Member rule" gap="2xs" wrap>
              {[false, true].map(merge => {
                const on = (row?.merge ?? false) === merge
                const text = merge ? 'Combines with their roles' : 'Overrides their roles'
                const block = row
                  ? on
                    ? null
                    : modeBlock(view, current)
                  : 'Set a permission first'
                return (
                  <Surface
                    key={text}
                    type="button"
                    aria-pressed={on}
                    disabled={!!block}
                    title={block ?? text}
                    onClick={() =>
                      row && !on && put(current, { allow: row.allow, deny: row.deny }, merge)
                    }
                    as="button"
                    pad="md"
                    inset="chip"
                    tone="plain"
                    radius="full"
                    text="xs"
                    look={`disabled:opacity-60 pointer-coarse:min-h-11 ${on ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant enabled:hover:bg-surface-container-highest'}`}
                  >
                    {text}
                  </Surface>
                )
              })}
            </Row>
          )}
          {items.length > 6 && (
            <input
              type="search"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search permissions"
              aria-label="Search permissions"
              className={`${fieldCls} w-full`}
            />
          )}
          {shown.map(g => (
            <Stack key={g.group} gap="2xs">
              <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                {g.group}
              </p>
              {g.items.map(item => (
                <Row key={item.name} data-perm={item.name} gap="sm">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm">{item.label}</span>
                    {item.hint && (
                      <span className="text-xs text-on-surface-variant">{item.hint}</span>
                    )}
                  </span>
                  <TriControl
                    item={item}
                    value={triOf(row, item.bit)}
                    blockOf={tri => triBlock(view, current, item.bit, tri)}
                    onPick={tri => pick(item.bit, tri)}
                  />
                </Row>
              ))}
            </Stack>
          ))}
          {shown.length === 0 && (
            <p className="text-xs text-on-surface-variant">No matching permissions.</p>
          )}
        </Surface>
      )}
      <Surface pad="sm" gap="2xs" tone="plain" radius="none" border="top">
        <Row as="label" gap="sm">
          <span className="text-xs text-on-surface-variant">View as</span>
          <select
            value={viewed ?? ''}
            onChange={e => setAs(e.target.value)}
            aria-label="View as"
            className={`${smallFieldCls} min-w-0 flex-1 text-on-surface`}
          >
            <option value="">Choose…</option>
            {viewable.map(s => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </Row>
        {viewed && <ViewAs src={view} subject={viewed} items={items} />}
      </Surface>
    </Surface>
  )
}

function ViewAs({ src, subject, items }: { src: RuleSource; subject: string; items: PermItem[] }) {
  const mask = viewAs(src, subject)
  return (
    <Row as="ul" aria-label="What they can do" data-view-as gap="2xs" wrap>
      {items.map(item => {
        const can = hasBit(mask, src.canonical(item.bit))
        return (
          <Surface
            key={item.name}
            data-can={can ? 'yes' : 'no'}
            as="li"
            row
            pad="sm"
            inset="chip"
            gap="2xs"
            tone="plain"
            radius="full"
            text="xs"
            look={
              can
                ? 'bg-primary-container text-on-primary-container'
                : 'bg-surface-container-highest text-on-surface-variant line-through'
            }
          >
            {can ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            <span>{item.label}</span>
            <span className="sr-only">{can ? 'allowed' : 'not allowed'}</span>
          </Surface>
        )
      })}
    </Row>
  )
}
