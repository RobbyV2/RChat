import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ADMIN_GROUPS,
  ADMIN_ROWS,
  adminRow,
  featureSearchRows,
  groupRows,
  registrationOptions,
  rowsUnder,
} from '../admin_rows'
import { BRAND_ROWS } from '../admin_brand'
import { patchFor } from '../admin_config'
import { searchRows } from '../settings_search'
import type { SiteSettings } from '../types'

// Every key of the site settings, so a new one fails the type check until it is listed here.
const SETTINGS: Record<keyof SiteSettings, true> = {
  profanity_filter: true,
  profanity_targets: true,
  profanity_strict_file_names: true,
  asset_previews: true,
  asset_uploads: true,
  p2p_attachments: true,
  guests_enabled: true,
  guest_chat_enabled: true,
  guest_voice_enabled: true,
  outgoing_webhooks: true,
  server_reports: true,
  instance_reports: true,
  widgets: true,
  widget_chat: true,
  widget_read_links: true,
  widget_bridge: true,
  e2ee: true,
  e2ee_compliance: true,
  backup_phrase: true,
  p2p_backup: true,
  display_names: true,
  onboarding: true,
  password_login: true,
  sfu: true,
  p2p: true,
  client_other_instances: true,
  server_profiles: true,
  docs: true,
  scheduled_messages: true,
  interactive_docs: true,
  member_lists: true,
  profile_pictures: true,
  animated_profile_pictures: true,
  gifs: true,
  registration: true,
  upload_expiry_max_days: true,
  server_joining: true,
  public_reading: true,
  profile_visibility: true,
  profile_choices: true,
  password_change: true,
  temp_password_hours: true,
  server_creation: true,
  server_search: true,
  dm_creation: true,
  friend_requests: true,
  calls: true,
  incoming_webhooks: true,
  guest_servers: true,
  builtin_server: true,
  encryption_required: true,
  encryption_ready: true,
}

// Settings the server works out from others, or that their own page sets: no settings row
// sets them.
const DERIVED = ['guest_servers', 'builtin_server', 'encryption_required', 'encryption_ready']

// The env names of the settings the admin page also changes, from the settings registry.
const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../assets/settings.json', import.meta.url)),
    'utf8'
  )
) as { settings: { env: string; scope: string }[] }
const marked = registry.settings.filter(s => s.scope === 'live').map(s => s.env)

test('every site setting has a row', () => {
  const keys = ADMIN_ROWS.map(r => r.key)
  for (const key of Object.keys(SETTINGS)) {
    if (DERIVED.includes(key)) expect(keys).not.toContain(key)
    else expect(keys).toContain(key)
  }
})

test('every setting the server config marks for the admin page has a row', () => {
  const envs = [...ADMIN_ROWS, ...BRAND_ROWS].map(r => r.env)
  for (const env of marked) expect(envs).toContain(env)
})

test('a control is a feature or a part of the brand, never both', () => {
  const features = ADMIN_ROWS.map(r => r.key)
  for (const row of BRAND_ROWS) {
    expect(features).not.toContain(row.key)
    expect(marked).toContain(row.env)
  }
  const keys = BRAND_ROWS.map(r => r.key)
  expect(new Set(keys).size).toBe(keys.length)
})

test('the page sets every control the way its row says', () => {
  for (const row of ADMIN_ROWS) {
    const patch = patchFor(row.key, row.kind === 'number' ? '7' : 'x')
    const value = (patch as Record<string, unknown> | null)?.[row.key]
    switch (row.kind) {
      case 'names':
        expect(value).toEqual(['x'])
        break
      case 'link':
        expect(row.key).toBe('default_servers')
        expect(value).toEqual(['x'])
        break
      case 'number':
        expect(value).toBe(7)
        break
      case 'info':
        expect(patch).toBeNull()
        break
      case 'targets':
        expect(Object.keys(patch ?? {})).toEqual(['profanity_targets'])
        break
      case 'switch':
        expect(patchFor(row.key, 'on')).toEqual({ [row.key]: true } as never)
        break
      case 'choice':
        expect(value).toBe('x')
        break
    }
  }
})

