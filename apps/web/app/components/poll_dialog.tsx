'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Plus, Smile, Trash2 } from 'lucide-react'
import {
  DURATION_PRESETS,
  KIND_LABELS,
  POLL_DURATION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  RESULTS_LABELS,
  draftError,
  draftRequest,
  emptyDraft,
  writtenKind,
  type PollDraft,
} from '../lib/polls'
import type { PollTarget } from '../lib/polls_store'
import { useStore } from '../lib/store'
import type { PollKind, ShowResults } from '../lib/types'
import { EmojiPicker } from './emoji_picker'
import { Chips, Dialog, FieldError, fieldCls, filledBtn, textBtn } from './ui'

const KINDS: PollKind[] = ['single', 'multiple', 'ranked', 'rating', 'yes_no']
const SHOWS: ShowResults[] = ['always', 'after_vote', 'after_close']
const UNITS = [
  { label: 'minutes', mult: 60 },
  { label: 'hours', mult: 3600 },
  { label: 'days', mult: 86400 },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">{title}</p>
      {children}
    </div>
  )
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string
  hint: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1">
      <input
        type="checkbox"
        checked={on}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-sm text-on-surface">{label}</span>
        <span className="block text-xs text-on-surface-variant">{hint}</span>
      </span>
    </label>
  )
}

