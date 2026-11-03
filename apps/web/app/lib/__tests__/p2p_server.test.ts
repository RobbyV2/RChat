import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import { P2pStore } from '../p2p/db'
import { keyId } from '../p2p/keys'
import { applyImport, exportP2p, KDF_MIN, unlockP2p, type Kdf } from '../p2p/transfer'
import {
  bodies,
  deliver,
  general,
  joinWithCode,
  makeMember,
  pump,
  signed,
  stopAll,
  stopMember,
} from './p2p_server_net'

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

afterEach(stopAll)

describe('P2P servers', () => {
  test('create, join with a code, a join line, and messages both ways', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Book club')
    const ch = general(a, room)
    expect(a.servers.view(room)?.name).toBe('Book club')
    await joinWithCode(clock, a, room, b)
    expect(b.servers.view(room)?.name).toBe('Book club')
    await a.servers.send(room, { ch, body: 'hello bob' })
    await b.servers.send(room, { ch: general(b, room), body: 'hi alice' })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 2, 'b has both')
    await pump(clock, async () => (await bodies(a, room, ch)).length === 2, 'a has both')
    const lines = (await a.servers.loadChannel(room, ch)).messages.filter(m => m.system)
    expect(lines.map(l => [l.system?.kind, l.system?.ik])).toEqual([
      ['join', a.node.ik],
      ['join', b.node.ik],
    ])
  }, 60_000)
})

describe('co-owners (spec 3.8)', () => {
  test('two rounds: the content without certificates goes out, each co-owner certifies its digest', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await b.node.myCard())
    await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
    // Bob hasn't agreed: no certificate, no server.
    expect(await failure(a.servers.create('Shared', [b.node.ik]))).toBe(
      "Bob didn't agree to be a co-owner"
    )
    b.servers.allowCoOwner(a.node.ik)
    const room = await a.servers.create('Shared', [b.node.ik])
    expect(a.servers.view(room)?.owners).toEqual([a.node.ik, b.node.ik])
    const g = (await a.store.event(room))!.wire.c as { owners: { ik: string; dk: string }[] }
    expect(g.owners.map(o => o.ik)).toEqual([a.node.ik, b.node.ik])
    expect(g.owners[1].dk).toBe(b.node.cert.dk)
    // An owner joins without an invite.
    const ch = general(a, room)
    await a.servers.send(room, { ch, body: 'ours' })
    expect(await bodies(a, room, ch)).toEqual(['ours'])
  }, 60_000)
})

describe('devices (spec 3.9)', () => {
  test('a new device introduces itself over its own session: a peer that never met it takes it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Moves')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    expect(a.node.contact(b.node.ik)).toBeUndefined()
    // Bob moves to a new browser: same identity, a new device key.
    const kdf: Kdf = { alg: 'argon2id', m: KDF_MIN.m, t: KDF_MIN.t, p: 1 }
    const sec = await exportP2p(b.store.db, 'correct horse battery', kdf)
    await b.node.markExported(clock.now())
    stopMember(b)
    const dump = await unlockP2p(sec, 'correct horse battery')
    const db = `test-server-move-${Math.random()}`
    const store = await P2pStore.open(db)
    await applyImport(store.db, dump, 'new', { now: clock.now() })
    store.close()
    const b2 = await makeMember(hub, 'Bob', clock, { db })
    const dk2 = keyId(b2.node.author()!.dk.pk)
    expect(dk2).not.toBe(keyId(b.node.author()!.dk.pk))
    await pump(
      clock,
      () => a.servers.sumOf(room).members[b.node.ik]?.devs.includes(dk2) === true,
      'alice takes the new device'
    )
    await b2.servers.send(room, { ch, body: 'from the new device' })
    await pump(
      clock,
      async () => (await bodies(a, room, ch)).includes('from the new device'),
      'a has it'
    )
  }, 90_000)
})

