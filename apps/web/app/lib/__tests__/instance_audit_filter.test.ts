import { expect, test } from 'bun:test'
import {
  AUDIT_KINDS,
  QUIET_PAGES,
  auditFiltered,
  auditKind,
  auditMatches,
  autoLoads,
  quietPages,
} from '../instance_audit'
import type { InstanceAuditEntry } from '../types'

const entry = (over: Partial<InstanceAuditEntry> = {}): InstanceAuditEntry => ({
  id: 1,
  at: 1_700_000_000,
  actor: 'root',
  action: 'user.remove_phrase',
  target: 'Bob',
  detail: {},
  ...over,
})

test('an action has the kind of its prefix', () => {
  expect(auditKind('settings.change')).toBe('settings')
  expect(auditKind('settings.config')).toBe('settings')
  expect(auditKind('report_forms.change')).toBe('settings')
  expect(auditKind('encryption.required')).toBe('settings')
  expect(auditKind('user.remove_phrase')).toBe('accounts')
  expect(auditKind('server.create')).toBe('servers')
  expect(auditKind('sso.config')).toBe('sign_in')
  expect(auditKind('staff.view_channel')).toBe('staff')
  expect(auditKind('staff.p2p_data')).toBe('staff')
  expect(auditKind('report.view')).toBe('staff')
  expect(auditKind('something.else')).toBeNull()
  expect(AUDIT_KINDS[0].value).toBe('all')
})

test('the kind filter keeps entries of that kind', () => {
  expect(auditMatches(entry(), 'all', '')).toBe(true)
  expect(auditMatches(entry(), 'accounts', '')).toBe(true)
  expect(auditMatches(entry(), 'settings', '')).toBe(false)
  expect(auditMatches(entry({ action: 'something.else' }), 'all', '')).toBe(true)
  expect(auditMatches(entry({ action: 'something.else' }), 'servers', '')).toBe(false)
})

test('the person filter matches who did it or whom it was done to', () => {
  expect(auditMatches(entry(), 'all', 'ROO')).toBe(true)
  expect(auditMatches(entry(), 'all', ' @bob ')).toBe(true)
  expect(auditMatches(entry(), 'all', 'carol')).toBe(false)
  expect(auditMatches(entry({ actor: null, target: null }), 'all', 'bob')).toBe(false)
  expect(auditMatches(entry(), 'settings', 'bob')).toBe(false)
})

test('the person filter also matches a name in what changed', () => {
  const made = entry({ action: 'server.create', target: 'pixel club', detail: { owner: 'dana' } })
  expect(auditMatches(made, 'all', 'dana')).toBe(true)
  expect(auditMatches(made, 'all', 'pixel')).toBe(true)
  expect(auditMatches(made, 'all', 'created')).toBe(false)
  const creators = entry({
    action: 'settings.change',
    target: 'server_creators',
    detail: { key: 'server_creators', from: 'alice', to: 'alice,carol' },
  })
  expect(auditMatches(creators, 'all', 'carol')).toBe(true)
  expect(auditMatches(creators, 'all', 'server_creators')).toBe(false)
})

test('a filter is on while it narrows the list', () => {
  expect(auditFiltered('all', '')).toBe(false)
  expect(auditFiltered('all', ' @ ')).toBe(false)
  expect(auditFiltered('servers', '')).toBe(true)
  expect(auditFiltered('all', 'bob')).toBe(true)
})

test('a filtered list stops loading by itself after a few pages without a match', () => {
  expect(autoLoads(false, 50)).toBe(true)
  expect(autoLoads(true, 0)).toBe(true)
  expect(autoLoads(true, QUIET_PAGES - 1)).toBe(true)
  expect(autoLoads(true, QUIET_PAGES)).toBe(false)
  expect(QUIET_PAGES).toBeGreaterThan(1)
})

test('the quiet pages are the last loaded ones without a match', () => {
  const bob = entry()
  const carol = entry({ id: 2, target: 'Carol' })
  expect(quietPages([[bob], [carol], [carol]], 'all', 'bob')).toBe(2)
  expect(quietPages([[bob], [carol], [bob, carol]], 'all', 'bob')).toBe(0)
  expect(quietPages([[carol], []], 'servers', '')).toBe(2)
  expect(quietPages([], 'all', 'bob')).toBe(0)
})
