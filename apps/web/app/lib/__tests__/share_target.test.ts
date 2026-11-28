import { expect, test } from 'bun:test'
import { keyId, newKeyPair } from '../p2p/keys'
import { createPeerFixture } from './peer_fixture'
import { blank } from '../p2p/contacts'
import { attachShare, shareRooms } from '../client/share_target'
import { client } from '../client/client'
import { testAccount } from './test_account'
import { dmWith, me, serverDetail, textChannel, user } from './fixtures'

function fixture(host: string) {
  const account = testAccount('alice', host)
  const owner = { account, identity: null }
  account.store.setState(s => ({
    streamer: false,
    me: me('alice', {
      servers: [
        {
          name: 'garden',
          display_name: 'Garden',
          creator: null,
          is_admin: false,
          banner_color: null,
          icon_image: null,
          icon_kind: 'identicon' as const,
          name_color: null,
          profiles_mode: 'all' as const,
          timed_out_remaining: null,
          timed_out_until: null,
        },
      ],
    }),
    settings: { ...s.settings, asset_uploads: true },
    dms: [dmWith(7, user('bob'))],
    servers: {
      garden: serverDetail('garden', {
        channels: [{ ...textChannel(3), text_only: true }, textChannel(4), textChannel(5)],
        read_only: [5],
      }),
    },
    openDm: async id => {
      account.store.setState({ view: { kind: 'dm', dmId: id } })
    },
  }))
  return owner
}
test('a selected owner gets the draft even when its DM ID collides; text-only and no-send channels reject attachments', async () => {
  const a = fixture('https://alpha.test'),
    b = fixture('https://beta.test')
  const file = new File(['disposable'], 'share-test.txt')
  const rooms = shareRooms(b, [file])
  expect(rooms.some(r => r.kind === 'channel' && r.id === 5)).toBe(false)
  const text = rooms.find(r => r.kind === 'channel' && r.id === 3)!
  expect(text.reason).toContain('text only')
  expect(shareRooms(b, []).find(r => r.key === text.key)?.reason).toBe(null)
  expect(await attachShare(b, text.key, { text: '', files: [file] }, () => true)).toBe(false)
  const dm = rooms.find(r => r.kind === 'dm')!
  expect(await attachShare(b, dm.key, { text: 'draft', files: [file] }, () => true)).toBe(true)
  expect(b.account.store.getState().drafts.d7).toBe('draft')
  expect(b.account.store.getState().pending.d7?.file).toBe(file)
  expect(a.account.store.getState().pending.d7).toBeUndefined()
  expect(a.account.store.getState().drafts.d7).toBeUndefined()
})
test('dismissing or losing the account during open leaves its draft untouched', async () => {
  const a = fixture('https://share-alpha.test'),
    b = fixture('https://share-beta.test')
  const key = shareRooms(b, []).find(r => r.kind === 'dm')!.key
  for (const dismissed of [true, false]) {
    let valid = true
    const open = Promise.withResolvers<void>()
    b.account.store.setState({
      openDm: async id => {
        await open.promise
        b.account.store.setState({ view: { kind: 'dm', dmId: id } })
      },
    })
    const pending = attachShare(b, key, { text: 'private text', files: [] }, () => valid)
    if (dismissed) valid = false
    else client.show(a.account, 'none')
    open.resolve()
    expect(await pending).toBe(false)
    expect(b.account.store.getState().drafts.d7).toBeUndefined()
  }
})

test('contacts with matching peer keys are scoped to the selected registered identity', () => {
  const { account } = fixture('https://share-peers.test')
  const main = createPeerFixture(account, 'alice'),
    sibling = account.identities.add('work')
  const ik = keyId(newKeyPair().pk),
    self = keyId(newKeyPair().pk)
  for (const identity of [main, sibling]) {
    identity.useP2p.setState({
      enabled: true,
      me: self,
      contacts: [{ ...blank(ik, 0), name: identity.localId, state: 'mutual' }],
    })
  }
  expect(shareRooms({ account, identity: main }, [], false).map(r => String(r.label))).toEqual([
    'main',
  ])
  expect(shareRooms({ account, identity: sibling }, [], false).map(r => String(r.label))).toEqual([
    'work',
  ])
  sibling.useP2p.setState({ reader: true })
  expect(shareRooms({ account, identity: sibling }, [], false)).toEqual([])
})

test('streamer labels are scoped to each destination owner even when room IDs match', () => {
  const visible = fixture('https://share-visible.test')
  const hidden = fixture('https://share-hidden.test')
  hidden.account.store.setState({ streamer: true })
  expect(shareRooms(hidden, [], false).map(room => String(room.label))).toEqual([
    'Direct message 1',
    'Channel 1',
    'Channel 2',
  ])
  expect(shareRooms(visible, [], true).map(room => String(room.label))).toEqual([
    'Direct message 1',
    'Channel 1',
    'Channel 2',
  ])
  expect(shareRooms(visible, [], false).map(room => String(room.label))).toEqual([
    'bob',
    'Garden / #c3',
    'Garden / #c4',
  ])
})
