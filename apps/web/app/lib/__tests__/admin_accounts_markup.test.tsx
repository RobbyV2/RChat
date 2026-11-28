import { afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PasswordReveal } from '../../components/admin/accounts'
import { useConfigStore } from '../../components/admin/config_state'
import AdminDialogs from '../../components/admin/dialogs'
import { OverviewSection } from '../../components/admin/overview'
import { AccountBody, AccountRows, UsersSection } from '../../components/admin/users'
import { pagesOf } from './helpers/loads'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { actionById, runAction } from '../actions/registry'
import { api } from './home_instance'
import { useStore } from '../store'
import type { ActiveDialog } from '../store_types'
import type { AdminConfig, AdminOverview } from '../types'
import { drain, me, user } from './fixtures'
import { Secret } from '../secret'

const realSignOut = api.adminSignOut
const initial = useStore.getInitialState()
const saved = { ...initial }
const configInitial = useConfigStore.getInitialState()

beforeAll(registerAppActions)

afterEach(() => {
  api.adminSignOut = realSignOut
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
  configInitial.config = null
})

const signIn = (part: Partial<typeof initial> = {}) =>
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: true }),
    adminOverview: { server_count: 2, user_count: 2, temporary_count: 1 },
    ...part,
  })

const dialog = (activeDialog: ActiveDialog, part: Partial<typeof initial> = {}) => {
  signIn({ activeDialog, ...part })
  return renderToStaticMarkup(<AdminDialogs />)
}

test('the users section offers to create an account and to filter by temporary passwords', () => {
  signIn()
  const html = renderToStaticMarkup(<UsersSection />)
  expect(html).toContain('Create account')
  expect(html).toContain('aria-label="Show accounts"')
  for (const label of ['All', 'Temporary password', 'Expired']) expect(html).toContain(`>${label}<`)
  const rows = renderToStaticMarkup(
    <AccountRows pages={pagesOf([user('root'), user('dana', { display_name: 'Dana R.' })])} />
  )
  expect(rows.match(/data-long-press/g)).toHaveLength(2)
  expect(rows).toContain('Dana R.')
})

test('the overview counts the temporary passwords nobody changed yet', () => {
  signIn()
  expect(renderToStaticMarkup(<OverviewSection />)).toContain('1 not changed yet')
  signIn({
    adminOverview: {
      server_count: 2,
      user_count: 2,
      temporary_count: 0,
      relay: { allocations: null, enabled: false, port: null, turn: false },
    },
  })
  expect(renderToStaticMarkup(<OverviewSection />)).toContain('None waiting')
  // An older server sends no count of temporary passwords.
  signIn({
    adminOverview: {
      server_count: 2,
      user_count: 2,
      relay: { allocations: null, enabled: false, port: null, turn: false },
    } as AdminOverview,
  })
  expect(renderToStaticMarkup(<OverviewSection />)).not.toContain('Temporary passwords')
})

test('the create dialog asks for a username and names the default servers', () => {
  configInitial.config = {
    controls: [
      {
        key: 'default_servers',
        env: 'DEFAULT_SERVERS',
        value: 'lobby,club',
        config: null,
        pinned: false,
        same: false,
      },
    ],
    limits: [],
  } as unknown as AdminConfig
  const html = dialog({ kind: 'admin_create_account' })
  expect(html).toContain('Create Account')
  expect(html).toContain('>Username<')
  expect(html).toContain('Display name')
  expect(html).toContain('Joins the default servers: <span class="streamer">lobby, club</span>.')
  expect(html).toContain('They must choose their own password at first sign-in.')
  expect(html).toContain('aria-label="Add a server"')
  expect(html).not.toContain('Password sign-in is off')
  const encouraged = dialog(
    { kind: 'admin_create_account' },
    { settings: { ...saved.settings, password_change: 'encouraged' } }
  )
  expect(encouraged).toContain('They are asked to choose their own password after signing in.')
  const off = dialog(
    { kind: 'admin_create_account' },
    { settings: { ...saved.settings, password_login: false } }
  )
  expect(off).toContain('Password sign-in is off, so a new account could not sign in.')
  expect(/<button type="submit"[^>]* disabled=""[^>]*>Create account<\/button>/.test(off)).toBe(
    true
  )
})

test('a temporary password is shown once, with when it stops working', () => {
  signIn()
  const html = renderToStaticMarkup(
    <PasswordReveal
      username="dana"
      issued={{ temp_password: 'k7mq-x3ta-9fzc-w2hd-pn4e', expires_at: null }}
      servers={[
        { server: 'club', ok: true, error: null },
        { server: 'nowhere', ok: false, error: 'Server not found or wrong password' },
      ]}
      onDone={() => {}}
    />
  )
  expect(html.match(/k7mq-x3ta-9fzc-w2hd-pn4e/g)).toHaveLength(1)
  expect(html).toContain('data-temp-password')
  expect(html).toContain('It is shown only now.')
  expect(html).toContain('It does not expire.')
  expect(html).toContain('Copy sign-in details')
  expect(html).toContain('aria-label="Copy the password"')
  expect(html).toContain(
    'Not added to <span class="streamer">nowhere</span>: Server not found or wrong password'
  )
  expect(html).not.toContain('Not added to <span class="streamer">club</span>')
})