describe('gossip', () => {
  test('A and C are never online together; B bridges, so C’s messages reach A', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Bridge')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, d)
    await a.node.setPaused(true)
    const c = await makeMember(hub, 'Carol', clock)
    // Bob can invite (@everyone may), so Carol joins through him while Alice is away; Dave's
    // client acknowledges Bob's invite (a third member, spec 4.1 W3(e)).
    const code = await b.servers.issueCode(room, 60 * 60_000)
    await c.servers.redeem(code)
    await pump(clock, () => c.servers.myMembership(room) === 'join', 'Carol joined')
    for (const body of ['one', 'two', 'three'])
      await c.servers.send(room, { ch: general(c, room), body })
    await pump(clock, async () => (await bodies(b, room, ch)).length === 3, 'b has c messages')
    await c.node.setPaused(true)
    await d.node.setPaused(true)
    await a.node.setPaused(false)
    await pump(clock, async () => (await bodies(a, room, ch)).length === 3, 'a has c messages')
    expect(await bodies(a, room, ch)).toEqual(['one', 'two', 'three'])
    expect(a.servers.view(room)?.members.find(m => m.ik === c.node.ik)?.m).toBe('join')
    expect(hub.online(c.node.peerId)).toBe(false)
  }, 90_000)
})

describe('moderation and soft-fail', () => {
  test('the owner bans C: what C posts after the ban is shown nowhere, whatever its date', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Mods')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    await c.servers.send(room, { ch, body: 'before' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('before'), 'a has before')
    await pump(clock, async () => (await bodies(b, room, ch)).includes('before'), 'b has before')
    // The ban happens while Bob and Carol are away; Carol then writes without knowing.
    await b.node.setPaused(true)
    await c.node.setPaused(true)
    await a.servers.ban(room, c.node.ik)
    await a.node.setPaused(true)
    await b.node.setPaused(false)
    await c.node.setPaused(false)
    await c.servers.send(room, { ch, body: 'concurrent' })
    await pump(clock, async () => (await bodies(b, room, ch)).includes('concurrent'), 'b got it')
    await c.node.setPaused(true)
    await a.node.setPaused(false)
    await pump(
      clock,
      () => b.servers.view(room)?.members.find(m => m.ik === c.node.ik)?.m === 'ban',
      'b sees ban'
    )
    await pump(clock, async () => !(await bodies(b, room, ch)).includes('concurrent'), 'b hides it')
    await pump(
      clock,
      async () =>
        (
          await a.store.db.getAllFromIndex(
            'events',
            'room_chan_sort',
            IDBKeyRange.bound([room, ch, ''], [room, ch, '￿'])
          )
        ).length >= 2,
      'a stored it'
    )
    expect(await bodies(a, room, ch)).toEqual(['before'])
    expect(await bodies(b, room, ch)).toEqual(['before'])

    // A message on parents from before the ban, dated before it, is hidden as well: past the
    // ban's watermark (a new seq), or equivocating (the seq of 'concurrent').
    const old = (
      await a.store.db.getAllFromIndex(
        'events',
        'room_chan_sort',
        IDBKeyRange.bound([room, ch, ''], [room, ch, '￿'])
      )
    ).find(r => (r.wire.c as { body?: string } | null)?.body === 'before')!
    const oldEv = old.wire.ev as unknown as { ap: string[]; ts: number; seq: number }
    const concurrent = (
      await b.store.db.getAllFromIndex(
        'events',
        'room_chan_sort',
        IDBKeyRange.bound([room, ch, ''], [room, ch, '￿'])
      )
    ).find(r => (r.wire.c as { body?: string } | null)?.body === 'concurrent')!
    const backdated = await signed(
      c,
      room,
      'msg',
      { body: 'backdated', ch },
      { ap: oldEv.ap, ts: oldEv.ts + 1, prev: [old.id], cprev: concurrent.id }
    )
    expect(await deliver(b, room, backdated.wire, clock.now())).toBe('new')
    const forked = await signed(
      c,
      room,
      'msg',
      { body: 'forked', ch },
      { ap: oldEv.ap, ts: oldEv.ts + 1, seq: oldEv.seq + 1, prev: [old.id], cprev: old.id }
    )
    expect(await deliver(b, room, forked.wire, clock.now())).toBe('new')
    expect(await bodies(b, room, ch)).toEqual(['before'])
    // And Carol can't come back with a code.
    await c.node.setPaused(false)
    await pump(clock, () => c.servers.myMembership(room) === 'ban', 'c hears of its ban')
    const code = await a.servers.issueCode(room, 60 * 60_000)
    expect(await failure(c.servers.redeem(code))).toBe("You can't join this server.")
  }, 90_000)

  test('kick, unban, leave and a direct invite of a contact', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    await a.node.addContact(await b.node.myCard())
    await pump(clock, () => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await b.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(b.node.ik)?.state === 'mutual', 'mutual')
    const room = await a.servers.create('Friends')
    const ch = general(a, room)
    await a.servers.invite(room, b.node.ik)
    await pump(clock, () => b.servers.invites().length === 1, 'b sees the invite')
    expect(b.servers.invites()[0].name).toBe('Friends')
    await b.servers.acceptInvite(room)
    await pump(clock, () => b.servers.myMembership(room) === 'join', 'b joined')
    await b.servers.send(room, { ch, body: 'thanks' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('thanks'), 'a got it')
    await a.servers.kick(room, b.node.ik)
    await pump(clock, () => b.servers.myMembership(room) === 'leave', 'b was kicked')
    expect(await failure(b.servers.send(room, { ch, body: 'still here?' }))).toBe(
      "You can't do that here"
    )
    // Kicked members' earlier messages stay.
    expect(await bodies(a, room, ch)).toEqual(['thanks'])
    await a.servers.ban(room, b.node.ik)
    await a.servers.unban(room, b.node.ik)
    expect(a.servers.view(room)?.members.find(m => m.ik === b.node.ik)).toBeUndefined()
    await a.servers.invite(room, b.node.ik)
    await pump(clock, () => b.servers.invites().length === 1, 'invited again')
    await b.servers.acceptInvite(room)
    await pump(clock, () => b.servers.myMembership(room) === 'join', 'b back')
    await b.servers.leave(room)
    await pump(
      clock,
      () => a.servers.view(room)?.members.find(m => m.ik === b.node.ik)?.m === undefined,
      'a sees b leave'
    )
    const lines = (await a.servers.loadChannel(room, ch)).messages.filter(m => m.system)
    expect(lines.map(l => l.system?.kind)).toEqual(['join', 'join', 'leave', 'join', 'leave'])
    // A member who isn't in any more can drop the server from this device.
    await b.servers.forget(room)
    expect(b.servers.isServer(room)).toBe(false)
    expect(
      await b.store.db.countFromIndex(
        'events',
        'room_seq',
        IDBKeyRange.bound([room, 0], [room, Infinity])
      )
    ).toBe(0)
    // And can come back later: their chain goes on from where it was (starting over would be an
    // equivocation).
    await joinWithCode(clock, a, room, b)
    await b.servers.send(room, { ch: general(b, room), body: 'back again' })
    await pump(clock, async () => (await bodies(a, room, ch)).includes('back again'), 'a has it')
  }, 90_000)
})

