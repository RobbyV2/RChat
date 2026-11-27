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
import { fieldCls, textBtn } from './ui'

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
    <div data-rule-editor className="space-y-2 rounded-xl bg-surface-container-low p-2">
      {children}
      {subjects.length === 0 && empty && <p className="text-xs text-on-surface-variant">{empty}</p>}
      <ul aria-label="Rules" className="flex flex-col gap-1">
        {subjects.map(s => {
          const name = label(s)
          const block = clearBlock(view, s)
          return (
            <li
              key={s}
              data-rule-subject={s}
              title={listed.has(s) && block ? block : undefined}
              className={`flex items-center gap-1 rounded-xl ${s === current ? 'bg-secondary-container text-on-secondary-container' : ''}`}
            >
              <button
                type="button"
                aria-pressed={s === current}
                onClick={() => setSelected(s)}
                className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2 text-left text-sm pointer-coarse:min-h-11"
              >
                {render(s)}
              </button>
              <button
                type="button"
                onClick={() => remove(s)}
                disabled={listed.has(s) && !!block}
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                className="flex shrink-0 items-center justify-center rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-error disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-11"
              >
                <X size={14} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-start gap-2">
        {choices.length > 0 && (
          <span className="flex min-w-48 flex-1 gap-2">
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
          </span>
        )}
        {picker && <div className="flex min-w-48 flex-1">{picker}</div>}
      </div>
      {current && (
        <section
          data-rule-for={current}
          aria-label={`Permissions for ${label(current)}`}
          className="space-y-2 border-t border-outline-variant pt-2"
        >
          <p className="text-xs font-medium text-on-surface-variant">
            Permissions for <span className="streamer">{label(current)}</span>
          </p>
          {src.merges && subjectKind(current, src.everyone) === 'member' && (
            <div role="group" aria-label="Member rule" className="flex flex-wrap gap-1">
              {[false, true].map(merge => {
                const on = (row?.merge ?? false) === merge
                const text = merge ? 'Combines with their roles' : 'Overrides their roles'
                const block = row
                  ? on
                    ? null
                    : modeBlock(view, current)
                  : 'Set a permission first'
                return (
                  <button
                    key={text}
                    type="button"
                    aria-pressed={on}
                    disabled={!!block}
                    title={block ?? text}
                    onClick={() =>
                      row && !on && put(current, { allow: row.allow, deny: row.deny }, merge)
                    }
                    className={`rounded-full px-3 py-1 text-xs disabled:opacity-60 pointer-coarse:min-h-11 ${on ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant enabled:hover:bg-surface-container-highest'}`}
                  >
                    {text}
                  </button>
                )
              })}
            </div>
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
            <div key={g.group} className="space-y-1">
              <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
                {g.group}
              </p>
              {g.items.map(item => (
                <div key={item.name} data-perm={item.name} className="flex items-center gap-2">
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
                </div>
              ))}
            </div>
          ))}
          {shown.length === 0 && (
            <p className="text-xs text-on-surface-variant">No matching permissions.</p>
          )}
        </section>
      )}
      <div className="space-y-1 border-t border-outline-variant pt-2">
        <label className="flex items-center gap-2 text-xs text-on-surface-variant">
          View as
          <select
            value={viewed ?? ''}
            onChange={e => setAs(e.target.value)}
            aria-label="View as"
            className="min-w-0 flex-1 rounded-lg border border-outline bg-surface-container-high px-2 py-1 text-base text-on-surface outline-none focus:border-primary md:text-sm"
          >
            <option value="">Choose…</option>
            {viewable.map(s => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
        {viewed && <ViewAs src={view} subject={viewed} items={items} />}
      </div>
    </div>
  )
}

function ViewAs({ src, subject, items }: { src: RuleSource; subject: string; items: PermItem[] }) {
  const mask = viewAs(src, subject)
  return (
    <ul aria-label="What they can do" data-view-as className="flex flex-wrap gap-1">
      {items.map(item => {
        const can = hasBit(mask, src.canonical(item.bit))
        return (
          <li
            key={item.name}
            data-can={can ? 'yes' : 'no'}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${can ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest text-on-surface-variant line-through'}`}
          >
            {can ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            <span>{item.label}</span>
            <span className="sr-only">{can ? 'allowed' : 'not allowed'}</span>
          </li>
        )
      })}
    </ul>
  )
}
