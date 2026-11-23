import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AppShell from '../../[[...slug]]/app_shell'
import { CallBanner } from '../../components/voice_grid'
import { ChannelSidebar } from '../../components/channel_sidebar'
import { client } from '../client/client'
import { p2pHost, useP2p } from '../p2p/app'
import { ringing } from '../p2p/app/calls'
import { AccountProvider } from '../client/react'
import { member, serverDetail, textChannel } from './fixtures'
import { testAccount } from './test_account'

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: 'test',
}

test('the shell shows a background ring and relay consent during the foreground call, with one audio stream', async () => {
  const a = testAccount('reader', 'https://a.test')
  const b = testAccount('reader', 'https://b.test')
  const previous = client.shown
  try {
    client.shown = () => a
    b.store.setState({
      call: {
        dmId: 1,
        dmUsers: ['reader', 'peer'],
        state: 'ringing',
        from: 'peer',
        kind: 'rtc',
        video: false,
        since: null,
      },
      relayPrompt: 'relay.b.test',
    })
    const renderShell = () => {
      for (const session of [a, b])
        Object.assign(session.store.getInitialState(), session.store.getState())
      return renderToStaticMarkup(
        <AppRouterContext.Provider value={router}>
          <AppShell />
        </AppRouterContext.Provider>
      )
    }
    a.store.setState({ call: b.store.getState().call })
    expect(renderShell().match(/aria-label="Incoming call"/g)).toHaveLength(2)
    a.store.setState({ call: null, voice: { server: 'club', channelId: 5 } })
    a.rtc.active = () => true
    a.rtc.remoteStreams = () => [['peer', {} as MediaStream]]
    await client.calls.request({ account: a, kind: 'voice' }, () => {})
    const html = renderShell()
    expect(html.match(/aria-label="Incoming call"/g)).toHaveLength(1)
    expect(html.match(/data-remote-audio/g)).toHaveLength(1)
    expect(html).toContain('relay.b.test')
    expect(html).toContain(b.id)
  } finally {
    client.shown = previous
    a.store.dispose()
    b.store.dispose()
  }
})

test('the channel sidebar uses the provider’s identity and RTC for a colliding username', () => {
  const a = testAccount('reader', 'https://a.test')
  const b = testAccount('reader', 'https://b.test')
  const previous = client.shown
  try {
    client.shown = () => a
    for (const [account, name] of [
      [a, 'Shown peer'],
      [b, 'Owner peer'],
    ] as const) {
      account.store.setState({
        view: { kind: 'channel', server: 'club', channelId: 1 },
        voice: { server: 'club', channelId: 1 },
        voiceUsers: { 1: ['peer'] },
        memberInfo: { club: { peer: member('peer', { display_name: name }) } },
        servers: {
          club: serverDetail('club', { channels: [{ ...textChannel(1), kind: 'voice' }] }),
        },
      })
      Object.assign(account.store.getInitialState(), account.store.getState())
    }
    b.rtc.isSpeaking = username => username === 'peer'
    b.rtc.peer = () => ({
      muted: true,
      camOn: false,
      screenOn: true,
      stream: null,
      screen: null,
      shareId: 'share',
    })
    const html = renderToStaticMarkup(
      <AccountProvider session={b}>
        <ChannelSidebar />
      </AccountProvider>
    )
    expect(html).toContain('Owner peer')
    expect(html).not.toContain('Shown peer')
    expect(html).toContain('ring-offset-surface-container-low')
    expect(html).toContain('title="Sharing their screen"')
    expect(html).toContain('title="Muted"')
  } finally {
    client.shown = previous
    a.store.dispose()
    b.store.dispose()
  }
})

test('the shell uses the P2P owner for alerts, quiet calls and runtime preferences', () => {
  const a = testAccount('reader', 'https://a.test')
  const b = testAccount('reader', 'https://b.test')
  const previous = client.shown
  const previousOwner = p2pHost.account
  const quiet = useP2p.getState().callQuiet
  const initial = useP2p.getInitialState()
  const initialCall = { call: initial.call, callQuiet: initial.callQuiet }
  try {
    client.shown = () => a
    p2pHost.account = b
    const toasts: string[] = []
    b.store.setState(s => ({
      notifyPrefs: { ...s.notifyPrefs, p2p: { room: { level: 'nothing' } } },
      atBottom: { room: true },
      typingOn: false,
      settings: { ...s.settings, asset_uploads: false, p2p_attachments: false },
      showToast: text => void toasts.push(text),
    }))
    const call = {
      id: 'call',
      room: 'room',
      peer: 'peer',
      dir: 'in',
      state: 'ringing',
      video: false,
      startedAt: 0,
      since: null,
    } as const
    ringing(call)
    expect(useP2p.getState().callQuiet).toBe(true)
    Object.assign(initial, { call, callQuiet: useP2p.getState().callQuiet })
    expect(renderToStaticMarkup(<CallBanner />)).not.toContain('data-p2p-call-card')
    initial.callQuiet = false
    expect(renderToStaticMarkup(<CallBanner />)).toContain('data-p2p-call-card')
    b.store.getInitialState().voice = { server: 'club', channelId: 1 }
    expect(renderToStaticMarkup(<CallBanner />)).not.toContain('data-p2p-call-card')
    expect(p2pHost.typingOn()).toBe(false)
    expect(p2pHost.textOnly()).toBe(true)
    p2pHost.toast('owner toast')
    expect(toasts).toEqual(['owner toast'])
    expect(p2pHost.following('room')).toBe(false)
    client.shown = () => b
    expect(p2pHost.following('room')).toBe(true)
    client.shown = () => a

    let clicks = 0
    p2pHost.alert({
      key: 'p2p:room',
      actor: null,
      action: '',
      body: 'hello',
      server: null,
      channel: null,
      dm: true,
      message: true,
      name: 'Peer',
      generic: 'New message',
      go: () => clicks++,
    })
    expect(a.store.getState().notices).toHaveLength(0)
    const [notice] = b.store.getState().notices
    notice.go()
    expect(clicks).toBe(1)
    p2pHost.account = a
    notice.go()
    p2pHost.account = b
    b.lifetime.endSession()
    notice.go()
    expect(clicks).toBe(1)
  } finally {
    Object.assign(initial, initialCall)
    useP2p.setState({ callQuiet: quiet })
    p2pHost.account = previousOwner
    client.shown = previous
    a.store.dispose()
    b.store.dispose()
  }
})