describe('invite codes', () => {
  test('expired and revoked codes are refused by the admitting device', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Codes')
    const short = await a.servers.issueCode(room, 60 * 60_000)
    clock.t += 2 * 60 * 60_000
    expect(await failure(b.servers.redeem(short))).toBe('This invite has expired.')
    expect(b.servers.isServer(room)).toBe(false)
    const revoked = await a.servers.issueCode(room, 24 * 60 * 60_000, 'for Bob')
    const list = await a.servers.codes(room)
    const entry = list.find(x => x.label === 'for Bob')!
    expect(entry.text).toBe(revoked)
    await a.servers.revokeCode(room, entry.hash)
    expect((await a.servers.codes(room)).find(x => x.hash === entry.hash)?.revoked).toBe(true)
    expect(await failure(b.servers.redeem(revoked))).toBe('This invite was revoked.')
    expect(await failure(b.servers.redeem('rci1.nonsense'))).toBe(
      "This isn't a P2P server invite code."
    )
    // Nobody who can invite is online: the joiner is told so.
    const good = await a.servers.issueCode(room, 24 * 60 * 60_000)
    await a.node.setPaused(true)
    expect(
      (await failure(b.servers.redeem(good))).startsWith('Nobody who can invite is online')
    ).toBe(true)
    await a.node.setPaused(false)
    await b.servers.redeem(good)
    await pump(clock, () => b.servers.myMembership(room) === 'join', 'b joined')
  }, 60_000)

  test('a code names only the room, its name, a secret and peer ids', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Private')
    const code = await a.servers.issueCode(room, 60_000)
    const { parseCode } = await import('../p2p/server')
    const parsed = parseCode(code)!
    expect(Object.keys(parsed).sort()).toEqual(['name', 'peers', 'room', 'secret', 'v'])
    expect(parsed.peers).toEqual([a.node.peerId])
    expect(code).not.toContain(a.node.ik)
  })
})