test('rows are unique and each names a setting of the server config that the page can change', () => {
  const keys = ADMIN_ROWS.map(r => r.key)
  expect(new Set(keys).size).toBe(keys.length)
  const envs = ADMIN_ROWS.map(r => r.env)
  expect(new Set(envs).size).toBe(envs.length)
  expect(marked.length).toBeGreaterThan(20)
  for (const env of envs) expect(marked).toContain(env)
})

test('every row has a label and plain lines', () => {
  for (const row of ADMIN_ROWS) {
    const lines = [
      row.line,
      ...(row.kind === 'switch' && row.off ? [row.off] : []),
      ...(row.kind === 'choice' ? row.options.flatMap(o => (o.line ? [o.line] : [])) : []),
      ...(row.kind === 'choice' && row.note ? [row.note] : []),
    ]
    const text = [row.label, ...lines].join(' ')
    expect(row.label.length).toBeGreaterThan(0)
    expect(/[—–]/.test(text)).toBe(false)
    expect(/rchat/i.test(text)).toBe(false)
    expect(text).not.toContain('\n')
    for (const line of lines) expect(line.endsWith('.')).toBe(true)
  }
})

test('every row is in a group, alone or under a row of the same group', () => {
  const shown = ADMIN_GROUPS.flatMap(g => groupRows(g).flatMap(r => [r, ...rowsUnder(r.key)]))
  expect(shown.map(r => r.key).sort()).toEqual(ADMIN_ROWS.map(r => r.key).sort())
  for (const row of ADMIN_ROWS) if (row.under) expect(adminRow(row.under)?.group).toBe(row.group)
  expect(groupRows('Accounts')[0].key).toBe('registration')
})

test('who can see profiles reads from the widest choice to the default one', () => {
  const row = adminRow('profile_visibility')
  if (row?.kind !== 'choice') throw new Error('profile_visibility is a choice')
  expect(row.options).toEqual([
    {
      value: 'everyone',
      label: 'Everyone',
      line: 'Anyone who can use the app here sees every profile.',
    },
    {
      value: 'public_servers',
      label: 'People in public servers',
      line: 'Profiles of people in a public server are open to all. Others show only to people who share a server with them.',
    },
    {
      value: 'shared',
      label: 'People who share a server',
      line: 'A profile shows only to people who share a server, a DM or a friendship with that person.',
    },
  ])
  expect(row.note).toBe(
    'Names next to messages and in member lists always show where people can read them.'
  )
})

test('a choice row lists every value the setting can take', () => {
  const values = (key: string) => {
    const row = adminRow(key)
    return row?.kind === 'choice' ? row.options.map(o => o.value) : []
  }
  expect(values('registration')).toEqual(['open', 'sso', 'closed'])
  expect(values('server_joining')).toEqual(['everyone', 'invites', 'nobody'])
  expect(values('profile_visibility').sort()).toEqual(['everyone', 'public_servers', 'shared'])
  expect(values('profile_choices')).toEqual(['any', 'narrower', 'site'])
  expect(values('server_creation')).toEqual(['everyone', 'nobody', 'some'])
  expect(values('dm_creation')).toEqual(['everyone', 'friends', 'nobody'])
})

test('sign-on only is offered only while it is the stored value', () => {
  expect(registrationOptions('open').map(o => o.value)).toEqual(['open', 'closed'])
  expect(registrationOptions('closed').map(o => o.value)).toEqual(['open', 'closed'])
  const stored = registrationOptions('sso')
  expect(stored.map(o => o.value)).toEqual(['open', 'sso', 'closed'])
  expect(stored[1].line).toBe('No sign-in provider is set up, so nobody can sign up.')
})

test('search finds rows by label, line, group, option and env name', () => {
  const sections = [{ id: 'features', label: 'Features', rows: featureSearchRows() }]
  const ids = (q: string) => searchRows(sections, q).map(h => h.row.id)
  expect(ids('join')[0]).toBe('server_joining')
  expect(ids('FEATURE_P2P')).toContain('p2p')
  expect(ids('sign-on')).toEqual(['registration'])
  expect(ids('widgets').slice(0, 1)).toEqual(['widgets'])
  expect(ids('safety')).toContain('profanity_filter')
  expect(searchRows(sections, 'guests')[0].trail).toEqual(['Features', 'Accounts', 'Guests'])
  expect(featureSearchRows().find(r => r.id === 'default_servers')?.section).toBe('servers')
  expect(ids('SERVER_CREATORS')).toEqual(['server_creators'])
})
