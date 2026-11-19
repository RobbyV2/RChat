import { afterAll, afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import AdminRoot from '../../components/admin/admin_page'
import { CAP_NOTE } from '../../components/admin/config'
import { useConfigStore } from '../../components/admin/config_state'
import { resetSessionCaches, useStore } from '../store'
import type { AdminConfig, ConfigControl } from '../types'
import type { AdminSection } from '../view'
import { me } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }
const configInitial = useConfigStore.getInitialState()

afterEach(() => {
  Object.assign(initial, saved)
  configInitial.config = null
})

afterAll(resetSessionCaches)

const control = (key: string, env: string, over: Partial<ConfigControl> = {}): ConfigControl => ({
  key,
  env,
  value: 'on',
  config: null,
  pinned: false,
  ...over,
})

const config: AdminConfig = {
  controls: [
    control('p2p', 'FEATURE_P2P', { config: 'on', pinned: true }),
    control('guests_enabled', 'GUESTS_ENABLED', { config: 'on' }),
    control('registration', 'AUTH_REGISTRATION', { value: 'open', config: 'closed' }),
    control('widgets', 'WIDGETS'),
    control('upload_expiry_max_days', 'UPLOAD_EXPIRY_MAX_DAYS', { value: '0' }),
    control('server_creators', 'SERVER_CREATORS', { value: 'alice,lobby:Staff' }),
    control('report_forms', 'REPORT_FORMS_FILE', {
      value: 'rev 2, 5 categories',
      config: 'rev 1, 4 categories',
    }),
  ],
  limits: [
    { env: 'UPLOAD_MAX_MIB', value: 50, default: 25, range: '1-10240' },
    { env: 'LOOKUP_SEARCH_PER_MINUTE', value: 30, default: 30, range: '1-1000' },
    { env: 'RARE_REQUESTS_PER_HOUR', value: 20, default: 20, range: '0-10000' },
    { env: 'REPORT_FEEDBACK_PER_WEEK', value: 10, default: 10, range: '0-100000' },
  ],
}

const page = (section: AdminSection, loaded: AdminConfig | null = config) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: true }),
    adminPage: { section, item: null, row: null },
    settings: { ...saved.settings, p2p: true, guests_enabled: true, widgets: true },
  })
  configInitial.config = loaded
  return renderToStaticMarkup(<AdminRoot />)
}

// The markup of one row of the Features section.
const row = (html: string, key: string) => {
  const from = html.indexOf(`id="row-${key}"`)
  const to = html.indexOf('id="row-', from + 1)
  return html.slice(from, to === -1 ? undefined : to)
}

test('a pinned row is locked and names its setting in the server config', () => {
  const p2p = row(page('features'), 'p2p')
  expect(p2p).toContain('data-source="pinned"')
  expect(p2p).toContain('Set in the server config (<code class="font-mono">FEATURE_P2P</code>)')
  expect(/<button[^>]*role="switch"[^>]*disabled=""/.test(p2p)).toBe(true)
  expect(p2p).not.toContain('Use it')
})

test('a row whose value is the config value says so', () => {
  const guests = row(page('features'), 'guests_enabled')
  expect(guests).toContain('data-source="same"')
  expect(guests).toContain('From server config')
  expect(/<button[^>]*role="switch"[^>]*disabled=""/.test(guests)).toBe(false)
})

test('a row that differs from the config says what the config says and offers it', () => {
  const sign = row(page('features'), 'registration')
  expect(sign).toContain('data-source="differs"')
  expect(sign).toContain('Server config says Closed.')
  expect(sign).toContain('Use it')
})

test('a row the config does not set, or a page without the config view, shows no source', () => {
  expect(row(page('features'), 'widgets')).not.toContain('data-source')
  expect(page('features', null)).not.toContain('data-source')
})

test('the config section lists every control with its source, and the limits read-only', () => {
  const html = page('config')
  for (const c of config.controls) {
    expect(html).toContain(`id="row-config-${c.key}"`)
    expect(html).toContain(c.env)
  }
  expect(html).toContain('1 pinned, 2 differ')
  expect(html).toContain('Use server config for all')
  expect(html).toContain('Restart to change')
  for (const l of config.limits) expect(html).toContain(`id="row-limit-${l.env}"`)
  expect(html).toContain('Default 25')
  expect(html).toContain('Range 1-10240')
  expect(html).toContain(CAP_NOTE)
  expect(/class="[^"]*streamer[^"]*">alice,lobby:Staff/.test(html)).toBe(true)
  const forms = html.slice(html.indexOf('id="row-config-report_forms"'))
  expect(forms.slice(0, forms.indexOf('id="row-', 1))).not.toContain('Use server config')
  expect(page('config', null)).toContain('Loading')
})

// The buttons and chips of a section that are under 44 px high on touch screens.
const small = (html: string) =>
  (html.slice(html.indexOf('class="max-w-2xl"')).match(/<button[^>]*>/g) ?? []).filter(
    b => !/\bh-11\b|role="switch"/.test(b)
  )

test('the config section and the source lines are 44 px high on touch screens', () => {
  expect(page('config')).toContain('Use server config</button>')
  expect(small(page('config'))).toEqual([])
  expect(page('features')).toContain('Use it')
  expect(small(page('features'))).toEqual([])
})

test('the overview links to the config with its summary', () => {
  const html = page('overview')
  expect(html).toContain('Server config')
  expect(html).toContain('1 pinned, 2 differ')
  expect(page('overview', null)).not.toContain('Server config')
})
