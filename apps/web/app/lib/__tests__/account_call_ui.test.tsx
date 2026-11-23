import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AppShell from '../../[[...slug]]/app_shell'
import { CallBanner, VoiceDock } from '../../components/voice_grid'
import { ChannelSidebar } from '../../components/channel_sidebar'
import { client } from '../client/client'
import { getHomeSession } from '../store'
import { p2pHost as legacyHost } from '../p2p/app'
import { AccountProvider } from '../client/react'
import { me, member, memoryStorage, serverDetail, textChannel } from './fixtures'
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
  // The initial page identity backs the legacy call card during the W8 transition.
  const b = getHomeSession()
  const previous = client.shown
  const previousHost = { ...legacyHost }
  b.store.setState(s => ({ me: me('reader'), settings: { ...s.settings, p2p: true } }))
  Object.assign(b.store.getInitialState(), b.store.getState())
  b.identities.setAccount('reader')
  const { p2pHost, useP2p, ringing } = b.identities.get()!
  const quiet = useP2p.getState().callQuiet
  const initial = useP2p.getInitialState()
  const initialCall = { call: initial.call, callQuiet: initial.callQuiet }
  try {
    client.shown = () => a
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
    b.lifetime.endSession()
    notice.go()
    b.identities.setAccount(null)
    notice.go()
    expect(clicks).toBe(1)
  } finally {
    Object.assign(initial, initialCall)
    useP2p.setState({ callQuiet: quiet })
    client.shown = previous
    a.store.dispose()
    b.identities.setAccount(null)
    b.store.resetSessionCaches()
    Object.assign(legacyHost, previousHost, { account: previousHost.account })
  }
})

test('contact call and server voice audio and controls follow the claimed sibling identity', async () => {
  const account = testAccount('reader', 'https://sibling-call.test')
  const key = account.keys.local('rchat_p2p_identities')
  try {
    account.identities.setAccount('reader')
    const main = account.identities.get()!
    const work = account.identities.add('work')
    expect(main.useP2p).not.toBe(work.useP2p)
    const mutes: boolean[] = []
    work.callRtc.active = () => true
    work.callRtc.setMuted = muted => void mutes.push(muted)
    work.callRtc.remoteStreams = () => [['peer', {} as MediaStream]]
    for (const kind of ['p2p-call', 'p2p-voice'] as const) {
      const call =
        kind === 'p2p-call'
          ? ({
              id: 'call',
              room: 'room',
              peer: 'peer',
              dir: 'out',
              state: 'active',
              video: false,
              since: 1,
              startedAt: 1,
            } as const)
          : null
      const voice = kind === 'p2p-voice' ? { room: 'server', ch: 'voice' } : null
      work.useP2p.setState({ call, voice })
      Object.assign(work.useP2p.getInitialState(), { call, voice })
      const claim = await client.calls.request({ account, identity: work.localId, kind }, () => {})
      try {
        expect(claim?.current()).toBe(true)
        const html = renderToStaticMarkup(
          <>
            <CallBanner />
            <VoiceDock />
          </>
        )
        expect(html.match(/data-remote-audio/g)).toHaveLength(1)
        expect(html).toContain(
          kind === 'p2p-call' ? 'aria-label="Leave call"' : 'aria-label="Disconnect"'
        )
        expect(html).toContain('aria-label="Mute"')
        const shell = () =>
          renderToStaticMarkup(
            <AppRouterContext.Provider value={router}>
              <AppShell />
            </AppRouterContext.Provider>
          )
        const title = kind === 'p2p-voice' ? 'Voice channel' : 'Call'
        const heading = new RegExp('<h2[^>]*>' + title + '</h2>')
        expect(heading.test(shell())).toBe(false)
        if (!claim) throw new Error('Expected an active call')
        client.calls.expand(claim)
        const expanded = shell()
        expect(heading.test(expanded)).toBe(true)
        expect(expanded).toContain('stage relative flex')
        expect(expanded.match(/data-remote-audio/g)).toHaveLength(1)
        client.calls.collapse()
        expect(heading.test(shell())).toBe(false)
        expect(claim.current()).toBe(true)
        client.calls.expand(claim)
        expect(main.useP2p.getState().call).toBeNull()
        expect(main.useP2p.getState().voice).toBeNull()
        account.store.getState().toggleMute()
        expect(mutes.at(-1)).toBe(true)
        account.store.getState().toggleMute()
      } finally {
        claim?.release()
        expect(client.calls.expandedCall()).toBeNull()
      }
    }
  } finally {
    account.store.dispose()
    memoryStorage.removeItem(key)
  }
})
