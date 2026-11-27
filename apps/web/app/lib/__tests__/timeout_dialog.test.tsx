import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PeerTimeoutBadge } from '../../components/timeout_dialog'
import { MemberCard } from '../../components/p2p/p2p_server_roles'
import { AccountProvider } from '../client/react'
import { P } from '../p2p/state'
import type { ServerView } from '../p2p/server'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'

test('the badge of a P2P member shows only while the timeout runs', () => {
  const on = renderToStaticMarkup(
    <PeerTimeoutBadge m={{ timeoutUntil: Date.now() + 90_000, timeoutReason: 'spam' }} />
  )
  expect(on).toContain('Timed out, ')
  expect(on).toContain('Reason: spam')
  expect(renderToStaticMarkup(<PeerTimeoutBadge m={{ timeoutUntil: Date.now() - 1 }} />)).toBe('')
  expect(renderToStaticMarkup(<PeerTimeoutBadge m={{}} />)).toBe('')
})

test('the P2P member card shows the badge to those who may time members out, and to the member', () => {
  const account = testAccount('mod')
  try {
    const peer = createPeerFixture(account, 'mod')
    const card = (me: string, perms: number) => {
      const member = {
        ik: 'U',
        name: 'Una',
        m: 'join',
        owner: false,
        roles: [],
        top: null,
        timeoutUntil: Date.now() + 60_000,
      }
      const room = { id: 'room', me: 'join', perms, owners: [], roles: [], channels: [], chans: {} }
      const state = {
        me,
        servers: { room: { ...room, members: [member] } as unknown as ServerView },
      }
      peer.useP2p.setState(state)
      Object.assign(peer.useP2p.getInitialState(), state)
      return renderToStaticMarkup(
        <AccountProvider session={account}>
          <MemberCard room="room" ik="U" />
        </AccountProvider>
      )
    }
    expect(card('M', P.TimeoutMembers)).toContain('Timed out, ')
    expect(card('U', 0)).toContain('Timed out, ')
    expect(card('V', 0)).not.toContain('Timed out, ')
  } finally {
    account.store.dispose()
  }
})
