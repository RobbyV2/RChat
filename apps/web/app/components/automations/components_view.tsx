'use client'

import { useId, useState } from 'react'
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import { Stack, Row, Surface, Inset } from '../layout'
import { AppButton, Button, CardButton } from '../controls'

// The buttons and menus under an automation's message, as the shared rules write them.
export type ButtonStyle = 'plain' | 'primary' | 'danger'

export type ButtonPress =
  | { do: 'role'; role: number | string }
  | { do: 'run' }
  | { do: 'link'; url: string }
  | { do: 'jump'; channel: number | string }

export interface SelectOption {
  value: string
  label: string
  emoji?: string
  description?: string
  role?: number | string
}

export type Component =
  | ({
      type: 'button'
      cid: string
      label: string
      emoji?: string
      style?: ButtonStyle
    } & ButtonPress)
  | {
      type: 'select'
      cid: string
      placeholder?: string
      min?: number
      max?: number
      options: SelectOption[]
    }

type Select = Extract<Component, { type: 'select' }>
type Button = Extract<Component, { type: 'button' }>

const most = (s: Select) => s.max ?? 1
const least = (s: Select) => s.min ?? 0

// The picks after one option is pressed, in option order: a menu of one swaps, a menu of more
// toggles up to its most.
export const togglePick = (s: Select, picks: readonly string[], value: string): string[] => {
  const known = s.options.map(o => o.value)
  const mine = known.filter(v => picks.includes(v))
  if (!known.includes(value)) return mine
  if (mine.includes(value))
    return most(s) === 1 && least(s) >= 1 ? mine : mine.filter(v => v !== value)
  if (most(s) === 1) return [value]
  return mine.length >= most(s) ? mine : known.filter(v => v === value || mine.includes(v))
}

export const picksOk = (s: Select, picks: readonly string[]) =>
  picks.every(v => s.options.some(o => o.value === v)) &&
  picks.length >= least(s) &&
  picks.length <= most(s)

export const pickedLabel = (s: Select, picks: readonly string[]) =>
  s.options
    .filter(o => picks.includes(o.value))
    .map(o => o.label)
    .join(', ') ||
  s.placeholder ||
  'Choose'

interface Shared {
  // Why nothing can be used ("Sign in to use this"); null when it can.
  reason: string | null
  reasonId: string
  // What a control waits for, by cid.
  waiting: Record<string, string>
}

function ButtonView({
  c,
  pressed,
  shared: { reason, reasonId, waiting },
  onPress,
}: {
  c: Button
  pressed: boolean
  shared: Shared
  onPress: (cid: string) => void
}) {
  const wait = waiting[c.cid]
  const role = c.do === 'role'
  return (
    <AppButton
      data-cid={c.cid}
      aria-busy={wait ? true : undefined}
      aria-describedby={reason ? reasonId : undefined}
      disabled={reason !== null || wait !== undefined}
      title={reason ?? wait ?? (c.do === 'link' ? c.url : undefined)}
      onClick={() => onPress(c.cid)}
      style={c.style ?? 'plain'}
      pressed={role ? pressed : undefined}
    >
      {c.emoji && <span aria-hidden="true">{c.emoji}</span>}
      <span className="min-w-0 truncate">{wait ?? c.label}</span>
      {role && pressed && <Check size={14} className="shrink-0" aria-hidden="true" />}
      {c.do === 'link' && <ExternalLink size={14} className="shrink-0" aria-hidden="true" />}
    </AppButton>
  )
}

