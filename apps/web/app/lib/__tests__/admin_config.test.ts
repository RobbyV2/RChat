import { expect, test } from 'bun:test'
import {
  CAP_WARNING,
  applyWarning,
  configPatch,
  configSummary,
  controlOf,
  differing,
  filterControls,
  limitChanged,
  limitValue,
  lowersCap,
  patchFor,
  saveWarning,
  shownValue,
  sourceOf,
  summaryLine,
} from '../admin_config'
import { PROFANITY_TARGETS } from '../rules'
import type { AdminConfig, ConfigControl } from '../types'

const control = (over: Partial<ConfigControl> = {}): ConfigControl =>
  ({
    key: 'p2p',
    env: 'FEATURE_P2P',
    value: 'on',
    config: null,
    pinned: false,
    ...over,
  }) as ConfigControl

// A config view without the database part, which these tests do not read.
const config = (...controls: ConfigControl[]): AdminConfig =>
  ({ controls, limits: [] }) as unknown as AdminConfig

test('a control is pinned, the same as the config, different from it, or not in it', () => {
  expect(sourceOf(control())).toBe('none')
  expect(sourceOf(control({ config: 'on' }))).toBe('same')
  expect(sourceOf(control({ config: 'off' }))).toBe('differs')
  expect(sourceOf(control({ config: 'on', pinned: true }))).toBe('pinned')
  expect(sourceOf(control({ config: 'off', pinned: true }))).toBe('pinned')
})

test('the server says whether a value is what the config says, so a document at another revision is the same', () => {
  const forms = control({
    key: 'report_forms',
    value: 'rev 2, 5 categories',
    config: 'rev 1, 5 categories',
  })
  expect(sourceOf({ ...forms, same: true })).toBe('same')
  expect(sourceOf({ ...forms, same: false })).toBe('differs')
  expect(sourceOf(forms)).toBe('differs')
  expect(sourceOf(control({ config: 'on', same: false }))).toBe('differs')
  expect(sourceOf(control({ config: null, same: true }))).toBe('none')
  expect(configSummary(config({ ...forms, same: true }))).toEqual({ pinned: 0, differs: 0 })
  expect(filterControls([{ ...forms, same: true }], 'differs')).toEqual([])
})

test('a control is found by its key', () => {
  const c = config(control(), control({ key: 'sfu' }))
  expect(controlOf(c, 'sfu')?.key).toBe('sfu')
  expect(controlOf(c, 'nope')).toBeNull()
  expect(controlOf(null, 'p2p')).toBeNull()
})

test('a config value becomes the change that sets it', () => {
  expect(patchFor('p2p', 'off')).toEqual({ p2p: false })
  expect(patchFor('p2p', 'on')).toEqual({ p2p: true })
  expect(patchFor('registration', 'closed')).toEqual({ registration: 'closed' })
  expect(patchFor('upload_expiry_max_days', '30')).toEqual({ upload_expiry_max_days: 30 })
  expect(patchFor('upload_expiry_max_days', 'soon')).toBeNull()
  expect(patchFor('server_creators', 'alice, lobby:Staff')).toEqual({
    server_creators: ['alice', 'lobby:Staff'],
  })
  expect(patchFor('server_creators', '')).toEqual({ server_creators: [] })
  expect(patchFor('default_servers', 'none')).toEqual({ default_servers: [] })
  expect(patchFor('default_servers', 'rchat,lobby')).toEqual({
    default_servers: ['rchat', 'lobby'],
  })
  expect(patchFor('report_forms', 'rev 2, 5 categories')).toBeNull()
})

test('profanity targets become one switch per target', () => {
  const all = patchFor('profanity_targets', 'all')?.profanity_targets ?? {}
  expect(Object.keys(all)).toHaveLength(PROFANITY_TARGETS.length)
  expect(Object.values(all).every(v => v === true)).toBe(true)
  const none = patchFor('profanity_targets', 'none')?.profanity_targets ?? {}
  expect(Object.values(none).every(v => v === false)).toBe(true)
  const some = patchFor('profanity_targets', 'messages,bios')?.profanity_targets ?? {}
  expect(some.messages).toBe(true)
  expect(some.bios).toBe(true)
  expect(some.usernames).toBe(false)
})

test('"use server config for all" takes the differing controls the page can set', () => {
  const c = config(
    control({ config: 'off' }),
    control({ key: 'sfu', value: 'off', config: 'off' }),
    control({ key: 'widgets', value: 'on', config: 'off', pinned: true }),
    control({ key: 'registration', value: 'open', config: 'closed' }),
    control({ key: 'report_forms', value: 'rev 2, 5 categories', config: 'rev 1, 4 categories' }),
    control({ key: 'calls', value: 'on' })
  )
  expect(differing(c).map(d => d.key)).toEqual(['p2p', 'registration'])
  expect(configPatch(differing(c))).toEqual({ p2p: false, registration: 'closed' })
  expect(differing(null)).toEqual([])
  expect(configSummary(c)).toEqual({ pinned: 1, differs: 3 })
  expect(summaryLine(c)).toBe('1 pinned, 3 differ')
  expect(summaryLine(config(control({ config: 'off' })))).toBe('0 pinned, 1 differs')
  expect(filterControls(c.controls, 'pinned').map(d => d.key)).toEqual(['widgets'])
  expect(filterControls(c.controls, 'differs').map(d => d.key)).toEqual([
    'p2p',
    'registration',
    'report_forms',
  ])
  expect(filterControls(c.controls, 'all')).toHaveLength(6)
})

test('values read as labels', () => {
  expect(shownValue('on')).toBe('On')
  expect(shownValue('off')).toBe('Off')
  expect(shownValue('')).toBe('none')
  expect(shownValue('alice,bob')).toBe('alice,bob')
  expect(shownValue('closed', [{ value: 'closed', label: 'Closed' }])).toBe('Closed')
})

test('a lower file expiry cap is warned about', () => {
  expect(lowersCap('0', '30')).toBe(true)
  expect(lowersCap('60', '30')).toBe(true)
  expect(lowersCap('30', '60')).toBe(false)
  expect(lowersCap('30', '0')).toBe(false)
  expect(lowersCap('30', '30')).toBe(false)
  expect(lowersCap('x', '30')).toBe(false)
  const cap = control({ key: 'upload_expiry_max_days', value: '0', config: '7' })
  expect(applyWarning([control({ config: 'off' }), cap])).toBe(CAP_WARNING)
  expect(applyWarning([control({ config: 'off' })])).toBeNull()
  expect(applyWarning([{ ...cap, value: '7', config: '30' }])).toBeNull()
  expect(saveWarning('upload_expiry_max_days', '30', '7')).toBe(CAP_WARNING)
  expect(saveWarning('upload_expiry_max_days', '0', '7')).toBe(CAP_WARNING)
  expect(saveWarning('upload_expiry_max_days', '7', '30')).toBeNull()
  expect(saveWarning('upload_expiry_max_days', '7', '0')).toBeNull()
  expect(saveWarning('sfu', '30', '7')).toBeNull()
  expect(/[—–]/.test(CAP_WARNING)).toBe(false)
})

test('limits show their value and whether it is the default', () => {
  const limit = { env: 'UPLOAD_MAX_MIB', value: 25, default: 25, range: '1-10240' }
  expect(limitValue(limit)).toBe('25')
  expect(limitChanged(limit)).toBe(false)
  expect(limitChanged({ ...limit, value: 50 })).toBe(true)
  expect(limitValue({ ...limit, value: null, default: null })).toBe('Not set')
})
