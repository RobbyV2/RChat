import { expect, test } from 'bun:test'
import { Ended } from '../slices/ctx'
import { testAccount } from './test_account'
import type { Invite } from '../types'
import { Secret } from '../secret'

const invite: Invite = {
  server: { name: 'club', display_name: 'Club', creator: null, has_password: false },
  member_count: 1,
  online_count: 0,
  status: 'member',
  preview_channel: null,
  preview: [],
  password_expires_at: null,
  password_uses_left: null,
}

test('invite previews use their own connection on a shared origin and follow a connected remote account', async () => {
  const alice = testAccount('alice', 'https://one.test')
  const bob = testAccount('bob', 'https://one.test')
  const remote = testAccount('charlie', 'https://two.test')
  let calls = 0
  remote.api.getInvite = async () => {
    calls++
    return invite
  }
  try {
    expect(await alice.invites.remoteConnection(alice.conn.origin)).toBe(alice.conn)
    expect(await bob.invites.remoteConnection(bob.conn.origin)).toBe(bob.conn)
    expect(await alice.invites.remoteConnection(remote.conn.origin)).toBe(remote.conn)
    expect(await alice.invites.remoteInvite(remote.conn.origin, 'club', null)).toBe(invite)
    expect(calls).toBe(1)
    alice.invites.requestPreview('same')
    expect(bob.invites.previewRequested('same')).toBe(false)
    alice.store.resetSessionCaches()
    expect(alice.invites.previewRequested('same')).toBe(false)
  } finally {
    alice.store.dispose()
    bob.store.dispose()
    remote.store.dispose()
  }
})

test('invite metadata cannot arrive after its destination account changes', async () => {
  const source = testAccount('alice', 'https://one.test')
  const target = testAccount('alice', 'https://two.test')
  const response = Promise.withResolvers<Invite>()
  target.api.getInvite = () => response.promise
  try {
    const pending = source.invites.remoteInvite(target.conn.origin, 'club', null)
    target.store.resetSessionCaches()
    response.resolve(invite)
    expect(
      await pending.then(
        () => false,
        err => err instanceof Ended
      )
    ).toBe(true)
  } finally {
    source.store.dispose()
    target.store.dispose()
  }
})

test('rendered text previews expire with their account and cannot collide on file id', () => {
  const alice = testAccount('alice')
  const bob = testAccount('bob')
  const key = 'media:1'
  try {
    alice.textPreviews.keep(key, { text: 'private', cut: false })
    expect(bob.textPreviews.get(key)).toBeUndefined()
    bob.textPreviews.keep(key, { text: 'other', cut: true })
    alice.store.resetSessionCaches()
    expect(alice.textPreviews.get(key)).toBeUndefined()
    expect(bob.textPreviews.get(key)?.text).toBe('other')
  } finally {
    alice.store.dispose()
    bob.store.dispose()
  }
})

test('an open invite drops visible metadata and a pending message body when its destination changes', async () => {
  const a = testAccount('alice', 'https://one.test')
  const b = testAccount('bob', 'https://two.test')
  const tracker = a.invites.watch(b.conn.origin)
  let seen = tracker.snapshot()
  const stop = tracker.subscribe(() => {
    seen = tracker.snapshot()
  })
  try {
    const first = seen
    const response = Promise.withResolvers<Invite>()
    b.api.getInvite = () => response.promise
    const body = first.read(b.conn, 'club', null, { revision: '7.0' })
    b.store.resetSessionCaches()
    expect(seen === first).toBe(false)
    expect(first.current()).toBe(false)
    expect(seen.current()).toBe(true)
    response.resolve(invite)
    expect(
      await body.then(
        () => false,
        error => error instanceof Ended
      )
    ).toBe(true)
    const second = seen
    b.store.setState({ token: Secret.of('another-token') })
    expect(seen === second).toBe(false)
    expect(second.current()).toBe(false)
    const third = seen
    b.store.dispose()
    expect(seen === third).toBe(false)
    expect(third.current()).toBe(false)
  } finally {
    stop()
    b.store.dispose()
    a.store.dispose()
  }
})