function SelectView({
  c,
  picks,
  startOpen,
  shared: { reason, reasonId, waiting },
  onPick,
}: {
  c: Select
  picks: readonly string[]
  startOpen: boolean
  shared: Shared
  onPick: (cid: string, values: string[]) => void
}) {
  const [open, setOpen] = useState(startOpen)
  const [draft, setDraft] = useState<string[] | null>(null)
  const listId = useId()
  const wait = waiting[c.cid]
  const off = reason !== null || wait !== undefined
  const shown = draft ?? picks
  const many = most(c) > 1
  const close = () => {
    setOpen(false)
    setDraft(null)
  }
  const choose = (value: string) => {
    const next = togglePick(c, shown, value)
    if (many) return setDraft(next)
    close()
    if (picksOk(c, next)) onPick(c.cid, next)
  }
  return (
    <Stack gap="2xs" place="w-full min-w-0">
      <AppButton
        data-cid={c.cid}
        aria-haspopup="listbox"
        aria-expanded={open && !off}
        aria-controls={open && !off ? listId : undefined}
        aria-busy={wait ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        disabled={off}
        title={reason ?? wait}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={e => {
          if (e.key === 'Escape' && open) close()
        }}
        wide
      >
        <span className="min-w-0 truncate">{wait ?? pickedLabel(c, picks)}</span>
        <ChevronDown size={16} className="shrink-0" aria-hidden="true" />
      </AppButton>
      {open && !off && (
        <Surface pad="2xs" tone="base" radius="lg" border>
          <div
            id={listId}
            role="listbox"
            aria-label={c.placeholder || 'Choose'}
            aria-multiselectable={many ? true : undefined}
            className="flex flex-col"
            onKeyDown={e => {
              if (e.key === 'Escape') close()
            }}
          >
            {c.options.map(o => {
              const on = shown.includes(o.value)
              return (
                <CardButton
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  onClick={() => choose(o.value)}
                  pad="md"
                >
                  {o.emoji && <span aria-hidden="true">{o.emoji}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.description && (
                      <span className="block truncate text-xs opacity-80">{o.description}</span>
                    )}
                  </span>
                  {on && <Check size={16} className="shrink-0" aria-hidden="true" />}
                </CardButton>
              )
            })}
          </div>
          {many && (
            <Inset row pad="2xs" justify="end">
              <Button
                disabled={!picksOk(c, shown)}
                onClick={() => {
                  close()
                  onPick(c.cid, [...shown])
                }}
                variant="filled"
                size="md"
              >
                Done
              </Button>
            </Inset>
          )}
        </Surface>
      )}
    </Stack>
  )
}

// Props only: what is pressed and picked comes from the viewer's roles, and a press or a pick
// goes to the caller.
export function ComponentsView({
  rows,
  pressed,
  picks,
  disabled = null,
  waiting = {},
  open,
  onPress,
  onPick,
}: {
  rows: Component[][]
  // The cids of the role buttons shown as pressed.
  pressed?: ReadonlySet<string>
  // The picked values of each menu, by cid.
  picks?: Record<string, readonly string[]>
  disabled?: string | null
  waiting?: Record<string, string>
  // The cid of a menu that starts open.
  open?: string
  onPress: (cid: string) => void
  onPick: (cid: string, values: string[]) => void
}) {
  const reasonId = useId()
  const shared = { reason: disabled, reasonId, waiting }
  if (!rows.some(row => row.length)) return null
  return (
    <Stack gap="xs" look="msg-part" place="max-w-full">
      {rows.map((row, i) => (
        <Row
          key={i}
          role="group"
          gap="xs"
          wrap={row.some(c => c.type === 'button')}
          align="stretch"
        >
          {row.map(c =>
            c.type === 'button' ? (
              <ButtonView
                key={c.cid}
                c={c}
                pressed={pressed?.has(c.cid) ?? false}
                shared={shared}
                onPress={onPress}
              />
            ) : (
              <SelectView
                key={c.cid}
                c={c}
                picks={picks?.[c.cid] ?? []}
                startOpen={open === c.cid}
                shared={shared}
                onPick={onPick}
              />
            )
          )}
        </Row>
      ))}
      {disabled && (
        <p id={reasonId} className="text-xs text-on-surface-variant">
          {disabled}
        </p>
      )}
    </Stack>
  )
}
