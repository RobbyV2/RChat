import { expect, test } from 'bun:test'
import { hasStashedConfig, stashConfig, takeStashedConfig } from '../config_transfer'
import { openDeepLink, type LinkEnv } from '../deep_links'
import { stashInvite, takeStashedInvite } from '../invite'
import { createP2pInbox } from '../p2p/inbox_source'
import { startP2pIndex } from '../p2p/palette_source'
import { createP2pApp } from '../p2p/app/runtime'
import { testAccount } from './test_account'

test('invite and config handoffs distinguish accounts at the same origin', () => {
  const a = testAccount('alice')
  const b = testAccount('bob')
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => values.set(k, v),
        removeItem: (k: string) => values.delete(k),
      },
    },
  })
  try {
    for (const [owner, password] of [
      [a, 'first'],
      [b, 'second'],
    ] as const)
      stashInvite({ server: 'club', password }, owner.handoff)
    expect(takeStashedInvite('club', null, b.handoff)?.password).toBe('second')
    expect(takeStashedInvite('club', null, a.handoff)?.password).toBe('first')
    stashConfig({ v: 1, theme: 'dark' }, ['theme'], a.handoff)
    expect(hasStashedConfig(b.handoff)).toBe(false)
    expect(takeStashedConfig(a.handoff)?.doc.theme).toBe('dark')
    a.inviteUpdates.staleInvites('club')
    expect(b.inviteUpdates.inviteVersion('club')).toBe(0)
  } finally {
    if (old) Object.defineProperty(globalThis, 'window', old)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('a deep link drops a deferred switch or page load when its owner changes', async () => {
  const confirm = Promise.withResolvers<boolean>()
  const calls: string[] = []
  let current = true
  const env: LinkEnv = {
    homeOrigin: 'https://one.test',
    appLinks: false,
    current: () => current,
    known: () => false,
    confirmSwitch: () => confirm.promise,
    route: async (origin, path) => {
      calls.push(origin + path)
    },
    fail: msg => {
      calls.push(msg)
    },
  }
  const link = 'rchat://two.test/invite/club/'
  const first = openDeepLink(link, env)
  current = false
  confirm.resolve(true)
  await first
  expect(calls).toEqual([])
  current = true
  await openDeepLink(link, env)
  expect(calls).toEqual(['https://two.test/invite/club/'])
})

test('P2P inbox preferences and palette registration follow the supplied account', () => {
  const a = testAccount('alice')
  const b = testAccount('bob')
  let changed = 0
  const app = createP2pApp(b, 'main')
  const offInbox = createP2pInbox(b, app).subscribe!(() => changed++)
  const offIndex = startP2pIndex(b, { app })
  try {
    a.store.setState(s => ({ notifyPrefs: { ...s.notifyPrefs, desktop: true } }))
    expect(changed).toBe(0)
    b.store.setState(s => ({ notifyPrefs: { ...s.notifyPrefs, desktop: true } }))
    expect(changed).toBe(1)
    expect(a.indexer.indexSource('p2p')).toBeUndefined()
    expect(b.indexer.indexSource('p2p')).not.toBeUndefined()
  } finally {
    app.dispose()
    offInbox()
    offIndex()
  }
})