test('the confirms say what happens to the account, and only the site admin gets them', () => {
  const reset = dialog({ kind: 'new_password_confirm', username: 'dana' })
  expect(reset).toContain('New Temporary Password')
  expect(reset).toContain('<span class="streamer">dana</span>')
  expect(reset).toContain('signed out everywhere')
  expect(reset).toContain('Their backup phrase stays.')
  const out = dialog({ kind: 'sign_out_confirm', username: 'dana' })
  expect(out).toContain('Sign Out Everywhere')
  expect(out).toContain('They keep their')
  const add = dialog({ kind: 'admin_add_to_server', username: 'dana' })
  expect(add).toContain('Add to Server')
  expect(/<button type="submit"[^>]* disabled=""[^>]*>Add<\/button>/.test(add)).toBe(true)
  for (const kind of ['new_password_confirm', 'sign_out_confirm', 'admin_add_to_server'] as const) {
    const html = dialog({ kind, username: 'dana' })
    expect(/admin/i.test(html)).toBe(false)
    expect(dialog({ kind, username: 'dana' }, { me: me('alice', { is_site_admin: false }) })).toBe(
      ''
    )
  }
  expect(
    dialog({ kind: 'admin_create_account' }, { me: me('alice', { is_site_admin: false }) })
  ).toBe('')
})

test('an account page offers the account tools, except a new password for your own', () => {
  signIn()
  const dana = renderToStaticMarkup(<AccountBody user={user('dana')} mine={false} facts={null} />)
  for (const label of ['New temporary password', 'Sign out everywhere', 'Add to server'])
    expect(dana).toContain(label)
  const own = renderToStaticMarkup(<AccountBody user={user('root')} mine facts={null} />)
  expect(own).not.toContain('New temporary password')
  expect(own).not.toContain('Sign out everywhere')
  expect(own).toContain('Add to server')
})

test('signing an account out says so', async () => {
  const asked: string[] = []
  api.adminSignOut = async (username: string) => {
    asked.push(username)
    return {}
  }
  useStore.setState({ token: Secret.of('tok'), me: me('root', { is_site_admin: true }) })
  await useStore.getState().adminSignOut('dana')
  expect(asked).toEqual(['dana'])
  expect(useStore.getState().toast?.text).toBe('Signed out everywhere')
})

test('only the site admin gets the account tools on a row of the accounts, never in the bare palette', async () => {
  const dana = user('dana')
  const onRow = (u = dana) =>
    ctxFor(useStore.getState(), { kind: 'member', user: u, server: null, where: 'admin' }, 'menu')
  const elsewhere = () =>
    ctxFor(useStore.getState(), { kind: 'member', user: dana, server: 's', where: 'list' }, 'menu')
  const ids = [
    'admin_open_account',
    'admin_new_password',
    'admin_sign_out',
    'admin_add_to_server',
    'admin_delete_account',
  ]
  const labels = (ctx = onRow()) => menuItems(ctx).map(i => i.label)
  for (const who of [
    { token: null, me: null, guest: false },
    { token: null, me: null, guest: true },
    { token: Secret.of('tok'), me: me('alice'), guest: false },
  ]) {
    useStore.setState(who)
    expect(labels()).toEqual([])
    for (const id of ids) {
      expect(actionById(id)?.available(onRow())).toBe(false)
      expect(await runAction(id, onRow())).toBe(false)
    }
  }
  expect(useStore.getState().activeDialog).toBe(null)
  useStore.setState({
    token: Secret.of('tok'),
    me: me('root', { is_site_admin: true }),
    guest: false,
  })
  expect(labels()).toEqual([
    'Open account',
    'New temporary password',
    'Sign out everywhere',
    'Add to server',
    'Remove backup phrase',
    'Ban site-wide',
    'Delete account',
  ])
  expect(labels(onRow(user('root')))).toEqual(['Open account', 'Add to server'])
  for (const id of ids) {
    const a = actionById(id)
    expect([a?.scope, a?.targets]).toEqual(['admin', ['member']])
    expect(a?.available(elsewhere())).toBe(false)
    expect(paletteCommands(paletteCtx(useStore.getState())).some(r => r.id === id)).toBe(false)
  }
  for (const title of ['Open account', 'New temporary password', 'Sign out everywhere'])
    expect(labels(elsewhere())).not.toContain(title)
  expect(await runAction('admin_new_password', onRow())).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({
    kind: 'new_password_confirm',
    username: 'dana',
  })
  expect(await runAction('admin_sign_out', onRow())).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({ kind: 'sign_out_confirm', username: 'dana' })
  expect(await runAction('admin_add_to_server', onRow())).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({
    kind: 'admin_add_to_server',
    username: 'dana',
  })
  expect(await runAction('admin_delete_account', onRow())).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({
    kind: 'delete_user_confirm',
    username: 'dana',
  })
  const opened: unknown[][] = []
  useStore.setState({ openAdmin: (...place) => void opened.push(place) })
  expect(await runAction('admin_open_account', onRow())).toBe(true)
  await drain()
  expect(opened).toEqual([['users', 'dana']])
})
