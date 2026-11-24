import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { client } from '../client/client'
import { addAccount, addInstance, editIdentity, removeInstance } from '../client/book'
import {
  claimImportedKey,
  creationChoices,
  confirmIdentityRemoval,
  identityOwner,
  identityRecords,
  reserveIdentity,
} from '../client/identity_enrollment'
import { accountStorage } from '../client/keys'
import { memoryStorage } from './fixtures'
import { CHANGED, exportP2p, kdfBounds } from '../p2p/transfer'
import { addNotice, desktopText } from '../notices'
import { keyId } from '../p2p/keys'
import { LOCAL } from '../p2p/limits'
import { removeP2pDb, P2pStore } from '../p2p/db'
import { Hub, makeNode } from './p2p_net'
import { testAccount } from './test_account'
import { createPeerFixture } from './peer_fixture'
import { IdentityEnrollment } from '../../components/p2p/identity_enrollment'

test('trust precedes any name, file or key and reservations stay with the signed-in owner', async () => {
  const origin = 'https://identity-enrollment.test'
  const owner = testAccount('alice', origin)
  const sibling = testAccount('bob', origin)
  const main = createPeerFixture(owner, 'alice')
  createPeerFixture(sibling, 'bob')
  const records = () => identityRecords(client.book.getState(), origin, 'alice')!
  try {
    await client.updateBook(book => {
      let b = addInstance(book, { id: 'identity-enrollment', origin, name: 'Instance' })
      for (const username of ['alice', 'bob'])
        b = addAccount(
          b,
          origin,
          { username, display: null, avatar: null, identities: [], added: 1, connect: true },
          null
        )
      return b
    })
    const html = renderToStaticMarkup(<IdentityEnrollment account={owner} cancel={() => {}} />)
    expect(html).toContain('Keep your P2P identity in an app you trust')
    expect(html).toContain('I trust this app')
    expect(html).not.toContain('Identity name')
    expect(html).not.toContain('.rchat')
    const first = await reserveIdentity(owner, 'Main')
    expect(first.app).toBe(main)
    const second = await reserveIdentity(owner, '  Work  ')
    expect(records().map(i => i.name)).toEqual(['Main', 'Work'])
    expect(identityRecords(client.book.getState(), origin, 'bob')).toEqual([])
    second.app.useP2p.setState({ ik: 'work-key', name: 'Work' })
    expect(records()[1]?.ik).toBe('work-key')
    let routed = false
    owner.store.setState({
      alertFrom: alert => {
        const [notice] = addNotice([], alert, 1, 0, false)
        expect(desktopText(notice!, false).title).toContain(
          'Work · P2P · alice@identity-enrollment.test'
        )
        expect(desktopText(notice!, true)).toEqual({ title: 'New activity', body: '' })
        alert.go()
      },
    })
    second.app.p2pHost.alert({
      key: 'work-dm',
      actor: null,
      action: '',
      body: 'test message',
      server: null,
      channel: null,
      dm: true,
      message: true,
      name: 'Bob',
      generic: 'New activity',
      go: () => {
        routed = true
      },
    })
    expect(routed).toBe(true)
    expect(owner.identities.viewed()).toBe(second.app)
    const original = { expected: 'work-key', readDestination: async () => 'work-key' }
    const empty = { expected: null, readDestination: async () => null }
    const claim = await claimImportedKey(owner, second.app.localId, 'imported-key', original)
    expect(
      await claimImportedKey(owner, first.app.localId, 'imported-key', empty).then(
        () => false,
        () => true
      )
    ).toBe(true)
    expect(
      await claimImportedKey(owner, first.app.localId, 'work-key', empty).then(
        () => 'ok',
        e => e.message
      )
    ).toContain('attach')
    await claim.rollback()
    expect(records()[1]?.ik).toBe('work-key')
    const token = accountStorage(owner.conn).token('alice')
    confirmIdentityRemoval(owner, owner, second.app.localId)
    memoryStorage.setItem(token, 'replacement-test-credential')
    await owner.store.getState().confirm!.action('Remove')
    memoryStorage.removeItem(token)
    expect(owner.identities.get(second.app.localId)).toBe(second.app)
    confirmIdentityRemoval(owner, owner, second.app.localId)
    await owner.store.getState().confirm!.action('Remove')
    expect(records().map(i => i.name)).toEqual(['Main'])
    expect(owner.identities.get(second.app.localId)).toBeUndefined()
    expect(owner.identities.get()).toBe(first.app)
    const before = identityOwner(owner)
    owner.store.setState({ me: null, guest: true })
    expect(before.current()).toBe(false)
    expect(() => identityOwner(owner)).toThrow()
  } finally {
    await client.updateBook(b => removeInstance(b, origin))
    owner.store.dispose()
    sibling.store.dispose()
  }
})

