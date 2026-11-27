import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Banners } from '../../components/banners'
import { client } from '../client/client'
import { NOTICES_MAX } from '../notices'
import { msg, user } from './fixtures'
import { testAccount } from './test_account'

const account = testAccount

test('each kind of overlay claims its owner, and disposed stores stop claiming', () => {
  const a = account('a')
  const b = account('b')
  const alice = a.store.getState()
  const bob = b.store.getState()
  const open = [
    () => alice.openContextMenu(1, 2, []),
    () => alice.openProfile(user('c'), null, 1, 2),
    () => alice.openReactPicker(msg(1), null),
    () => alice.askConfirm({ title: 'Proceed?', confirm: 'OK', body: '', action() {} }),
    () => alice.openDialog({ kind: 'settings' }),
  ]
  for (const show of open) {
    bob.openDialog({ kind: 'settings' })
    show()
    expect(b.store.getState().activeDialog).toBeNull()
  }
  bob.openProfile(user('b'), null, 3, 4)
  expect(a.store.getState()).toMatchObject({
    contextMenu: null,
    profile: null,
    reactPicker: null,
    confirm: null,
    activeDialog: null,
  })
  a.store.dispose()
  alice.openDialog({ kind: 'settings' })
  expect(b.store.getState().profile?.user.username).toBe('b')
  expect(client.live()).not.toContain(a)
})

test('notices from different accounts share one region and retain independent limits and handlers', () => {
  const a = account('alice')
  const b = account('bob')
  const visits: string[] = []
  for (const session of [a, b]) {
    const state = session.store.getState()
    state.showToast(session.id)
    for (let i = 0; i <= NOTICES_MAX; i++) {
      state.alertFrom({
        key: String(i),
        actor: null,
        action: '',
        body: session.id + '/' + i,
        name: 'Someone',
        server: null,
        channel: null,
        dm: false,
        message: true,
        generic: 'Message',
        go: () => visits.push(session.id),
      })
    }
    // React's server snapshot is the initial state.
    Object.assign(session.store.getInitialState(), session.store.getState())
  }
  for (const streamer of [false, true]) {
    for (const session of [a, b]) Object.assign(session.store.getInitialState(), { streamer })
    const html = renderToStaticMarkup(<Banners />)
    expect(html.match(/aria-label="Notifications"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Dismiss"/g)).toHaveLength(2 * NOTICES_MAX)
    const text = html.replace(/<[^>]*>/g, '')
    for (const session of [a, b]) {
      expect(text.includes(session.id + '/1')).toBe(!streamer)
      expect(text).not.toContain(session.id + '/0')
    }
  }
  const notice = b.store.getState().notices[0]!
  b.store.getState().dismissNotice(notice.id)
  notice.go()
  expect(visits).toEqual([b.id])
  expect(a.store.getState().notices).toHaveLength(NOTICES_MAX)
  expect(b.store.getState().notices).toHaveLength(NOTICES_MAX - 1)
})

test('device appearance mirrors to existing and new sessions and detaches on disposal', () => {
  const a = account('a')
  const { theme, streamer } = client.device
  try {
    const otherTheme = theme === 'dark' ? 'light' : 'dark'
    a.store.getState().setTheme(otherTheme)
    a.store.getState().setStreamer(!streamer)
    const b = account('b')
    expect(client.device).toMatchObject({ theme: otherTheme, streamer: !streamer })
    expect(b.store.getState()).toMatchObject({ theme: otherTheme, streamer: !streamer })
    b.store.getState().setTheme(theme)
    expect(a.store.getState().theme).toBe(theme)
    b.store.dispose()
    a.store.getState().setStreamer(streamer)
    expect(b.store.getState().streamer).toBe(!streamer)
  } finally {
    client.device.setTheme(theme)
    client.device.setStreamer(streamer)
  }
})
