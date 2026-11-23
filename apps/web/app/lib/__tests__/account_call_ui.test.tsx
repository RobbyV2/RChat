import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AppShell from '../../[[...slug]]/app_shell'
import { ChannelSidebar } from '../../components/channel_sidebar'
import { client } from '../client/client'
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
