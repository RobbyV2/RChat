import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PeerTimeoutBadge, TimeoutDialog } from '../../components/timeout_dialog'
import type { TimeoutRequest } from '../store_types'
import { MemberCard } from '../../components/p2p/p2p_server_roles'
import { AccountProvider } from '../client/react'
import { P } from '../p2p/state'
import type { ServerView } from '../p2p/server'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'

const request = (over: Partial<TimeoutRequest> = {}): TimeoutRequest => ({
  name: 'Carol key',
  current: null,
  run: () => true,
  remove: () => {},
  ...over,
})

test('a request without an account shows its name, the presets and no running timeout', () => {
  const html = renderToStaticMarkup(<TimeoutDialog request={request()} onClose={() => {}} />)
  expect(html).toContain('Time out member')
  expect(html).toContain(
    '<p class="streamer truncate text-sm font-medium text-on-surface">Carol key</p>'
  )
  expect(html).toContain('10 minutes')
  expect(html).not.toContain('data-timeout-current')
  expect(html).not.toContain('Remove timeout')
})

test('a running timeout shows its time left and its whole reason, and can be removed', () => {
  const reason = 'Posting the same link over and over in every channel'
  const html = renderToStaticMarkup(
    <TimeoutDialog
      request={request({ current: { ends: Date.now() + 3_600_000, reason } })}
      onClose={() => {}}
    />
  )
  expect(html).toContain('Change timeout')
  expect(html).toContain('data-timeout-current')
  expect(html).toContain(`Reason: ${reason}`)
  expect(html).toContain('Remove timeout')
  expect(html).toContain('Update timeout')
  expect(html).toContain(`value="${reason}"`)
})

test('a timeout that ended shows as none', () => {
  const html = renderToStaticMarkup(
    <TimeoutDialog
      request={request({ current: { ends: Date.now() - 1, reason: 'old' } })}
      onClose={() => {}}
    />
  )
  expect(html).toContain('Time out member')
  expect(html).not.toContain('data-timeout-current')
})

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