const fileOf = async (fill: number, size = 3000, name = 'pic.png') => {
  const { hashBytes } = await import('../p2p/hashing')
  const data = new Uint8Array(size).fill(fill)
  const h = await hashBytes(data)
  return {
    data,
    hashed: h,
    att: { h: h.h, size: h.size, blocks: h.blocks.length, name, mime: 'image/png' },
  }
}

describe('history and files', () => {
  test('history `joined`: a joiner never receives what came before their join', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Fresh starts')
    const ch = general(a, room)
    await a.servers.setHistory(room, 'joined')
    const oldFile = await fileOf(1)
    await a.dms.blobs.putOwn(new Blob([oldFile.data as BlobPart]), oldFile.hashed)
    await a.servers.send(room, { ch, body: 'old secret', att: [oldFile.att] })
    const old = (await a.servers.loadChannel(room, ch)).messages.find(m => m.body === 'old secret')!
    await joinWithCode(clock, a, room, b)
    const newFile = await fileOf(2)
    await a.dms.blobs.putOwn(new Blob([newFile.data as BlobPart]), newFile.hashed)
    await a.servers.send(room, { ch, body: 'welcome', att: [newFile.att] })
    await pump(clock, async () => (await bodies(b, room, ch)).includes('welcome'), 'b gets new')
    // Nothing from before Bob's join is on his device, however it is asked for.
    const stored = await b.store.db.getAll('events')
    expect(stored.some(e => e.id === old.id)).toBe(false)
    expect(
      stored.filter(e => e.type === 'msg').map(e => (e.wire.c as { body: string }).body)
    ).toEqual(['welcome'])
    b.servers.loadOlder(room)
    await pump(clock, () => !b.servers.pulling(room), 'b asked for older')
    expect((await b.store.db.getAll('events')).some(e => e.id === old.id)).toBe(false)
    const link = a.servers.sync.linksOf(room).find(l => l.ik === b.node.ik)!
    const getFor = (
      a.servers as unknown as { getFor: (l: unknown, ids: string[]) => Promise<unknown[]> }
    ).getFor.bind(a.servers)
    expect(await getFor(link, [old.id])).toEqual([])
    // Files follow the same gate, asked again for every request.
    expect(await a.servers.entitled(b.node.ik, oldFile.att.h)).toBe(false)
    expect(await a.servers.entitled(b.node.ik, newFile.att.h)).toBe(true)
    // The new picture (an image under 5 MiB) is fetched by itself; the old one never.
    await pump(
      clock,
      async () => !!(await b.dms.blobs.record(newFile.att.h))?.done,
      'b has the picture'
    )
    await b.dms.blobs.download(oldFile.att)
    await pump(
      clock,
      () => b.dms.blobs.view(oldFile.att.h, oldFile.att.size).state !== 'downloading',
      'old refused',
      5000,
      15_000
    ).catch(() => {})
    expect((await b.dms.blobs.record(oldFile.att.h))?.done ?? false).toBe(false)
    // Join lines from before Bob's join aren't shown to him either.
    const lines = (await b.servers.loadChannel(room, ch)).messages.filter(m => m.system)
    expect(lines.map(l => l.system?.ik)).toEqual([b.node.ik])
  }, 90_000)

  test('shared history: a joiner gets earlier messages, and a non-member can’t fetch files', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Open book')
    const ch = general(a, room)
    const f = await fileOf(3, 2 * 1024 * 1024 + 5, 'notes.bin')
    await a.dms.blobs.putOwn(new Blob([f.data as BlobPart]), f.hashed)
    await a.servers.send(room, {
      ch,
      body: 'earlier',
      att: [{ ...f.att, mime: 'application/octet-stream' }],
    })
    await joinWithCode(clock, a, room, b)
    await pump(clock, async () => (await bodies(b, room, ch)).includes('earlier'), 'b has history')
    // A 2 MiB file isn't an image: it waits for a click, then comes from Alice.
    expect((await b.dms.blobs.record(f.att.h))?.done ?? false).toBe(false)
    await b.dms.blobs.download(f.att)
    await pump(clock, async () => !!(await b.dms.blobs.record(f.att.h))?.done, 'b downloaded')
    // Carol is Alice's contact but not in the room: nothing.
    await a.node.addContact(await c.node.myCard())
    await pump(clock, () => c.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await c.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(c.node.ik)?.state === 'mutual', 'mutual')
    expect(await a.servers.entitled(c.node.ik, f.att.h)).toBe(false)
    expect(await a.servers.entitled(b.node.ik, f.att.h)).toBe(true)
    // Bob's own message carrying a hash never entitles him to it.
    await b.servers.send(room, { ch, body: 'mine', att: [{ ...(await fileOf(9)).att }] })
    const mine = (await fileOf(9)).att.h
    await pump(clock, async () => (await bodies(a, room, ch)).includes('mine'), 'a has mine')
    expect(await a.servers.entitled(b.node.ik, mine)).toBe(false)
  }, 90_000)
})

