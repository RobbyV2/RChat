'use client'

import { Check } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../lib/client/react'
import {
  MOTION_CHOICES,
  OWN,
  STYLE_CHOICES,
  animHeldBack,
  choiceOptions,
  withChoice,
  type AnimPrefs,
} from '../lib/motion/setting'
import { SLOTS, type Slot } from '../lib/motion/slots'
import { useReducedMotion } from '../lib/motion/use_motion'
import { useMedia } from './context_menu'
import { ListRow } from './controls'
import { Choice } from './friends'
import { Grid, Inset, Row, Stack, Surface } from './layout'
import { PageRow } from './settings_page'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { Sheet, smallFieldCls } from './ui'
import { notAName } from '../lib/names'

const PHONE = '(max-width: 767px)'

interface SlotProps {
  slot: Slot
  anim: AnimPrefs
  onChange: (next: AnimPrefs) => void
}

// A slot's choices on a phone: a sheet with a row for each, the chosen one ticked.
function SlotSheet({ slot, anim, onChange, onClose }: SlotProps & { onClose: () => void }) {
  const value = anim.custom[slot.id] ?? OWN
  const chosen = useRef<HTMLButtonElement>(null)
  useEffect(() => chosen.current?.focus({ preventScroll: true }), [])
  return (
    <Sheet
      scroll
      aria-label={slot.label}
      data-slot-sheet={slot.id}
      onClose={onClose}
      onKeyDown={e => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <Surface pad="lg" inset="bar" tone="plain" radius="none" border="bottom">
        <h2 className="truncate text-base font-medium text-on-surface">{slot.label}</h2>
      </Surface>
      <Inset pad="sm" inset="bar">
        <Stack gap="none" role="radiogroup" aria-label={slot.label}>
          {choiceOptions(slot.id).map(o => (
            <ListRow
              key={o.value}
              ref={o.value === value ? chosen : undefined}
              role="radio"
              aria-checked={o.value === value}
              label={o.label}
              trailing={
                o.value === value ? (
                  <Check size={18} aria-hidden className="shrink-0 text-primary" />
                ) : undefined
              }
              onClick={() => {
                onChange(withChoice(anim, slot.id, o.value))
                onClose()
              }}
            />
          ))}
        </Stack>
      </Inset>
    </Sheet>
  )
}

// One slot of the Custom style on a phone: a row that says its choice and opens the sheet.
function SlotRow({ slot, anim, onChange }: SlotProps) {
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLButtonElement>(null)
  const value = anim.custom[slot.id] ?? OWN
  const label = choiceOptions(slot.id).find(o => o.value === value)?.label
  return (
    <>
      <ListRow
        ref={row}
        data-slot-choice={slot.id}
        aria-haspopup="dialog"
        title={notAName(slot.where)}
        label={slot.label}
        trailing={<span className="shrink-0 text-sm text-on-surface-variant">{label}</span>}
        chevron
        onClick={() => setOpen(true)}
      />
      {open && (
        <SlotSheet
          slot={slot}
          anim={anim}
          onChange={onChange}
          onClose={() => {
            setOpen(false)
            row.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}

// One slot of the Custom style: its own animation, off, or a named one in its place.
function SlotChoice({ slot, anim, onChange }: SlotProps) {
  const id = useId()
  return (
    <Row gap="sm" justify="between" data-slot-choice={slot.id}>
      <label
        htmlFor={id}
        title={notAName(slot.where)}
        className="min-w-0 truncate text-sm text-on-surface"
      >
        {slot.label}
      </label>
      <select
        id={id}
        className={`${smallFieldCls} w-40 shrink-0 cursor-pointer`}
        value={anim.custom[slot.id] ?? OWN}
        onChange={e => onChange(withChoice(anim, slot.id, e.target.value))}
      >
        {choiceOptions(slot.id).map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  )
}

// The Animations setting: the switch, and while it is on the style, the Custom style's choice
// for each slot, and how much may move.
export function AnimationsSetting() {
  const anim = useStore(s => s.anim)
  const setAnim = useStore(s => s.setAnim)
  const shown = useStore(s => s.me !== null || s.guest)
  const reduced = useReducedMotion(anim.on && anim.motion === 'device')
  const phone = useMedia(PHONE)
  if (!shown) return null
  const held = animHeldBack(anim, reduced)
  return (
    <PageRow id="user_animations">
      <SettingSwitch label="Animations" value={anim.on} onChange={on => setAnim({ ...anim, on })} />
      <SettingNotes gap="lg">
        <p className="text-xs text-on-surface-variant">
          Things fade and move when they open, arrive or change.
        </p>
        {anim.on && (
          <Choice
            label="Style"
            value={anim.style}
            options={STYLE_CHOICES}
            onChange={style => setAnim({ ...anim, style })}
          />
        )}
        {anim.on && anim.style === 'custom' && (
          <section aria-label="Customize">
            <Stack gap="sm">
              <p className="text-sm text-on-surface">Customize</p>
              {phone ? (
                <Stack gap="none">
                  {SLOTS.map(slot => (
                    <SlotRow key={slot.id} slot={slot} anim={anim} onChange={setAnim} />
                  ))}
                </Stack>
              ) : (
                <Grid cols={{ base: 1, md: 2 }} gap="lg" lineGap="sm">
                  {SLOTS.map(slot => (
                    <SlotChoice key={slot.id} slot={slot} anim={anim} onChange={setAnim} />
                  ))}
                </Grid>
              )}
            </Stack>
          </section>
        )}
        <Stack gap="sm">
          <Choice
            label="Motion"
            value={anim.motion}
            options={MOTION_CHOICES}
            onChange={motion => setAnim({ ...anim, motion })}
          />
          <p className="text-xs text-on-surface-variant">Also used by fun effects.</p>
          {held && (
            <p role="status" className="text-xs text-on-surface">
              {held}
            </p>
          )}
        </Stack>
      </SettingNotes>
    </PageRow>
  )
}
