import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import AdminPanel from '../../components/admin_panel'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { registerAppActions } from '../actions/index'
import { actionById, runAction } from '../actions/registry'
import { api } from '../instances'
import { instanceAuditLine } from '../instance_audit'
import { resetSessionCaches, useStore } from '../store'
import type { InstanceAuditEntry } from '../types'
import { drain, me, msg, paged, user } from './fixtures'

const realRemove = api.adminRemovePhrase
const initial = useStore.getInitialState()
const saved = { ...initial }

beforeAll(registerAppActions)

afterEach(() => {
  api.adminRemovePhrase = realRemove
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

afterAll(resetSessionCaches)

const entry = (over: Partial<InstanceAuditEntry> = {}): InstanceAuditEntry => ({
  id: 1,
  at: 1_700_000_000,
  actor: 'root',
  action: 'user.remove_phrase',
  target: 'bob',
  detail: {},
  ...over,
})

const text = (e: InstanceAuditEntry) =>
  instanceAuditLine(e)
    .map(p => p.text)
    .join('')

test('audit lines name who did what to whom, and mark names', () => {
  expect(text(entry())).toBe('root removed the backup phrase of bob')
  expect(
    instanceAuditLine(entry())
      .filter(p => p.name)
      .map(p => p.text)
  ).toEqual(['root', 'bob'])
  expect(text(entry({ actor: null, target: null }))).toBe(
    'Deleted user removed the backup phrase of a deleted user'
  )
  expect(text(entry({ action: 'sso.config', target: null }))).toBe('root sso.config')
  expect(text(entry({ action: 'sso.config', target: 'okta' }))).toBe('root sso.config okta')
})

const render = (part: Partial<typeof initial>) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('root', { is_site_admin: true }),
    adminUsers: paged([user('root'), user('bob', { display_name: 'Bobby' })]),
    ...part,
  })
  return renderToStaticMarkup(<AdminPanel />)
}

test('the admin user rows offer to remove a backup phrase, except their own', () => {
  const html = render({ activeDialog: { kind: 'admin_panel' } })
  expect(html.match(/Remove backup phrase/g)?.length).toBe(1)
  expect(html).toContain('Audit log')
  const other = render({
    activeDialog: { kind: 'admin_panel' },
    me: me('alice', { is_site_admin: false }),
  })
  expect(other).toBe('')
})

test('the confirm dialog says it only removes a way back in', () => {
  const html = render({ activeDialog: { kind: 'remove_phrase_confirm', username: 'bob' } })
  expect(html).toContain('Remove Backup Phrase')
  expect(html).toContain('<span class="streamer">bob</span>')
  expect(html).toContain('only removes a way back in')
  expect(/admin/i.test(html)).toBe(false)
  const other = render({
    activeDialog: { kind: 'remove_phrase_confirm', username: 'bob' },
    me: me('alice', { is_site_admin: false }),
  })
  expect(other).toBe('')
})

test('removing a phrase says whether one was set', async () => {
  const asked: string[] = []
  let removed = true
  api.adminRemovePhrase = async (username: string) => {
    asked.push(username)
    return { removed }
  }
  useStore.setState({ token: 'tok', me: me('root', { is_site_admin: true }) })
  await useStore.getState().adminRemovePhrase('bob')
  expect(useStore.getState().toast?.text).toBe('Backup phrase removed')
  removed = false
  await useStore.getState().adminRemovePhrase('bob')
  expect(useStore.getState().toast?.text).toBe('No backup phrase was set')
  expect(asked).toEqual(['bob', 'bob'])
})

test('only the site admin gets Remove backup phrase on a person, never in the bare palette', async () => {
  const a = actionById('admin_remove_phrase')
  expect([a?.scope, a?.danger, a?.targets]).toEqual(['admin', true, ['member', 'message']])
  const bob = user('bob', { display_name: 'alice' })
  const onRow = () =>
    ctxFor(useStore.getState(), { kind: 'member', user: bob, server: 's', where: 'list' }, 'menu')
  const onMessage = () =>
    ctxFor(
      useStore.getState(),
      { kind: 'message', message: msg(3, { author: bob }), list: 'c1' },
      'menu'
    )
  const labels = () => menuItems(onRow()).map(i => i.label)
  for (const who of [
    { token: null, me: null, guest: false },
    { token: null, me: null, guest: true },
    { token: 'tok', me: me('alice'), guest: false },
  ]) {
    useStore.setState(who)
    expect(a?.available(onRow())).toBe(false)
    expect(labels()).not.toContain('Remove backup phrase')
  }
  expect(await runAction('admin_remove_phrase', onRow())).toBe(false)
  expect(useStore.getState().activeDialog).toBe(null)
  useStore.setState({ token: 'tok', me: me('root', { is_site_admin: true }), guest: false })
  expect(labels()).toContain('Remove backup phrase')
  expect(a?.available(onMessage())).toBe(true)
  expect(paletteCommands(paletteCtx(useStore.getState())).some(r => r.id === a?.id)).toBe(false)
  const self = ctxFor(
    useStore.getState(),
    { kind: 'member', user: user('root'), server: 's', where: 'list' },
    'menu'
  )
  expect(a?.available(self)).toBe(false)
  expect(await runAction('admin_remove_phrase', onRow())).toBe(true)
  await drain()
  expect(useStore.getState().activeDialog).toEqual({
    kind: 'remove_phrase_confirm',
    username: 'bob',
  })
})
