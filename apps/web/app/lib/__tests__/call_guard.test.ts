import { shownPeer } from './shown_peer'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CallBanner, VoiceDock } from '../../components/voice_grid'
import { afterAll, expect, test } from 'bun:test'

import { client } from '../client/client'
import { resetSessionCaches } from '../store'
import type { CallSource } from '../client/calls'
import type { AccountSession } from '../client/session'
import { until, user, textChannel, serverDetail } from './fixtures'
import { testAccount } from './test_account'

afterAll(resetSessionCaches)

function accept(account: AccountSession) {
  const confirm = account.store.getState().confirm!
  account.store.getState().closeConfirm()
  confirm.action('')
}

test('a replacement leaves only the prior account and identity across all call kinds', async () => {
  const alice = testAccount('alice')
  const bob = testAccount('alice', 'https://another.test')
  const calls = client.calls
  const left: CallSource[] = []
  const sources: CallSource[] = [
    { account: alice, kind: 'voice' },
    { account: bob, kind: 'dm' },
    { account: alice, identity: 'personal', kind: 'p2p-call' },
    { account: alice, identity: 'work', kind: 'p2p-voice' },
  ]
  try {
    let previous = await calls.request(sources[0], () => left.push(sources[0]))
    for (const source of sources.slice(1)) {
      const pending = calls.request(source, () => left.push(source))
      expect(source.account.store.getState().confirm?.body).toBe(
        `This ends your call as ${previous!.account.id}.`
      )
      source.account.store.getState().closeConfirm()
      expect(await pending).toBeNull()
      expect(calls.current()).toBe(previous)
      const replacement = calls.request(source, () => left.push(source))
      accept(source.account)
      const next = await replacement
      expect(next?.account).toBe(source.account)
      expect(next?.identity).toBe(source.identity)
      previous?.release()
      expect(calls.current()).toBe(next)
      previous = next
    }
    expect(left).toEqual(sources.slice(0, 3))
    bob.store.dispose()
    expect(calls.current()).toBe(previous)
    previous?.release()
  } finally {
    alice.store.dispose()
    if (client.live().includes(bob)) bob.store.dispose()
  }
})

test('replacement and cancellation precede capture and signaling in the requesting account', async () => {
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  const events: string[] = []
  for (const account of [alice, bob]) {
    account.conn.ws.ensureConnected = () => {}
    account.conn.ws.sendVoice = msg => {
      events.push(account.id + ' ' + msg.type)
      return true
    }
    account.rtc.join = async () => {
      events.push(account.id + ' capture')
    }
    account.store.setState({
      openChannel: async (server, channelId) => {
        account.store.setState({ view: { kind: 'channel', server, channelId } })
      },
    })
  }
  try {
    await alice.store.getState().joinVoice('club', 3)
    events.length = 0
    const attempt = bob.store.getState().startCall(8, false)
    await until(() => bob.store.getState().confirm !== null)
    alice.store.getState().openProfile(user('someone'), null, 0, 0)
    await attempt
    expect(events).toEqual([])
    expect(client.calls.current()?.account).toBe(alice)
    const retry = bob.store.getState().startCall(8, false)
    await until(() => bob.store.getState().confirm !== null)
    accept(bob)
    await retry
    expect(events).toEqual([alice.id + ' voice_leave', bob.id + ' capture', bob.id + ' call_start'])
    alice.store.resetSessionCaches()
    expect(client.calls.current()?.account).toBe(bob)
    bob.store.getState().hangupCall()
    expect(client.calls.current()).toBeNull()
  } finally {
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('the dock shows the account and channel of the call while another account is shown', async () => {
  const owner = testAccount('alice')
  const shown = testAccount('bob')
  const previous = client.shown
  try {
    client.shown = () => shown
    const channel = { ...textChannel(1), name: 'Club voice', kind: 'voice' as const }
    const state = {
      voice: { server: 'club', channelId: 1 },
      servers: { club: serverDetail('club', { channels: [channel] }) },
    }
    Object.assign(owner.store.getInitialState(), state)
    owner.store.setState(state)
    owner.rtc.active = () => true
    const call = await client.calls.request({ account: owner, kind: 'voice' }, () => {})
    const html = renderToStaticMarkup(createElement(VoiceDock))
    expect(html).toContain('Club voice')
    expect(html).toContain(owner.id)
    expect(html).not.toContain(shown.id)
    call?.release()
  } finally {
    client.shown = previous
    owner.store.dispose()
    shown.store.dispose()
  }
})

test('remote audio follows the contact call through an instance ring until the switch', async () => {
  const account = client.shown()
  const initial = account.store.getInitialState()
  const savedCall = initial.call
  const contacts = shownPeer().useP2p.getInitialState()
  const savedContact = contacts.call
  const rtcActive = account.rtc.active
  const streams = account.rtc.remoteStreams
  const contactActive = shownPeer().callRtc.active
  const contactStreams = shownPeer().callRtc.remoteStreams
  const audioCount = () =>
    renderToStaticMarkup(createElement(CallBanner)).split('data-remote-audio').length - 1
  let claim = await client.calls.request({ account, kind: 'p2p-call' }, () => {})
  try {
    const stream = {} as MediaStream
    contacts.call = {
      id: 'contact',
      room: 'room',
      peer: 'bob',
      dir: 'out',
      state: 'active',
      video: false,
      since: 1,
      startedAt: 1,
    }
    shownPeer().callRtc.active = () => true
    shownPeer().callRtc.remoteStreams = () => [['bob', stream]]
    account.rtc.active = () => false
    initial.call = null
    expect(audioCount()).toBe(1)
    initial.call = {
      dmId: 8,
      dmUsers: ['sam', 'alice'],
      kind: 'rtc',
      from: 'alice',
      video: false,
      state: 'ringing',
      since: null,
    }
    const switching = client.calls.request({ account, kind: 'dm' }, () => {})
    expect(audioCount()).toBe(1)
    accept(account)
    claim = await switching
    expect(audioCount()).toBe(0)
    account.rtc.active = () => true
    account.rtc.remoteStreams = () => [
      ['alice', stream],
      ['alice:screen', stream],
    ]
    initial.call = { ...initial.call, state: 'active' }
    expect(audioCount()).toBe(2)
    claim?.release()
    expect(audioCount()).toBe(0)
  } finally {
    claim?.release()
    contacts.call = savedContact
    initial.call = savedCall
    shownPeer().callRtc.active = contactActive
    shownPeer().callRtc.remoteStreams = contactStreams
    account.rtc.active = rtcActive
    account.rtc.remoteStreams = streams
  }
})