describe('pings, presence and typing', () => {
  test('mentions, @everyone from the owner and replies ping; a member’s @everyone does not', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Pings')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const pings: string[] = []
    b.servers.onArrive(x => x.ping && pings.push(x.ping))
    const aPings: string[] = []
    a.servers.onArrive(x => x.ping && aPings.push(x.ping))
    await a.servers.send(room, { ch, body: 'hey @Bob' })
    await a.servers.send(room, { ch, body: '@everyone meeting' })
    await b.servers.send(room, { ch, body: 'ok' })
    const ok = (await b.servers.loadChannel(room, ch)).messages.find(m => m.body === 'ok')!
    await pump(clock, async () => pings.length >= 2, 'b pinged')
    await a.servers.send(room, { ch, body: 'thanks', reply: ok.id })
    await b.servers.send(room, { ch, body: '@everyone hi' })
    await pump(clock, async () => pings.length >= 3, 'reply ping')
    await pump(clock, async () => (await bodies(a, room, ch)).includes('@everyone hi'), 'a has it')
    expect(pings).toEqual(['mention', 'everyone', 'reply'])
    expect(aPings).toEqual([])
    const view = b.servers.view(room)!
    expect(view.chans[ch].pings).toBe(3)
    expect(view.chans[ch].unread).toBe(3)
    const before = view.chans[ch].readSeq
    await b.servers.unping(room, ch, 1)
    expect(b.servers.view(room)!.chans[ch]).toMatchObject({ unread: 3, pings: 2, readSeq: before })
    expect((await b.store.room(room))?.chans?.[ch]).toMatchObject({ pings: 2, readSeq: before })
    await b.servers.markRead(room, ch)
    expect(b.servers.view(room)!.chans[ch]).toMatchObject({ unread: 0, pings: 0 })
    const rows = (await a.servers.loadChannel(room, ch)).messages
    expect(rows.find(m => m.body === '@everyone meeting')?.everyone).toBe(true)
    expect(rows.find(m => m.body === '@everyone hi')?.everyone).toBe(false)
  }, 60_000)

  test('presence and typing go one hop, and never to someone outside the room', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const d = await makeMember(hub, 'Dave', clock)
    const room = await a.servers.create('Lobby')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    // Dave is Alice's contact, not in the room.
    await a.node.addContact(await d.node.myCard())
    await pump(clock, () => d.node.contact(a.node.ik)?.state === 'incoming', 'request')
    await d.node.accept(a.node.ik)
    await pump(clock, () => a.node.contact(d.node.ik)?.state === 'mutual', 'mutual')
    const seen: string[] = []
    for (const s of d.node.readySessions(a.node.ik)) {
      s.on('gpresence', () => void seen.push('presence'))
      s.on('gtyping', () => void seen.push('typing'))
    }
    a.servers.typing(room, ch, true)
    await pump(clock, () => b.servers.typingIn(room, ch).includes(a.node.ik), 'b sees typing')
    await clock.advance(30_000)
    expect(a.servers.view(room)!.online).toBe(3)
    expect(seen).toEqual([])
    // Carol paused: Bob still counts her only while someone reports her (one hop, 60 s).
    await c.node.setPaused(true)
    await pump(clock, () => b.servers.view(room)!.online === 2, 'b sees carol go', 20_000, 30_000)
  }, 60_000)

  test('a room keeps at most 8 links per member', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const owner = await makeMember(hub, 'Owner', clock)
    const room = await owner.servers.create('Crowd')
    const members = [owner]
    for (let i = 0; i < 11; i += 1) {
      const m = await makeMember(hub, `M${i}`, clock, { seed: 100 + i })
      await joinWithCode(clock, owner, room, m)
      members.push(m)
    }
    for (let i = 0; i < 12; i += 1) await clock.advance(5_000)
    for (const m of members) expect(m.servers.sync.linksOf(room).length).toBeLessThanOrEqual(8)
    const ch = general(owner, room)
    await members[11].servers.send(room, { ch, body: 'to all' })
    for (const m of members)
      await pump(
        clock,
        async () => (await bodies(m, room, ch)).includes('to all'),
        `${m.name} got it`
      )
  }, 120_000)
})

