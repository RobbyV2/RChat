'use client'

import { useId } from 'react'
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
import { Choice } from './friends'
import { Grid, Row, Stack } from './layout'
import { PageRow } from './settings_page'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { smallFieldCls } from './ui'

// One slot of the Custom style: its own animation, off, or a named one in its place.
function SlotChoice({
  slot,
  anim,
  onChange,
}: {
  slot: Slot
  anim: AnimPrefs
  onChange: (next: AnimPrefs) => void
}) {
  const id = useId()
  return (
    <Row gap="sm" justify="between" data-slot-choice={slot.id}>
      <label htmlFor={id} title={slot.where} className="min-w-0 truncate text-sm text-on-surface">
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
              <Grid cols={{ base: 1, md: 2 }} gap="lg" lineGap="sm">
                {SLOTS.map(slot => (
                  <SlotChoice key={slot.id} slot={slot} anim={anim} onChange={setAnim} />
                ))}
              </Grid>
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
