import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PeerFriendGroups, type FriendAccount } from '../../components/friends_accounts'
import { testAccount } from './test_account'
import type { Contact } from '../p2p/contacts'

test('mutual contacts, presence and account confirmations remain under their own identity', () => {
  const account = testAccount('alice', 'https://friends-peers.example')
  const settings = { ...account.store.getState().settings, p2p: true }
  Object.assign(account.store.getInitialState(), { settings })
  account.store.setState({ settings })
  account.identities.setAccount('alice')
  const one = account.identities.get()!,
    two = account.identities.add('work')
  const ik = 'a'.repeat(64)
  const contact: Contact = {
    ik,
    name: 'Dana',
    petname: null,
    profile: null,
    certs: [],
    revocations: [],
    state: 'mutual',
    ignored: false,
    intros: [],
    verified: false,
    verifiedAt: null,
    warning: null,
    notice: null,
    host: 'x',
    added: 0,
    lastSeen: null,
  }
  for (const [peer, online] of [
    [one, true],
    [two, false],
  ] as const) {
    const sub = online ? 'dana@alpha.example' : 'dana@beta.example'
    const data = {
      enabled: true,
      account: 'alice',
      contacts: [
        contact,
        { ...contact, ik: 'b'.repeat(64), name: 'Blocked', state: 'blocked' as const },
      ],
      presence: { [ik]: online ? ('online' as const) : ('offline' as const) },
      badges: {
        [ik]: {
          ik,
          todo: null,
          ok: {
            token: 'test',
            sub,
            iss: 'https://example.test',
            iat: 1,
            exp: Date.now() / 1000 + 600,
            checked: Date.now(),
          },
        },
      },
    }
    Object.assign(peer.useP2p.getInitialState(), data)
    peer.useP2p.setState(data)
  }
  const row: FriendAccount['row'] = {
    saved: true,
    origin: account.conn.origin,
    username: 'alice',
    local: null,
    display: 'alice',
    status: 'Online',
    badge: 0,
    unread: false,
    active: true,
    avatar: { kind: 'identicon', color: null },
    ik: null,
    background: true,
  }
  const entry: FriendAccount = {
    row,
    account,
    name: 'Example',
    peers: [
      { ...row, local: 'main', display: 'main' },
      { ...row, local: 'work', display: 'work' },
    ],
  }
  const all = renderToStaticMarkup(<PeerFriendGroups entry={entry} online={false} />)
  const online = renderToStaticMarkup(<PeerFriendGroups entry={entry} online />)
  expect(all.split('data-contact=').length - 1).toBe(2)
  expect(online.split('data-contact=').length - 1).toBe(1)
  expect(all).toContain('dana@alpha.example')
  expect(all).toContain('dana@beta.example')
  expect(online).not.toContain('dana@beta.example')
  expect(all).not.toContain('Blocked')
})
