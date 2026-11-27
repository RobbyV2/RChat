import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import AdminRoot from '../../components/admin/admin_page'
import { useConfigStore } from '../../components/admin/config_state'
import { useStore } from '../store'
import type { AdminConfig, ConfigControl, SiteSettings } from '../types'
import type { AdminSection } from '../view'
import { me } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }
const configInitial = useConfigStore.getInitialState()

afterEach(() => {
  Object.assign(initial, saved)
  configInitial.config = null
})

const control = (key: string, env: string, over: Partial<ConfigControl> = {}): ConfigControl => ({
  key,
  env,
  value: 'on',
  config: null,
  pinned: false,
  ...over,
})

const config = (over: Partial<Record<string, Partial<ConfigControl>>> = {}): AdminConfig => ({
  controls: [
    control('server_creators', 'SERVER_CREATORS', {
      value: 'alice,lobby:Staff',
      ...over.server_creators,
    }),
    control('default_servers', 'DEFAULT_SERVERS', {
      value: 'rchat,lobby',
      ...over.default_servers,
    }),
    control('report_forms', 'REPORT_FORMS_FILE', { value: 'rev 2, 5 categories' }),
    control('p2p', 'FEATURE_P2P', over.p2p),
  ],
  limits: [],
})

const page = (
  section: AdminSection,
  loaded: AdminConfig | null,
  settings: Partial<SiteSettings> = {},
  item: string | null = null
) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: true }),
    adminPage: { section, item, row: null },
    settings: { ...saved.settings, ...settings },
  })
  configInitial.config = loaded
  return renderToStaticMarkup(<AdminRoot />)
}

const row = (html: string, key: string) => {
  const from = html.indexOf(`id="row-${key}"`)
  const to = html.indexOf('id="row-', from + 1)
  return from === -1 ? '' : html.slice(from, to === -1 ? undefined : to)
}

test('the people who can create servers are listed as names, each with a remove button', () => {
  const creators = row(page('features', config()), 'server_creators')
  expect(creators.match(/class="streamer[^"]*">(alice|lobby:Staff)</g)).toHaveLength(2)
  expect(creators.match(/aria-label="Remove from the list"/g)).toHaveLength(2)
  expect(creators).toContain('aria-label="Add a person or role"')
  expect(row(page('features', null), 'server_creators')).toContain('Loading')
  const none = row(page('features', config({ server_creators: { value: '' } })), 'server_creators')
  expect(none).toContain('Nobody is on the list.')
})

test('what the server config says about a list of names is marked for streamer mode', () => {
  const differs = { config: 'carol,lounge:Staff' }
  const creators = row(page('features', config({ server_creators: differs })), 'server_creators')
  const line = creators.slice(creators.indexOf('data-source="differs"'))
  expect(/Server config says <span class="streamer">carol,lounge:Staff<\/span>\./.test(line)).toBe(
    true
  )
  const defaults = row(page('servers', config({ default_servers: differs })), 'default_servers')
  expect(defaults).toContain('<span class="streamer">carol,lounge:Staff</span>')
  const sign = page('features', {
    controls: [control('registration', 'AUTH_REGISTRATION', { value: 'open', config: 'closed' })],
    limits: [],
  })
  expect(row(sign, 'registration')).toContain('Server config says Closed.')
})

// The buttons of a section that are under 44 px high on touch screens.
const small = (html: string) =>
  (html.slice(html.indexOf('class="max-w-2xl"')).match(/<button[^>]*>/g) ?? []).filter(
    b => !/\bh-11\b|role="switch"/.test(b)
  )

test('the server controls are 44 px high on touch screens', () => {
  expect(small(page('features', config()))).toEqual([])
  expect(small(page('servers', config()))).toEqual([])
  expect(small(page('servers', config(), {}, 'rchat'))).toEqual([])
})

test('a pinned list cannot be edited', () => {
  const pinned = { config: 'alice', pinned: true }
  const creators = row(page('features', config({ server_creators: pinned })), 'server_creators')
  expect(creators.match(/<button[^>]*disabled=""/g)?.length).toBe(3)
  expect(creators).toContain('Set in the server config')
  const defaults = row(page('servers', config({ default_servers: pinned })), 'default_servers')
  expect(defaults.match(/<button[^>]*>/g)?.every(b => b.includes('disabled=""'))).toBe(true)
  expect(defaults).toContain('<code class="font-mono">DEFAULT_SERVERS</code>')
})

test('Features points to the default servers and shows the report forms as they are', () => {
  const html = page('features', config())
  expect(row(html, 'default_servers')).toContain('Edit in Servers')
  expect(row(html, 'report_forms')).toContain('Now: rev 2, 5 categories')
})

test('all of P2P is one button, which the config can lock', () => {
  const on = { p2p: true, p2p_attachments: true, p2p_backup: true }
  const off = { p2p: false, p2p_attachments: false, p2p_backup: false }
  expect(row(page('features', config(), on), 'p2p_all')).toContain('Turn off all P2P')
  expect(row(page('features', config(), off), 'p2p_all')).toContain('Turn on all P2P')
  const locked = row(
    page('features', config({ p2p: { pinned: true, config: 'on' } }), on),
    'p2p_all'
  )
  expect(/<button[^>]*disabled=""/.test(locked)).toBe(true)
})

test('the default servers are an ordered list with move and remove buttons', () => {
  const defaults = row(page('servers', config()), 'default_servers')
  expect(defaults.indexOf('>rchat<')).toBeGreaterThan(-1)
  expect(defaults.indexOf('>rchat<')).toBeLessThan(defaults.indexOf('>lobby<'))
  expect(defaults.match(/class="streamer[^"]*">(rchat|lobby)</g)).toHaveLength(2)
  const ups = defaults.match(/<button[^>]*aria-label="Move up"[^>]*>/g) ?? []
  const downs = defaults.match(/<button[^>]*aria-label="Move down"[^>]*>/g) ?? []
  expect(ups.map(b => b.includes('disabled=""'))).toEqual([true, false])
  expect(downs.map(b => b.includes('disabled=""'))).toEqual([false, true])
  expect(defaults.match(/aria-label="Remove from the list"/g)).toHaveLength(2)
  const none = row(
    page('servers', config({ default_servers: { value: 'none' } })),
    'default_servers'
  )
  expect(none).toContain('New accounts join no server.')
})

test('the servers section makes a server for someone and manages the built-in one', () => {
  const html = page('servers', config())
  expect(row(html, 'create_server')).toContain('aria-label="Owner&#x27;s username"')
  expect(row(html, 'create_server')).toContain('Create server')
  expect(html).toContain('id="row-builtin_server"')
  expect(page('servers', config(), { builtin_server: 'removed' })).not.toContain(
    'id="row-builtin_server"'
  )
})

test('the built-in server cannot be deleted while it is a default server', () => {
  const del = (html: string) => html.match(/<button[^>]*>Delete server<\/button>/)?.[0] ?? ''
  const kept = page('servers', config(), {}, 'rchat')
  expect(del(kept)).toContain('disabled=""')
  expect(kept).toContain('Take it off the default servers to delete it.')
  const off = page('servers', config({ default_servers: { value: 'lobby' } }), {}, 'rchat')
  expect(del(off)).not.toContain('disabled=""')
  expect(del(page('servers', config(), {}, 'lobby'))).not.toContain('disabled=""')
  const gone = page('servers', config(), { builtin_server: 'removed' }, 'rchat')
  expect(del(gone)).not.toContain('disabled=""')
})
