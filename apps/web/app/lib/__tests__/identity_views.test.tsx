import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CallBanner, VoiceDock } from '../../components/voice_grid'
import { client } from '../client/client'
import { AccountProvider } from '../client/react'
import { P2pProvider, useP2p, useP2pApp } from '../client/p2p_react'
import { ctxFor, refreshCtx } from '../actions/ctx'
import { memoryStorage } from './fixtures'
import { testAccount } from './test_account'

function Name() {
  const app = useP2pApp()
  const name = useP2p(s => s.name)
  return <span>{app ? app.localId + '/' + name : 'No identity'}</span>
}

test('selected views and deferred actions lose their identity when its slot closes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage })
  const owner = testAccount('sam', 'https://owner.test')
  const other = testAccount('sam', 'https://other.test')
  try {
    for (const account of [owner, other]) {
      const settings = { ...account.store.getState().settings, p2p: true }
      account.store.setState({ settings })
      Object.assign(account.store.getInitialState(), { settings })
      account.identities.setAccount('sam')
    }
    const main = owner.identities.get()!
    const sibling = owner.identities.add('work')
    Object.assign(main.useP2p.getInitialState(), { name: 'Main name' })
    Object.assign(sibling.useP2p.getInitialState(), { name: 'Work name' })
    const render = (account = owner, app = sibling) =>
      renderToStaticMarkup(
        <AccountProvider session={account}>
          <P2pProvider identity={app}>
            <Name />
          </P2pProvider>
        </AccountProvider>
      )
    expect(render()).toContain('work/Work name')
    expect(render(owner, main)).toContain('main/Main name')
    const call = {
      id: 'owned-call',
      room: 'room',
      peer: 'peer',
      dir: 'in',
      state: 'active',
      video: false,
      startedAt: 0,
      since: null,
    }
    Object.assign(sibling.useP2p.getInitialState(), { call })
    sibling.callRtc.active = () => true
    sibling.callRtc.remoteStreams = () => [['work-stream', {} as MediaStream]]
    await client.calls.request({ account: owner, identity: 'work', kind: 'p2p-call' }, () => {})
    expect(owner.identities.viewed()).toBe(main)
    const callUI = renderToStaticMarkup(
      <AccountProvider session={owner}>
        <CallBanner />
        <VoiceDock />
      </AccountProvider>
    )
    expect(callUI.match(/data-remote-audio/g)).toHaveLength(1)
    expect(callUI).toContain('Go to call')
    expect(render(other)).toContain('No identity')
    Object.assign(owner.store.getInitialState(), { guest: true })
    expect(render()).toContain('No identity')
    Object.assign(owner.store.getInitialState(), { guest: false, me: null })
    expect(render()).toContain('No identity')
    const ctx = ctxFor(owner.store.getState(), { kind: 'p2p_home' }, 'menu', owner, sibling)
    const delayed = sibling.inIdentity(() => 'live')
    expect(delayed()).toBe('live')
    expect(owner.identities.unregister('work')).toBe(true)
    expect(refreshCtx(ctx)).toBeNull()
    expect(delayed()).toBeUndefined()
    expect(other.identities.get()).not.toBeUndefined()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