test('the account phrase can protect at most its own identity', () => {
  const supported = ['account', 'identity', 'none'] as const
  expect(creationChoices(supported, null, null)).toEqual([...supported])
  expect(creationChoices(supported, 'main', 'main')).toEqual([...supported])
  expect(creationChoices(supported, 'main', null)).toEqual(['identity', 'none'])
  expect(creationChoices(supported, 'main', 'work')).toEqual(['identity', 'none'])
})

test('an encrypted identity import attaches its existing key to the selected sibling slot', async () => {
  const account = testAccount('importer', 'https://identity-import.test')
  const main = createPeerFixture(account, 'importer')
  const origin = account.conn.origin
  const source = await makeNode(new Hub(), 'Original name')
  let db: string | null = null
  try {
    await client.updateBook(book =>
      addAccount(
        addInstance(book, { origin, id: 'identity-import', name: 'Instance' }),
        origin,
        {
          username: 'importer',
          display: null,
          avatar: null,
          connect: true,
          added: 1,
          identities: [
            { local: 'main', ik: 'main-test-key', name: 'Main', background: true, added: 1 },
          ],
        },
        null
      )
    )
    const slot = await reserveIdentity(account, 'Imported work')
    const limits = kdfBounds(LOCAL.transfer).min
    const pass = 'test encrypted export'
    const section = await exportP2p(source.store.db, pass, {
      alg: 'argon2id',
      m: limits.m,
      t: limits.t,
      p: 1,
    })
    const unlocked = await slot.app.p2pTransfer.unlock(section, pass)
    expect(unlocked.kind).toBe('new')
    expect(unlocked.destinationKey).toBeNull()
    db = slot.app.dbFor('importer')
    const result = await slot.app.p2pTransfer.apply(unlocked)
    expect(result.ok).toBe(true)
    const stored = await P2pStore.open(db)
    try {
      expect((await stored.self())!.ik.pk).toEqual((await source.store.self())!.ik.pk)
    } finally {
      stored.close()
    }
    expect(identityRecords(client.book.getState(), origin, 'importer')?.map(i => i.ik)).toEqual([
      'main-test-key',
      source.node.ik,
    ])
    expect(main.p2p.hasData('importer')).toBe(false)
    await slot.app.p2p.removeData('importer')
  } finally {
    account.store.dispose()
    source.node.stop()
    source.store.close()
    await removeP2pDb(source.db)
    if (db) await removeP2pDb(db)
    await client.updateBook(book => removeInstance(book, origin))
  }
}, 60000)