describe('forward compatibility', () => {
  test('an event type from a newer version is stored and synced, not shown, and costs no strike', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Future')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const emit = (
      a.servers as unknown as {
        emit: (r: string, t: string, c: () => unknown, o?: unknown) => Promise<string>
      }
    ).emit.bind(a.servers)
    const poll = await emit(room, 'poll', () => ({ q: 'lunch?', ch }), { L: 'c' })
    const emoji = await emit(room, 'emoji', () => ({ name: 'party' }))
    await a.servers.send(room, { ch, body: 'after' })
    await pump(clock, async () => (await bodies(b, room, ch)).includes('after'), 'b synced')
    expect(await b.store.event(poll)).not.toBeUndefined()
    expect(await b.store.event(emoji)).not.toBeUndefined()
    expect(await bodies(b, room, ch)).toEqual(['after'])
    for (const l of b.servers.sync.linksOf(room)) expect(l.session.strikes).toBe(0)
    for (const l of a.servers.sync.linksOf(room)) expect(l.session.strikes).toBe(0)
  }, 60_000)
})

describe('storage', () => {
  test('schema v5 adds the server indexes to a v3 database and keeps its data', async () => {
    const { openDB } = await import('idb')
    const { UPGRADES, P2pStore: Store, DB_VERSION } = await import('../p2p/db')
    const name = `upgrade-v5-${Math.random()}`
    const v3 = await openDB(name, 3, {
      upgrade(db, _old, _new, tx) {
        for (const up of UPGRADES.slice(0, 3)) up(db as never, tx as never)
      },
    })
    await v3.put('events', { id: 'e1', room: 'r', type: 'msg', sortKey: 'k', seq: 1 })
    await v3.put('rooms', { id: 'r', kind: 'dm', peer: 'p', heads: [], missing: [] })
    await v3.put('meta', 3, 'schema')
    v3.close()
    const store = await Store.open(name)
    expect(DB_VERSION).toBe(5)
    expect(store.db.version).toBe(5)
    expect(store.db.objectStoreNames.contains('idents')).toBe(true)
    expect(store.db.objectStoreNames.contains('codes')).toBe(true)
    expect((await store.event('e1'))?.room).toBe('r')
    expect((await store.room('r'))?.kind).toBe('dm')
    expect(
      await store.db.countFromIndex(
        'events',
        'room_aseq',
        IDBKeyRange.bound(['r', -Infinity], ['r', Infinity])
      )
    ).toBe(0)
    expect(
      await store.db.countFromIndex(
        'events',
        'room_chan_sort',
        IDBKeyRange.bound(['r', '', ''], ['r', '\uffff', '\uffff'])
      )
    ).toBe(0)
    expect(await store.meta('schema')).toBe(5)
    store.close()
    const again = await Store.open(name)
    expect((await again.event('e1'))?.room).toBe('r')
    again.close()
  })
})

