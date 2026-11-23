import { expect, test } from 'bun:test'
import type { ConfigDoc } from '../config_transfer'
import { client } from '../client/client'
import { identityScopeKey } from '../p2p/app/host'
import type { AlertInput } from '../notices'
import { me, memoryStorage } from './fixtures'
import { testAccount } from './test_account'

test('guest sign-in opens saved identity slots only after settings allow P2P', async () => {
  const account = testAccount('ada', 'https://registration.test')
  const key = account.keys.local('rchat_p2p_identities')
  const settings = account.store.getState().settings
  const fetch = globalThis.fetch
  memoryStorage.setItem(key, '["work","work","main",null,"bad/id"]')
  globalThis.fetch = (async () => Response.json([])) as typeof fetch
  try {
    account.conn.ws.start = () => {}
    account.api.send = async () => Response.json({ token: 'test', user: me('ada') })
    account.store.setState({ guest: true, me: null, settings: { ...settings, p2p: false } })
    account.identities.setAccount('ada')
    expect(account.identities.list()).toEqual([])
    expect(() => account.identities.add()).toThrow()
    await account.store.getState().login({ username: 'ada', password: 'test' })
    expect(account.identities.list()).toEqual([])
    account.store.setState({ settings: { ...settings, p2p: true } })
    const main = account.identities.get()!
    expect(main.useP2p.getState().account).toBe('ada')
    expect(account.identities.list().map(app => app.localId)).toEqual(['main', 'work'])
    expect(account.inbox.inboxAdapters().map(adapter => adapter.id)).toEqual([
      'instance',
      'p2p:main',
      'p2p:work',
    ])
    expect(account.indexer.indexSource('p2p:work')?.id).toBe('p2p:work')
    for (let i = 1; i <= 6; ++i) account.identities.add('slot-' + i)
    expect(account.identities.add('work')).toBe(account.identities.get('work')!)
    expect(() => account.identities.add('extra')).toThrow('eight')
    account.store.setState({ settings: { ...settings, p2p: false } })
    expect(main.useP2p.getState().account).toBeNull()
    expect(account.inbox.inboxAdapters().map(adapter => adapter.id)).toEqual(['instance'])
    expect(account.indexer.indexSource('p2p:work')).toBeUndefined()
    account.store.setState({ settings: { ...settings, p2p: true } })
    expect(account.identities.list()).toHaveLength(8)
    expect(account.identities.get()).not.toBe(main)
    account.store.getState().logout()
    expect(account.identities.list()).toEqual([])
    expect(account.indexer.indexSource('p2p:main')).toBeUndefined()
  } finally {
    account.store.dispose()
    memoryStorage.removeItem(key)
    globalThis.fetch = fetch
  }
})

test('sibling notices, clicks, RTC updates and controls target their originating app', async () => {
  const a = testAccount('sam', 'https://registration-a.test')
  const b = testAccount('sam', 'https://registration-b.test')
  const key = a.keys.local('rchat_p2p_identities')
  const shown = client.shown
  try {
    client.shown = () => b
    for (const acct of [a, b]) acct.identities.setAccount('sam')
    const main = a.identities.get()!
    const work = a.identities.add('work')
    const temporary = a.identities.add()
    const actions: string[] = []
    const alert = (id: string): AlertInput => ({
      key: 'p2p:room',
      actor: null,
      action: '',
      body: 'hello',
      server: null,
      channel: null,
      dm: true,
      message: true,
      name: 'Person',
      generic: 'New message',
      go: () => void actions.push(id),
    })
    main.p2pHost.alert(alert('main'))
    work.p2pHost.alert(alert('work'))
    const notices = a.store.getState().notices
    expect(notices.map(n => n.key)).toEqual(['p2p:room', identityScopeKey('work', 'p2p:room')])
    expect(b.store.getState().notices).toEqual([])
    a.store.setState({ atBottom: { 'p2p:room': true } })
    expect(main.p2pHost.following('p2p:room')).toBe(false)
    client.shown = () => a
    expect(main.p2pHost.following('p2p:room')).toBe(true)
    expect(work.p2pHost.following('p2p:room')).toBe(false)
    client.shown = () => b

    work.p2pVoice.videoChanged = () => void actions.push('video')
    const before = [a.store.getState().rtcTick, b.store.getState().rtcTick]
    work.callRtc.onChange()
    expect([a.store.getState().rtcTick, b.store.getState().rtcTick]).toEqual([
      before[0] + 1,
      before[1],
    ])
    const claim = await client.calls.request(
      { account: a, identity: 'work', kind: 'p2p-call' },
      () => {}
    )
    work.p2pCall.media = () => true
    work.p2pCall.camera = async () => void actions.push('camera')
    work.p2pCall.share = async () => void actions.push('share')
    expect(a.identities.unregister(temporary.localId)).toBe(true)
    expect(claim?.current()).toBe(true)
    await a.store.getState().toggleCamera()
    await a.store.getState().toggleShare()
    notices[0].go()
    notices[1].go()
    expect(actions).toEqual(['video', 'camera', 'share', 'main', 'work'])
    claim?.release()

    expect(a.identities.unregister('work')).toBe(true)
    notices[1].go()
    expect(actions).toHaveLength(5)
    expect(work.useP2p.getState().account).toBeNull()
    expect(a.indexer.indexSource('p2p:work')).toBeUndefined()
    expect(main.useP2p.getState().account).toBe('sam')
    expect(b.identities.get()?.useP2p.getState().account).toBe('sam')
  } finally {
    client.shown = shown
    a.store.dispose()
    b.store.dispose()
    memoryStorage.removeItem(key)
  }
})

test('deferred rail import keeps its selected identity and rejects a re-registered slot', async () => {
  const account = testAccount('bob')
  try {
    account.identities.setAccount('bob')
    const work = account.identities.add('work')
    const main = account.identities.get()!
    const doc: ConfigDoc = {
      v: 1,
      layout: { servers: [], dmOrder: [], dmPinned: [], selfPin: 'auto', p2p: ['imported'] },
    }
    const wait = Promise.withResolvers<void>()
    account.store.setState({ ensureServers: () => wait.promise, ensureDms: async () => {} })
    account.identities.show(work)
    const apply = account.store.getState().applyConfig(doc, ['layout'])
    account.identities.show(main)
    wait.resolve()
    expect(await apply).toBeNull()
    expect(work.useP2p.getState().layout.servers).toEqual(['imported'])
    expect(main.useP2p.getState().layout.servers).toEqual([])
    const next = Promise.withResolvers<void>()
    account.store.setState({ ensureServers: () => next.promise })
    const pending = account.store.getState().applyConfig(doc, ['layout'], work)
    account.identities.unregister('work')
    const replacement = account.identities.add('work')
    replacement.p2pRail.apply(['replacement'])
    next.resolve()
    expect(await pending).toContain('no longer available')
    expect(replacement.useP2p.getState().layout.servers).toEqual(['replacement'])
    expect(main.useP2p.getState().layout.servers).toEqual([])
  } finally {
    account.store.dispose()
  }
})