test('repeated detached cancellations prune only the original empty manifest reservation', async () => {
  const origin = 'https://enrollment-cancel.test'
  const account = testAccount('alice', origin)
  createPeerFixture(account, 'alice')
  const manifest = account.keys.local('rchat_p2p_identities')
  const records = () => identityRecords(client.readStoredBook(), origin, 'alice')!
  try {
    await client.updateBook(book =>
      addAccount(
        addInstance(book, { origin, id: origin, name: 'Instance' }),
        origin,
        { username: 'alice', display: null, avatar: null, added: 1, connect: true, identities: [] },
        null
      )
    )
    await reserveIdentity(account, 'Main')
    for (let i = 0; i < 9; ++i) {
      const slot = await reserveIdentity(account, 'Cancel')
      expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([slot.app.localId])
      account.identities.setAccount(null)
      await Promise.all([slot.cancel(), slot.cancel()])
      expect(records().map(i => i.local)).toEqual(['main'])
      expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([])
      account.identities.setAccount('alice')
    }
    const reopened = await reserveIdentity(account, 'Reopened')
    account.identities.setAccount(null)
    account.identities.setAccount('alice')
    await reopened.cancel()
    expect(records().map(i => i.local)).toEqual(['main'])
    expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([])
    const add = account.identities.add.bind(account.identities)
    account.identities.add = id => {
      add(id)
      account.identities.setAccount(null)
      throw Error('attachment failed')
    }
    try {
      expect(
        await reserveIdentity(account, 'Failed').then(
          () => 'ok',
          e => e.message
        )
      ).toBe('attachment failed')
      expect(records().map(i => i.local)).toEqual(['main'])
      expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([])
    } finally {
      account.identities.add = add
    }
    account.identities.setAccount('alice')
    const detached = await reserveIdentity(account, 'Alice temporary')
    const shared = detached.app.localId
    createPeerFixture(account, 'bob')
    const bobManifest = account.keys.local('rchat_p2p_identities')
    const bobSlot = account.identities.add(shared)
    await detached.cancel()
    expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([])
    expect(JSON.parse(memoryStorage.getItem(bobManifest)!)).toEqual([shared])
    expect(account.identities.get(shared)).toBe(bobSlot)
    memoryStorage.removeItem(bobManifest)
    createPeerFixture(account, 'alice')
    const stale = await reserveIdentity(account, 'Original')
    const local = stale.app.localId
    account.identities.setAccount(null)
    // A newer enrollment can have the same local ID, timestamp and an unset enable flag.
    await client.updateBook(book =>
      editIdentity(book, origin, 'alice', local, record => ({
        ...record,
        enrollment: crypto.randomUUID(),
        name: 'Replacement',
      }))
    )
    await stale.cancel()
    expect(records()[1]?.name).toBe('Replacement')
    expect(JSON.parse(memoryStorage.getItem(manifest)!)).toEqual([local])
    account.identities.setAccount('alice')
    expect(account.identities.get(local)?.localId).toBe(local)
  } finally {
    account.store.dispose()
    memoryStorage.removeItem(manifest)
    await client.updateBook(book => removeInstance(book, origin))
  }
})

