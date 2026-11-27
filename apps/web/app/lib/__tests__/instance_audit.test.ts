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

test('an entry the command line made is shown as made by it', () => {
  const made = entry({
    actor: null,
    action: 'user.remove_phrase',
    target: 'bob',
    detail: { by: 'cli' },
  })
  expect(text(made)).toBe('Command line removed the backup phrase of bob')
  expect(names(made)).toEqual(['bob'])
})

test('account and brand actions read as sentences that hold no secret', () => {
  const line = (action: string, target: string | null, detail: unknown = {}, actor = 'root') =>
    text(entry({ action, target, detail, actor }))
  expect(line('user.create', 'dana', { display_name: 'Dana R.', servers: ['club'] })).toBe(
    'root created the account of dana'
  )
  expect(line('user.create', null)).toBe('root created the account of a deleted user')
  expect(line('user.temp_password', 'dana', { expires_at: 5 })).toBe(
    'root gave a new temporary password to dana'
  )
  expect(line('user.sign_out', 'dana', { sessions: 2 })).toBe('root signed out dana')
  expect(line('user.password_set', 'dana', {}, 'dana')).toBe('dana chose their own password')
  expect(line('server.add_member', 'dana', { server: 'club', roles: [3] })).toBe(
    'root added dana to club'
  )
  expect(line('server.add_member', null, { server: 'club', roles: [] })).toBe(
    'root added a deleted user to club'
  )
  expect(
    names(entry({ action: 'server.add_member', target: 'dana', detail: { server: 'club' } }))
  ).toEqual(['root', 'dana', 'club'])
  expect(line('branding.change', 'instance_name', { key: 'instance_name' })).toBe(
    'root changed the instance name'
  )
  expect(line('branding.change', 'mark-192', { key: 'mark-192' })).toBe('root changed the mark')
  expect(line('branding.change', 'logo', { key: 'logo' })).toBe('root changed the logo')
  expect(line('branding.change', 'other', {})).toBe('root changed the brand')
})

test('the config mark is read on any action', () => {
  const later = entry({
    actor: null,
    action: 'user.rename',
    target: 'dana',
    detail: { by: 'config' },
  })
  expect(text(later)).toBe('Server config user.rename dana')
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

test('a detail without the expected fields reads as a sentence', () => {
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

test('a change of the report forms reads as a sentence', () => {
  const forms = entry({ action: 'report_forms.change', target: null, detail: { rev: 2 } })
  expect(text(forms)).toBe('root changed the report forms')
  expect(names(forms)).toEqual(['root'])
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

test('the default servers are server names, so their values are marked', () => {
  const list = entry({
    target: 'default_servers',
    detail: { key: 'default_servers', from: 'rchat', to: 'rchat,lounge' },
  })
  expect(text(list)).toBe('root changed default_servers from rchat to rchat,lounge')
  expect(names(list)).toEqual(['root', 'rchat', 'rchat,lounge'])
})

const staff = (action: string, target: string | null, detail: unknown) =>
  entry({ action, target, detail })

test('staff views read as sentences with ids and counts, and only names are names', () => {
  const server = staff('staff.view_server', 'club', {})
  expect(text(server)).toBe('root opened club as staff')
  expect(names(server)).toEqual(['root', 'club'])
  expect(text(staff('staff.view_channel', 'club', { channel: 12 }))).toBe(
    'root opened private channel 12 of club'
  )
  expect(text(staff('staff.view_channel', null, {}))).toBe(
    'root opened a private channel of a deleted server'
  )
  expect(text(staff('staff.search', null, { hits: 1, channels: [12] }))).toBe(
    'root found 1 message in 1 private channel by search'
  )
  expect(text(staff('staff.search', null, { hits: 7, channels: [12, 15] }))).toBe(
    'root found 7 messages in 2 private channels by search'
  )
  expect(text(staff('staff.search', null, {}))).toBe('root searched private channels')
  expect(text(staff('staff.media', 'club', { channel: 12, message: 40, media: 'abc' }))).toBe(
    'root opened a file in channel 12 of club as staff'
  )
  expect(text(staff('report.view', 'club', {}))).toBe('root read the reports of club as staff')
})

test('a purge of held P2P data shows its counts and who it was for', () => {
  const purge = staff('staff.p2p_data', 'bob', { op: 'purge', backups: 2, identities: 1 })
  expect(text(purge)).toBe('root removed the P2P data held for bob (2 backups, 1 identity)')
  expect(names(purge)).toEqual(['root', 'bob'])
  expect(text(staff('staff.p2p_data', null, { op: 'purge', backups: 1, identities: 0 }))).toBe(
    'root removed the P2P data held for a deleted user (1 backup, 0 identities)'
  )
  expect(text(staff('staff.p2p_data', 'bob', { op: 'view' }))).toBe(
    'root viewed the P2P data held for bob'
  )
})

test('a staff entry shows the reason it was given, and other entries never do', () => {
  expect(text(staff('staff.view_channel', 'club', { channel: 12, reason: 'Report 12' }))).toBe(
    'root opened private channel 12 of club. Reason: Report 12'
  )
  expect(names(staff('staff.view_server', 'club', { reason: 'club' }))).toEqual(['root', 'club'])
  expect(text(entry({ detail: { key: 'p2p', from: 'on', to: 'off', reason: 'x' } }))).toBe(
    'root changed p2p from on to off'
  )
})

test('encryption requirements and the saved key copy read as sentences', () => {
  const site = (on: boolean) =>
    entry({ action: 'encryption.required', target: null, detail: { on } })
  expect(text(site(true))).toBe('root required encrypted storage on this site')
  expect(text(site(false))).toBe('root stopped requiring encrypted storage on this site')
  const server = entry({
    action: 'encryption.server_required',
    target: 'den',
    detail: { on: true },
  })
  expect(text(server)).toBe('root required encrypted storage in den')
  expect(names(server)).toEqual(['root', 'den'])
  const gone = entry({ action: 'encryption.server_required', target: null, detail: { on: false } })
  expect(text(gone)).toBe('root stopped requiring encrypted storage in a server')
  const saved = entry({ action: 'encryption.backed_up', target: null, detail: {} })
  expect(text(saved)).toBe('root saved a copy of the key file')
  const rotated = entry({ action: 'encryption.rotate', target: null, detail: { purposes: [] } })
  expect(text(rotated)).toBe('root rotated data keys')
})