export function CreatePollDialog({ target, onClose }: { target: PollTarget; onClose: () => void }) {
  const createPoll = useStore(s => s.createPoll)
  const [d, setD] = useState<PollDraft>(emptyDraft)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<number | null>(null)
  const [custom, setCustom] = useState(false)
  const [amount, setAmount] = useState('2')
  const [mult, setMult] = useState(3600)
  const anchors = useRef<(HTMLButtonElement | null)[]>([])
  const patch = (p: Partial<PollDraft>) => {
    setD(cur => ({ ...cur, ...p }))
    setError(null)
  }
  const setOption = (i: number, p: Partial<PollDraft['options'][number]>) =>
    patch({ options: d.options.map((o, j) => (j === i ? { ...o, ...p } : o)) })
  const written = writtenKind(d.kind)
  const count = d.options.filter(o => o.text.trim()).length
  const duration = custom ? Math.round(Number(amount) * mult) : d.duration
  const draft = { ...d, duration }
  const problem = draftError(draft)
  const submit = async () => {
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    const err = await createPoll(target, draftRequest(draft))
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  return (
    <Dialog title="Create poll" onClose={onClose} full>
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-on-surface">Question</span>
          <input
            autoFocus
            value={d.question}
            maxLength={POLL_QUESTION_MAX}
            onChange={e => patch({ question: e.target.value })}
            placeholder="What do you want to ask?"
            className={fieldCls}
          />
        </label>
        <Section title="Kind">
          <Chips
            label="Kind"
            value={d.kind}
            options={KINDS.map(k => ({ value: k, label: KIND_LABELS[k] }))}
            onChange={kind => patch({ kind })}
          />
        </Section>
        {written && (
          <Section title="Options">
            <ul className="flex flex-col gap-1.5">
              {d.options.map((o, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <button
                    ref={el => {
                      anchors.current[i] = el
                    }}
                    type="button"
                    title={o.emoji ? 'Remove emoji' : 'Add an emoji'}
                    aria-label={
                      o.emoji
                        ? `Remove emoji of option ${i + 1}`
                        : `Add an emoji to option ${i + 1}`
                    }
                    onClick={() => (o.emoji ? setOption(i, { emoji: null }) : setPicker(i))}
                    className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest"
                  >
                    {o.emoji ? (
                      <span className="text-base leading-none">{o.emoji}</span>
                    ) : (
                      <Smile size={16} />
                    )}
                  </button>
                  <input
                    value={o.text}
                    maxLength={POLL_OPTION_MAX}
                    onChange={e => setOption(i, { text: e.target.value })}
                    onKeyDown={e => {
                      if (
                        e.key === 'Enter' &&
                        i === d.options.length - 1 &&
                        d.options.length < POLL_OPTIONS_MAX
                      ) {
                        e.preventDefault()
                        patch({ options: [...d.options, { text: '', emoji: null }] })
                      }
                    }}
                    placeholder={`Option ${i + 1}`}
                    aria-label={`Option ${i + 1}`}
                    className={`${fieldCls} py-1.5`}
                  />
                  <button
                    type="button"
                    title="Remove option"
                    aria-label={`Remove option ${i + 1}`}
                    disabled={d.options.length <= 2}
                    onClick={() => patch({ options: d.options.filter((_, j) => j !== i) })}
                    className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-30"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
            {d.options.length < POLL_OPTIONS_MAX && (
              <button
                type="button"
                onClick={() => patch({ options: [...d.options, { text: '', emoji: null }] })}
                className={`${textBtn} flex items-center gap-1 self-start`}
              >
                <Plus size={16} />
                Add option
              </button>
            )}
            {d.kind === 'multiple' && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-on-surface">
                <span>Pick from</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, count)}
                  value={d.minChoices}
                  onChange={e => patch({ minChoices: Number(e.target.value) || 1 })}
                  aria-label="Fewest choices"
                  className={`${fieldCls} w-16 flex-none py-1`}
                />
                <span>to</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, count)}
                  value={d.maxChoices ?? Math.max(count, 1)}
                  onChange={e => patch({ maxChoices: Number(e.target.value) || null })}
                  aria-label="Most choices"
                  className={`${fieldCls} w-16 flex-none py-1`}
                />
                <span className="text-on-surface-variant">options</span>
              </div>
            )}
            {d.kind === 'ranked' && (
              <p className="text-xs text-on-surface-variant">
                Voters rank some or all options. The winner is found by instant runoff.
              </p>
            )}
          </Section>
        )}
        {d.kind === 'rating' && (
          <Section title="Scale">
            <Chips
              label="Scale"
              value={d.scale}
              options={[
                { value: 5, label: '1 to 5' },
                { value: 10, label: '1 to 10' },
              ]}
              onChange={scale => patch({ scale })}
            />
          </Section>
        )}
        <Section title="Show results">
          <Chips
            label="Show results"
            value={d.showResults}
            options={SHOWS.map(v => ({ value: v, label: RESULTS_LABELS[v] }))}
            onChange={showResults => patch({ showResults })}
          />
          {d.showResults === 'after_vote' && d.allowChange && (
            <p className="text-xs text-on-surface-variant">
              People can vote, see the results and then remove their vote.
            </p>
          )}
        </Section>
        <Section title="Deadline">
          <Chips
            label="Deadline"
            value={custom ? 'custom' : String(d.duration)}
            options={[
              ...DURATION_PRESETS.map(p => ({ value: String(p.seconds), label: p.label })),
              { value: 'custom', label: 'Custom' },
            ]}
            onChange={v => {
              if (v === 'custom') {
                setCustom(true)
                setError(null)
                return
              }
              setCustom(false)
              patch({ duration: v === 'null' ? null : Number(v) })
            }}
          />
          {custom && (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={amount}
                onChange={e => {
                  setAmount(e.target.value)
                  setError(null)
                }}
                aria-label="Deadline amount"
                className={`${fieldCls} w-24 flex-none py-1.5`}
              />
              <select
                value={mult}
                onChange={e => setMult(Number(e.target.value))}
                aria-label="Deadline unit"
                className={`${fieldCls} flex-none bg-surface-container-high py-1.5`}
              >
                {UNITS.map(u => (
                  <option key={u.mult} value={u.mult}>
                    {u.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-on-surface-variant">
                up to {POLL_DURATION_MAX / 86400} days
              </span>
            </div>
          )}
        </Section>
        <Section title="Settings">
          <Toggle
            label="Anonymous"
            hint="Nobody can see who voted for what."
            on={d.anonymous}
            onChange={anonymous => patch({ anonymous })}
          />
          <Toggle
            label="Allow changing votes"
            hint="Voters can change or remove their vote while the poll is open."
            on={d.allowChange}
            onChange={allowChange => patch({ allowChange })}
          />
          {written && (
            <Toggle
              label="Let others add options"
              hint={`Anyone who can vote can add options, up to ${POLL_OPTIONS_MAX}.`}
              on={d.allowAdd}
              onChange={allowAdd => patch({ allowAdd })}
            />
          )}
        </Section>
        <FieldError message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={textBtn}>
            Cancel
          </button>
          <button
            type="button"
            data-poll-create
            disabled={busy}
            onClick={() => void submit()}
            className={filledBtn}
          >
            Post poll
          </button>
        </div>
      </div>
      {picker !== null && (
        <EmojiPicker
          anchor={anchors.current[picker] ?? null}
          onPick={emoji => {
            setOption(picker, { emoji })
            setPicker(null)
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </Dialog>
  )
}