test('overlapping encrypted applies protect both keys and recheck the preview inside the write', async () => {
  const origin = 'https://overlapping-import.test'
  const username = 'alice'
  const account = testAccount(username, origin)
  createPeerFixture(account, username)
  const [original, proposed, replacement] = await Promise.all([
    makeNode(new Hub(), 'original'),
    makeNode(new Hub(), 'proposed'),
    makeNode(new Hub(), 'replacement'),
  ])
  const stores: P2pStore[] = []
  const update = client.updateStoredBook
  const held = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const manifest = account.keys.local('rchat_p2p_identities')
  try {
    await update(book =>
      addAccount(
        addInstance(book, { origin, id: origin, name: 'Instance' }),
        origin,
        { username, display: null, avatar: null, added: 1, connect: true, identities: [] },
        null
      )
    )
    const a = await reserveIdentity(account, 'A')
    const b = await reserveIdentity(account, 'B')
    for (const slot of [a, b]) stores.push(await P2pStore.open(slot.app.dbFor(username)))
    const [first, second] = stores
    const pass = 'encrypted overlap fixture'
    const limits = kdfBounds(LOCAL.transfer).min
    const exportNode = (n: typeof original) =>
      exportP2p(n.store.db, pass, { alg: 'argon2id', m: limits.m, t: limits.t, p: 1 })
    const [oldFile, newFile] = await Promise.all([exportNode(original), exportNode(proposed)])
    const empty = await a.app.p2pTransfer.unlock(newFile!, pass)
    expect(empty.destinationKey).toBeNull()
    await first!.putSelf((await original.store.self())!)
    expect(await a.app.p2pTransfer.apply(empty)).toEqual({ ok: false, error: CHANGED })
    const replace = await a.app.p2pTransfer.unlock(newFile!, pass)
    const merge = await a.app.p2pTransfer.unlock(oldFile!, pass)
    expect(replace.destinationKey).toBe(original.node.ik)
    const [siblingOld, siblingNew] = await Promise.all([
      b.app.p2pTransfer.unlock(oldFile!, pass),
      b.app.p2pTransfer.unlock(newFile!, pass),
    ])
    client.updateStoredBook = (...args) => {
      const result = update(...args)
      if (identityRecords(client.readStoredBook(), origin, username)?.[0]?.pendingImport) {
        client.updateStoredBook = update
        held.resolve()
        return resume.promise.then(() => result)
      }
      return result
    }
    const writing = a.app.p2pTransfer.apply(replace)
    await held.promise
    try {
      for (const sibling of [siblingOld, siblingNew]) {
        const busy = await b.app.p2pTransfer.apply(sibling)
        expect(busy.ok ? '' : busy.error).toContain('another saved identity')
      }
      expect(await second!.self()).toBeUndefined()
      await first!.putSelf((await replacement.store.self())!)
    } finally {
      resume.resolve()
    }
    expect(await writing).toEqual({ ok: false, error: CHANGED })
    expect(await a.app.p2pTransfer.apply(merge)).toEqual({ ok: false, error: CHANGED })
    expect((await first!.self())!.ik.pk).toEqual((await replacement.store.self())!.ik.pk)
    expect(identityRecords(client.readStoredBook(), origin, username)?.[0]?.ik).toBe(
      replacement.node.ik
    )
    const oldDestination = {
      expected: replacement.node.ik,
      readDestination: async () => keyId((await first!.self())!.ik.pk),
    }
    const interrupted = await claimImportedKey(
      account,
      a.app.localId,
      proposed.node.ik,
      oldDestination
    )
    // Simulate a writer disappearing just after its IDB commit.
    await first!.putSelf((await proposed.store.self())!)
    const recovered = await claimImportedKey(account, a.app.localId, original.node.ik, {
      ...oldDestination,
      expected: proposed.node.ik,
    })
    expect(() => interrupted.check()).toThrow(CHANGED)
    await interrupted.rollback()
    recovered.check()
    await recovered.rollback()
    expect(identityRecords(client.readStoredBook(), origin, username)?.[0]?.ik).toBe(
      proposed.node.ik
    )
    // The retry must also reconcile a reservation left before the DB transaction.
    const abandoned = await claimImportedKey(account, a.app.localId, original.node.ik, {
      ...oldDestination,
      expected: proposed.node.ik,
    })
    const retry = await a.app.p2pTransfer.unlock(oldFile!, pass)
    expect((await a.app.p2pTransfer.apply(retry)).ok).toBe(true)
    await abandoned.commit()
    const saved = identityRecords(client.readStoredBook(), origin, username)!
    expect(saved[0]?.ik).toBe(original.node.ik)
    expect(saved[0]?.pendingImport).toBeUndefined()
    expect((await b.app.p2pTransfer.apply(siblingOld)).ok).toBe(false)
    expect((await b.app.p2pTransfer.apply(siblingNew)).ok).toBe(true)
    for (const store of stores) store.close()
    await b.app.p2p.removeData(username)
    await a.app.p2p.removeData(username)
  } finally {
    resume.resolve()
    client.updateStoredBook = update
    account.store.dispose()
    for (const store of stores) {
      const name = store.db.name
      store.close()
      await removeP2pDb(name)
    }
    for (const n of [original, proposed, replacement]) {
      n.node.stop()
      n.store.close()
      await removeP2pDb(n.db)
    }
    memoryStorage.removeItem(manifest)
    await update(book => removeInstance(book, origin))
  }
}, 60000)
