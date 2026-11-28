import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import AdminRoot from '../../components/admin/admin_page'
import { useConfigStore } from '../../components/admin/config_state'
import { BRAND_ROWS } from '../admin_brand'
import { useStore } from '../store'
import type { AdminConfig, Brand, ConfigControl } from '../types'
import { adminPath, parsePath } from '../view'
import { me } from './fixtures'
import { Secret } from '../secret'

const initial = useStore.getInitialState()
const saved = { ...initial }
const configInitial = useConfigStore.getInitialState()

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
  configInitial.config = null
})

const control = (key: string, value: string, over: Partial<ConfigControl> = {}): ConfigControl =>
  ({
    key,
    env: BRAND_ROWS.find(r => r.key === key)?.env ?? key.toUpperCase(),
    value,
    config: null,
    pinned: false,
    ...over,
  }) as ConfigControl

const config = (over: Partial<Record<string, Partial<ConfigControl>>> = {}): AdminConfig =>
  ({
    controls: [
      control('instance_name', 'Example Chat', over.instance_name),
      control('app_name', '', over.app_name),
      control('app_short_name', 'Example', over.app_short_name),
      control('brand_about', 'Run by us.\nBe kind.', over.brand_about),
      control(
        'brand_links',
        '[{"label":"Help","url":"https://help.example.com/"}]',
        over.brand_links
      ),
      control('login_note', '', over.login_note),
      control(
        'instance_suggestions',
        '{"mode":"replace","list":[{"url":"https://other.example.com","label":"Other"}]}',
        over.instance_suggestions
      ),
    ],
    limits: [],
  }) as unknown as AdminConfig

const brand = (over: Partial<Brand> = {}): Brand => ({
  instance_name: 'Example Chat',
  app_name: 'Example Chat',
  short_name: 'Example',
  about: '',
  links: [],
  login_note: '',
  suggestions: { mode: 'add', list: [] },
  assets: {},
  ...over,
})

const page = (loaded: AdminConfig | null, part: Partial<typeof initial> = {}) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: true }),
    adminPage: { section: 'branding', item: null, row: null },
    ...part,
  })
  configInitial.config = loaded
  return renderToStaticMarkup(<AdminRoot />)
}

const row = (html: string, key: string) => {
  const from = html.indexOf(`id="row-${key}"`)
  const to = html.indexOf('id="row-', from + 1)
  return from === -1 ? '' : html.slice(from, to === -1 ? undefined : to)
}

test('the branding section has a place in the page and its address', () => {
  expect(adminPath('branding')).toBe('/admin/branding/')
  expect(parsePath('/admin/branding/')).toEqual({ kind: 'admin', section: 'branding', item: null })
  expect(parsePath('/admin/branding/logo/')).toBeNull()
  const html = page(config())
  expect(html).toContain('>Branding<')
  for (const group of ['Names', 'Pictures', 'Texts', 'Announcements', 'Other instances'])
    expect(html).toContain(`aria-label="${group}"`)
})

test('every brand control shows what is stored', () => {
  const html = page(config())
  for (const r of BRAND_ROWS) {
    expect(row(html, r.key)).toContain(r.label)
    expect(row(html, r.key)).toContain(r.line.replace(/'/g, '&#x27;'))
  }
  expect(row(html, 'instance_name')).toContain('value="Example Chat"')
  expect(row(html, 'app_name')).toContain('value=""')
  expect(row(html, 'brand_about')).toContain('Run by us.\nBe kind.</textarea>')
  const links = row(html, 'brand_links')
  expect(links).toContain('value="Help"')
  expect(links).toContain('value="https://help.example.com/"')
  expect(links).toContain('aria-label="Remove the link"')
  const suggested = row(html, 'instance_suggestions')
  expect(suggested).toContain('value="https://other.example.com"')
  expect(suggested).toContain('value="Other"')
  expect(
    /aria-checked="true"[^>]*><span[^>]*>Instead of the app&#x27;s own list</.test(suggested)
  ).toBe(true)
  expect(row(page(config({ brand_links: { value: '[]' } })), 'brand_links')).toContain('No links.')
})

test('before the config view loads the controls wait, and a pinned one is locked', () => {
  const waiting = page(null)
  expect(row(waiting, 'instance_name')).toContain('Loading')
  expect(/<input[^>]*disabled=""/.test(row(waiting, 'instance_name'))).toBe(true)
  const pinned = row(
    page(config({ instance_name: { pinned: true, config: 'Example Chat' } })),
    'instance_name'
  )
  expect(pinned).toContain('data-source="pinned"')
  expect(pinned).toContain('<code class="font-mono">INSTANCE_NAME</code>')
  expect(/<input[^>]*disabled=""/.test(pinned)).toBe(true)
  const same = row(page(config({ instance_name: { config: 'Example Chat' } })), 'instance_name')
  expect(same).toContain('From server config')
  const differs = row(page(config({ app_name: { config: 'Config App' } })), 'app_name')
  expect(differs).toContain('The server config has another value.')
  expect(differs).toContain('Use it')
  expect(differs).not.toContain('Config App')
})

test('the pictures show what is uploaded, with a way to replace or remove it', () => {
  const none = page(config(), { brand: brand() })
  expect(row(none, 'brand_logo')).toContain('>None<')
  expect(row(none, 'brand_logo')).toContain('>Upload<')
  expect(row(none, 'brand_logo')).not.toContain('>Remove<')
  const set = page(config(), {
    brand: brand({
      assets: {
        logo: '/brand/logo.png?v=abc',
        'mark-192': '/brand/mark-192.png?v=def',
      },
    }),
  })
  expect(row(set, 'brand_logo')).toContain('/brand/logo.png?v=abc')
  expect(row(set, 'brand_logo')).toContain('>Replace<')
  expect(row(set, 'brand_logo')).toContain('>Remove<')
  expect(row(set, 'brand_mark')).toContain('/brand/mark-192.png?v=def')
  expect(row(set, 'brand_mark')).toContain('alt="Mark uploaded now"')
})

test('a brand change from the instance reaches the app', () => {
  useStore.setState({ token: Secret.of('tok'), me: me('bob') })
  expect(useStore.getState().brand).toBeNull()
  useStore.getState().applyWsEvent({
    type: 'brand_changed',
    brand: {
      instance_name: 'Example Chat',
      app_name: 'Example App',
      assets: { logo: 'x' },
    } as unknown as Brand,
  })
  expect(useStore.getState().brand).toEqual(
    brand({ app_name: 'Example App', short_name: 'Example App' })
  )
  useStore.getState().applyWsEvent({ type: 'brand_changed', brand: 'nonsense' as never })
  expect(useStore.getState().brand).toBeNull()
})
