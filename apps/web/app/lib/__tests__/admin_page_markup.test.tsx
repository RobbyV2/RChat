import { afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AdminRoot from '../../components/admin/admin_page'
import { AdminHost } from '../../components/admin/admin_host'
import { AccountRows } from '../../components/admin/users'
import { ServerRail } from '../../components/server_rail'
import { ADMIN_ROWS } from '../admin_rows'
import { paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { paletteCommands } from '../actions/palette'
import { actionById } from '../actions/registry'
import { rowAnchor } from '../settings_page'
import { useStore } from '../store'
import type { AdminPlace } from '../store_types'
import { ADMIN_SECTIONS } from '../view'
import { me, user } from './fixtures'
import { pagesOf } from './helpers/loads'
import { Secret } from '../secret'

const initial = useStore.getInitialState()
const saved = { ...initial }

beforeAll(registerAppActions)

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

const place = (section: AdminPlace['section'], item: string | null = null): AdminPlace => ({
  section,
  item,
  row: null,
})

const page = (adminPage: AdminPlace | null, admin = true, part: Partial<typeof initial> = {}) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: admin }),
    adminPage,
    ...part,
  })
  return renderToStaticMarkup(<AdminRoot />)
}

test('the page lists every section and shows the open one', () => {
  const html = page(place('features'))
  expect(html).toContain('Site administration')
  for (const label of [
    'Overview',
    'Features',
    'Users',
    'Servers',
    'Audit log',
    'Config',
    'Encryption',
    'Danger zone',
  ])
    expect(html).toContain(`>${label}</span>`)
  expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  expect(html).toContain('data-screen="section"')
  expect(page(place(null))).toContain('data-screen="list"')
  expect(page(null)).toBe('')
})

test('every section renders', () => {
  for (const section of ADMIN_SECTIONS) expect(page(place(section)).length).toBeGreaterThan(500)
})

test('the Features section has an anchor for every row, sign-up first', () => {
  const html = page(place('features'))
  for (const row of ADMIN_ROWS) expect(html).toContain(`id="${rowAnchor(row.key)}"`)
  expect(html.indexOf('id="row-registration"')).toBeLessThan(
    html.indexOf('id="row-password_login"')
  )
  expect(html).toContain('Anyone can create an account.')
  expect(html).not.toContain('Sign-on only')
})

test('an off switch says what off means', () => {
  const settings = { ...initial.settings, guests_enabled: false }
  expect(page(place('features'), true, { settings })).toContain(
    'Off: Guests can&#x27;t read anything. Their pages show sign-in.'
  )
  expect(
    page(place('features'), true, { settings: { ...settings, guests_enabled: true } })
  ).not.toContain('Off: Guests')
})

test('who can see profiles ends with what always shows', () => {
  const html = page(place('features'))
  const row = html.slice(html.indexOf('id="row-profile_visibility"'))
  const list = row.indexOf('role="radiogroup"')
  const note = row.indexOf('Names next to messages and in member lists always show')
  expect(list).toBeGreaterThan(0)
  expect(note).toBeGreaterThan(list)
  expect(note).toBeLessThan(row.indexOf('id="row-', 1))
})

// The buttons, chips and check boxes of a section that are under 44 px high on touch screens.
const small = (page: string) => {
  const html = page.slice(page.indexOf('class="max-w-2xl"'))
  return [
    ...(html.match(/<button[^>]*>/g) ?? []).filter(b => !/\bh-11\b|role="switch"/.test(b)),
    ...(html.match(/<label[^>]*>\s*<input[^>]*type="(checkbox|radio)"/g) ?? []).filter(
      l => !/\bh-11\b/.test(l)
    ),
  ]
}

test('the controls of every section are 44 px high on touch screens', () => {
  const part = {
    adminOverview: { user_count: 2, server_count: 1 },
  }
  for (const section of ADMIN_SECTIONS) expect(small(page(place(section), true, part))).toEqual([])
  expect(small(page(place('users', 'bob'), true, part))).toEqual([])
})

test('the rail button that opens the page has a name', () => {
  Object.assign(initial, { token: 'tok', me: me('root', { is_site_admin: true }) })
  const router = { push: () => {}, replace: () => {}, prefetch: () => {} }
  const html = renderToStaticMarkup(
    <AppRouterContext.Provider value={router as unknown as AppRouterInstance}>
      <ServerRail />
    </AppRouterContext.Provider>
  )
  const shield = html.match(/<button[^>]*title="Site administration"[^>]*>/)?.[0]
  expect(shield).toContain('aria-label="Site administration"')
})

test('the overview shows sign-up and the counts', () => {
  const html = page(place('overview'), true, {
    adminOverview: { user_count: 128, server_count: 1 },
    settings: { ...initial.settings, registration: 'closed' },
  })
  expect(html).toContain('Closed')
  expect(html).toContain('128 accounts')
  expect(html).toContain('1 server<')
})

test('names on the page are marked for streamer mode', () => {
  const users = renderToStaticMarkup(
    <AccountRows pages={pagesOf([user('bob', { display_name: 'Bobby' })])} />
  )
  expect(/class="streamer[^"]*"[^>]*>Bobby/.test(users)).toBe(true)
  const one = page(place('users', 'bob'), true, {})
  expect(/<h1 class="[^"]*streamer[^"]*">bob<\/h1>/.test(one)).toBe(true)
})

test('someone who is not the site admin gets nothing, and the page module is not asked for', () => {
  Object.assign(initial, {
    token: 'tok',
    me: me('alice', { is_site_admin: false }),
    adminPage: place('features'),
    activeDialog: { kind: 'ban_confirm', username: 'bob' },
  })
  expect(renderToStaticMarkup(<AdminHost />)).toBe('')
  expect(renderToStaticMarkup(<AdminRoot />)).not.toContain('Ban')
})

test('only the site admin has the palette command that opens the page', () => {
  const open = actionById('open_site_admin')
  expect(open?.scope).toBe('admin')
  const listed = () =>
    paletteCommands(paletteCtx(useStore.getState())).some(r => r.id === 'open_site_admin')
  for (const who of [
    { token: null, me: null, guest: false },
    { token: null, me: null, guest: true },
    { token: Secret.of('tok'), me: me('alice'), guest: false },
  ]) {
    useStore.setState(who)
    expect(listed()).toBe(false)
  }
  useStore.setState({
    token: Secret.of('tok'),
    me: me('root', { is_site_admin: true }),
    guest: false,
  })
  expect(listed()).toBe(true)
})
