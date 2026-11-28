import { describe, expect, test } from 'bun:test'
import { ManualTime } from './helpers/test_clock'
import { scheduledActions, setOpenComposer } from '../actions/scheduled'
import type { ActionCtx, Target } from '../actions/types'
import type { AccountSession } from '../client/session'
import { laterKey } from '../keys'
import { BLOCKED, presetTime, type ComposerDraft, type ScheduledRow } from '../scheduled'
import { conflicts, SHORTCUTS } from '../shortcuts'

const action = (id: string) => scheduledActions.find(a => a.id === id)!

const acct = { time: new ManualTime() } as unknown as AccountSession

const ctx = (target: Target, via: ActionCtx['via'] = 'menu') =>
  ({ target, acct, via, s: { me: { username: 'alice' }, guest: false } }) as unknown as ActionCtx

const draft = (blocked: string | null, scheduled: number[], picked: number[]): ComposerDraft => ({
  side: 'hosted',
  place: 'c1',
  text: 'hi',
  reply: null,
  blocked,
  schedule: async at => {
    scheduled.push(at)
  },
  pick: () => picked.push(1),
})

describe('send later rows', () => {
  test('the composer menu has the presets and the picker, in order', () => {
    const rows = scheduledActions.filter(a => a.targets?.includes('composer'))
    expect(rows.map(a => a.id)).toEqual([
      'send_later_hour',
      'send_later_tomorrow',
      'send_later_monday',
      'send_later_pick',
    ])
    const at = new Date()
    expect(rows[0].label?.(ctx({ kind: 'none' }))).toBe('In 1 hour')
    expect(rows[1].label?.(ctx({ kind: 'none' }))?.startsWith('Tomorrow at ')).toBe(true)
    expect(rows[2].label?.(ctx({ kind: 'none' }))?.startsWith('Next Monday at ')).toBe(true)
    expect(presetTime('tomorrow', at)).toBeGreaterThan(at.getTime())
  })

  test('rows run on the draft as it is, and say why they are off', () => {
    const scheduled: number[] = []
    const picked: number[] = []
    let blocked: string | null = null
    const t: Target = { kind: 'composer', now: () => draft(blocked, scheduled, picked) }
    const hour = action('send_later_hour')
    expect(hour.available(ctx(t))).toBe(true)
    expect(hour.disabled?.(ctx(t))).toBe(false)
    expect(/^(Today|Tomorrow) at /.test(hour.subtitle?.(ctx(t)) ?? '')).toBe(true)
    hour.run(ctx(t), {})
    expect(scheduled.length).toBe(1)
    action('send_later_pick').run(ctx(t), {})
    expect(picked).toEqual([1])
    for (const reason of [
      BLOCKED.text,
      BLOCKED.empty,
      BLOCKED.long,
      BLOCKED.off,
      BLOCKED.full(3),
    ]) {
      blocked = reason
      expect(hour.disabled?.(ctx(t))).toBe(true)
      expect(hour.subtitle?.(ctx(t))).toBe(reason)
      expect(action('send_later_pick').subtitle?.(ctx(t))).toBe(reason)
      hour.run(ctx(t), {})
    }
    expect(scheduled.length).toBe(1)
    const gone: Target = { kind: 'composer', now: () => null }
    expect(hour.available(ctx(gone))).toBe(false)
  })

  test('the palette reads the open composer', () => {
    const scheduled: number[] = []
    const palette = action('send_later')
    expect(palette.available(ctx({ kind: 'none' }, 'palette'))).toBe(false)
    const close = setOpenComposer(acct, () => draft(null, scheduled, []))
    expect(palette.available(ctx({ kind: 'none' }, 'palette'))).toBe(true)
    expect(palette.available(ctx({ kind: 'none' }, 'menu'))).toBe(false)
    palette.run(ctx({ kind: 'none' }, 'palette'), { when: 'monday' })
    expect(scheduled.length).toBe(1)
    const closeOther = setOpenComposer(acct, () => draft(BLOCKED.empty, scheduled, []))
    close()
    expect(palette.available(ctx({ kind: 'none' }, 'palette'))).toBe(true)
    closeOther()
    expect(palette.available(ctx({ kind: 'none' }, 'palette'))).toBe(false)
  })

  test('list rows say Retry for unsent ones and hide while sending', () => {
    const calls: string[] = []
    let state: ScheduledRow['item']['state'] = 'waiting'
    const row = (): ScheduledRow => ({
      item: {
        key: 'h:1',
        side: 'hosted',
        place: 'c1',
        body: 'hi',
        files: [],
        poll: null,
        reply: null,
        at: 1,
        next: 1,
        state,
        error: null,
        deferred: false,
        label: null,
      },
      edit: () => calls.push('edit'),
      sendNow: async () => void calls.push('send'),
      resume: async () => void calls.push('resume'),
      reschedule: async () => void calls.push('reschedule'),
      pick: () => calls.push('pick'),
      remove: async () => void calls.push('remove'),
    })
    const t: Target = { kind: 'scheduled', now: row }
    const send = action('scheduled_send_now')
    expect(send.label?.(ctx(t))).toBe('Send now')
    state = 'failed'
    expect(send.label?.(ctx(t))).toBe('Retry')
    state = 'missed'
    expect(send.label?.(ctx(t))).toBe('Retry')
    action('scheduled_reschedule').run(ctx(t), { when: 'pick' })
    action('scheduled_reschedule').run(ctx(t), { when: 'hour' })
    action('scheduled_edit').run(ctx(t), {})
    expect(calls).toEqual(['pick', 'reschedule', 'edit'])
    expect(action('scheduled_delete').args?.[0].kind).toBe('confirm')
    expect(action('scheduled_resume').available(ctx(t))).toBe(false)
    state = 'paused'
    expect(action('scheduled_resume').available(ctx(t))).toBe(true)
    expect(action('scheduled_send_now').available(ctx(t))).toBe(false)
    expect(action('scheduled_edit').available(ctx(t))).toBe(true)
    action('scheduled_resume').run(ctx(t), {})
    expect(calls).toEqual(['pick', 'reschedule', 'edit', 'resume'])
    state = 'sending'
    for (const id of [
      'scheduled_edit',
      'scheduled_send_now',
      'scheduled_resume',
      'scheduled_reschedule',
      'scheduled_delete',
    ])
      expect(action(id).available(ctx(t))).toBe(false)
  })
})

describe('the Send later key', () => {
  test('Mod+Shift+Enter is listed and shares no key', () => {
    expect(SHORTCUTS.filter(s => s.keys === 'Mod+Shift+Enter')).toEqual([
      { keys: 'Mod+Shift+Enter', action: 'Send later', where: 'composer' },
    ])
    expect(conflicts()).toEqual([])
  })

  test('it needs Ctrl or Cmd with Shift, and never while composing', () => {
    const e = (over: Partial<Parameters<typeof laterKey>[0]>) =>
      laterKey({
        key: 'Enter',
        shiftKey: true,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        keyCode: 13,
        nativeEvent: { isComposing: false },
        ...over,
      })
    expect(e({})).toBe(true)
    expect(e({ ctrlKey: false, metaKey: true })).toBe(true)
    expect(e({ shiftKey: false })).toBe(false)
    expect(e({ ctrlKey: false })).toBe(false)
    expect(e({ altKey: true })).toBe(false)
    expect(e({ nativeEvent: { isComposing: true } })).toBe(false)
  })
})
