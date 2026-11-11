import { expect, test } from 'bun:test'
import { instanceAuditLine } from '../instance_audit'
import type { InstanceAuditEntry } from '../types'

const entry = (over: Partial<InstanceAuditEntry> = {}): InstanceAuditEntry => ({
  id: 1,
  at: 1_700_000_000,
  actor: 'root',
  action: 'settings.change',
  target: 'p2p',
  detail: { key: 'p2p', from: 'on', to: 'off' },
  ...over,
})

const text = (e: InstanceAuditEntry) =>
  instanceAuditLine(e)
    .map(p => p.text)
    .join('')

const names = (e: InstanceAuditEntry) =>
  instanceAuditLine(e)
    .filter(p => p.name)
    .map(p => p.text)

const config = (over: Partial<InstanceAuditEntry> = {}) =>
  entry({
    actor: null,
    action: 'settings.config',
    target: 'registration',
    detail: { key: 'registration', from: 'closed', to: 'sso', by: 'config' },
    ...over,
  })

test('a change the server config applied at a start is shown as made by it', () => {
  expect(text(config())).toBe('Server config changed registration from closed to sso')
  expect(names(config())).toEqual([])
})

test('a change in the admin panel names the admin, and only the admin is a name', () => {
  expect(text(entry())).toBe('root changed p2p from on to off')
  expect(names(entry())).toEqual(['root'])
})

test('no actor without the config mark is a deleted account, on every action', () => {
  expect(text(entry({ actor: null }))).toBe('Deleted user changed p2p from on to off')
  const unmarked = config({ detail: { key: 'registration', from: 'closed', to: 'sso' } })
  expect(text(unmarked)).toBe('Deleted user changed registration from closed to sso')
  expect(
    text(entry({ actor: null, action: 'user.remove_phrase', target: 'bob', detail: {} }))
  ).toBe('Deleted user removed the backup phrase of bob')
})

test('the config mark is read on any action', () => {
  const later = entry({
    actor: null,
    action: 'user.create',
    target: 'dana',
    detail: { by: 'config' },
  })
  expect(text(later)).toBe('Server config user.create dana')
  expect(names(later)).toEqual(['dana'])
})

test('values are shown as written: empty reads nothing, long lists are cut', () => {
  expect(text(entry({ detail: { key: 'list', from: '', to: 'a,b' } }))).toBe(
    'root changed list from nothing to a,b'
  )
  const long = 'x'.repeat(200)
  expect(text(entry({ detail: { key: 'list', from: long, to: '' } }))).toBe(
    `root changed list from ${'x'.repeat(120)}... to nothing`
  )
})

test('a detail without the expected fields still reads as a sentence', () => {
  for (const detail of [null, 'text', 7, [], {}, { key: 5, from: 'on' }]) {
    expect(text(entry({ detail }))).toBe('root changed p2p')
  }
  expect(text(entry({ target: null, detail: {} }))).toBe('root changed a setting')
  expect(text(entry({ detail: { key: 'e2ee' } }))).toBe('root changed e2ee')
})

test('other actions keep their lines', () => {
  const phrase = entry({ action: 'user.remove_phrase', target: 'bob', detail: {} })
  expect(text(phrase)).toBe('root removed the backup phrase of bob')
  expect(names(phrase)).toEqual(['root', 'bob'])
  expect(text(entry({ action: 'sso.config', target: 'okta', detail: {} }))).toBe(
    'root sso.config okta'
  )
})

test('a server the admin made for someone names the server and its owner', () => {
  const made = entry({ action: 'server.create', target: 'club', detail: { owner: 'dave' } })
  expect(text(made)).toBe('root created the server club for dave')
  expect(names(made)).toEqual(['root', 'club', 'dave'])
  const gone = entry({ action: 'server.create', target: 'club', detail: { owner: null } })
  expect(text(gone)).toBe('root created the server club for a deleted user')
  expect(names(gone)).toEqual(['root', 'club'])
  expect(text(entry({ action: 'server.create', target: 'club', detail: {} }))).toBe(
    'root created the server club'
  )
  expect(text(entry({ action: 'server.create', target: null, detail: null }))).toBe(
    'root created a server'
  )
})

test('the list of server creators holds names, so its values are marked', () => {
  const list = entry({
    target: 'server_creators',
    detail: { key: 'server_creators', from: '', to: 'bob,lobby:Staff' },
  })
  expect(text(list)).toBe('root changed server_creators from nothing to bob,lobby:Staff')
  expect(names(list)).toEqual(['root', 'bob,lobby:Staff'])
  expect(names(entry())).toEqual(['root'])
})