describe('checks before storage', () => {
  test('malformed events cost a strike; refusals by the rules and missing parents do not', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Checks')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    const now = () => clock.now()
    // Malformed (spec 2.1): a bad signature, another server, a known type's content wrong.
    const ok = await signed(b, room, 'msg', { body: 'x', ch })
    const forged = { ...ok.wire, sig: ok.wire.sig.replace(/^./, c => (c === 'A' ? 'B' : 'A')) }
    expect(await deliver(a, room, forged, now())).toBe('malformed')
    const other = await signed(b, room, 'msg', { body: 'x', ch })
    const moved = JSON.parse(JSON.stringify(other.wire))
    moved.ev.srv = 'A'.repeat(43)
    expect(await deliver(a, room, moved, now())).toBe('malformed')
    expect(await deliver(a, room, (await signed(b, room, 'kick', { to: 7 })).wire, now())).toBe(
      'malformed'
    )
    // Refused by the rules, no strike: renaming the server without Manage server, kicking the
    // owner, a message to a channel that doesn't exist.
    const settings = await signed(b, room, 'settings', { name: 'Mine' })
    expect(await deliver(a, room, settings.wire, now())).toBe('rejected')
    const kick = await signed(b, room, 'kick', { to: a.node.ik, seen: {} })
    expect(await deliver(a, room, kick.wire, now())).toBe('rejected')
    const lost = await signed(b, room, 'msg', { body: 'x', ch: 'AAAAAAAAAAA' })
    expect(await deliver(a, room, lost.wire, now())).toBe('rejected')
    // An event that cites one we don't have: pending, and that parent is asked for.
    const missing = 'A'.repeat(43)
    const pend = await signed(b, room, 'msg', { body: 'later', ch }, { ap: [missing] })
    expect(await deliver(a, room, pend.wire, now())).toBe('quota')
    expect(a.servers.waiting(room).pending).toBe(1)
    // The real thing is stored.
    expect(await deliver(a, room, ok.wire, now())).toBe('new')
  }, 60_000)
})
