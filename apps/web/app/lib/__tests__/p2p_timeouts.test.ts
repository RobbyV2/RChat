import { describe, expect, jest, test } from 'bun:test'
import { evaluate } from '../p2p/acl/eval'
import {
  aclContentOk,
  authority,
  endsTimeout,
  guards,
  P,
  RULES_NEXT,
  RULES_VERSION,
  TIMEOUT_MAX_MS,
  timeoutEnds,
} from '../p2p/acl/rules'
import { TIMEOUT_CONTENT } from '../p2p/event_v2'
import { buildSummary, emptySummary, type Summary } from '../p2p/acl/summary'
import type { RoomRecord } from '../p2p/db'
import { actParts, CANT_TEXT, effectHolds, refusalText, TIMED_OUT_TEXT } from '../p2p/flows'
import { LOCAL } from '../p2p/limits'
import { everyoneItems, permItems } from '../perm_source'
import { serverView } from '../p2p/server/views'
import { RESIGN_ACL } from '../p2p/server/types'
import {
  TIMEOUT_MAX,
  TIMEOUT_PRESETS,
  TIMEOUT_REASON_MAX,
  customSeconds,
  timeoutSeconds,
} from '../durations'
import { endWatch, peerTimeout, timedOutIn } from '../timeouts'
import { AclWorld, devOwner } from './p2p_acl_world'
import { timeout as signTimeout } from '../p2p/server/roles'
import type { ServerCtx } from '../p2p/server/context'
import { Hub, makeMember, ManualClock } from './p2p_server_net'

const MIN = 60_000

// A room of the rules that read timeouts: owner O, moderator M (TimeoutMembers, role at 5),
// members U and V, one channel.
function room(next = true) {
  const w = new AclWorld({ model: false })
  if (next) w.genesisNext('O1', ['O'])
  else w.genesis('O1', ['O'])
  w.channel('O1')
  const mod = w.ok('O1', 'role_create', { pos: 5, bits: P.TimeoutMembers }).id
  for (const dev of ['M1', 'U1', 'V1']) {
    w.ok('O1', 'add', { to: devOwner(dev) })
    w.ok(dev, 'join')
  }
  w.ok('O1', 'assign', { to: 'M', role: mod })
  return { w, mod }
}
const summary = (w: AclWorld) =>
  buildSummary({
    ix: w.ref.acl.ix,
    unknownRules: undefined,
    unknownCount: 0,
    gone: new Map(),
    state: () => w.ref.state(),
    evaluation: () => w.ref.acl.evaluation(),
    heads: () => [],
  }).summary
const timeouts = (w: AclWorld) => [...w.state().facts.timeouts]
const out = (w: AclWorld, dev: string, to: string, ms: number, c: Record<string, unknown> = {}) => {
  const e = w.build(dev, 'timeout', { to, ...c })
  e.c.until = e.ts + ms
  w.all.push(e)
  return { e, v: w.ref.receive(e) }
}
const okOut = (w: AclWorld, dev: string, to: string, ms: number) => {
  const { e, v } = out(w, dev, to, ms)
  expect(v).toEqual({ s: 'A' })
  return e
}

describe('timeout content', () => {
  const ok = (c: unknown, rules = RULES_NEXT) => aclContentOk('timeout', c, rules)

  test('the rules that read it need a member and an end of the right types', () => {
    expect(ok({ to: 'U', until: 5 })).toBe(true)
    expect(ok({ to: 'U', until: 5, reason: 'spam', later: [1] })).toBe(true)
    expect(ok({ until: 5 })).toBe(false)
    expect(ok({ to: 'U' })).toBe(false)
    expect(ok({ to: 7, until: 5 })).toBe(false)
    expect(ok({ to: 'U', until: '5' })).toBe(false)
    expect(ok({ to: 'U', until: 1.5 })).toBe(false)
    expect(ok({ to: 'U', until: 5, reason: 7 })).toBe(false)
    expect(ok({ to: 'U', until: 5, reason: 'x'.repeat(301) })).toBe(false)
    expect(ok({ to: 'U', until: 5, reason: '😀'.repeat(300) })).toBe(true)
  })

  test('earlier rules keep every field unread', () => {
    expect(ok({}, RULES_VERSION)).toBe(true)
    expect(ok({ to: 7, until: 'soon', reason: 3 }, RULES_VERSION)).toBe(true)
    expect(ok({ to: 7 }, 2)).toBe(true)
  })

  test('an end at or before the event itself ends a timeout', () => {
    expect(timeoutEnds({ ts: 10, c: { until: 10 } })).toBe(true)
    expect(timeoutEnds({ ts: 10, c: { until: 3 } })).toBe(true)
    expect(timeoutEnds({ ts: 10, c: { until: 11 } })).toBe(false)
  })

  test('the permission is bit 16777216', () => {
    expect(P.TimeoutMembers).toBe(16777216)
  })
})

describe('timeout admission', () => {
  test('a moderator with the permission times out a member below them', () => {
    const { w } = room()
    const e = okOut(w, 'M1', 'U', 10 * MIN)
    expect(w.ref.rec(e.id).cls).toBe('D')
    expect(timeouts(w)).toEqual([['U', e.c.until as number]])
    expect(w.state().eff.has(e.id)).toBe(true)
  })

  test('it needs the permission, a lower target, a member, and someone else', () => {
    const { w, mod } = room()
    expect(out(w, 'V1', 'U', MIN).v).toEqual({ s: 'R', why: 'auth' })
    expect(out(w, 'M1', 'O', MIN).v).toEqual({ s: 'R', why: 'auth' })
    expect(out(w, 'M1', 'M', MIN).v).toEqual({ s: 'R', why: 'auth' })
    expect(out(w, 'O1', 'O', MIN).v).toEqual({ s: 'R', why: 'auth' })
    expect(out(w, 'M1', 'Nobody', MIN).v).toEqual({ s: 'R', why: 'auth' })
    w.ok('O1', 'assign', { to: 'V', role: mod })
    expect(out(w, 'M1', 'V', MIN).v).toEqual({ s: 'R', why: 'auth' })
    expect(timeouts(w)).toEqual([])
  })

  test('it lasts at most 28 days from its own time, whatever end it names', () => {
    const { w } = room()
    const e = okOut(w, 'M1', 'U', 400 * 86_400_000)
    expect(timeouts(w)).toEqual([['U', e.ts + TIMEOUT_MAX_MS]])
    expect(summary(w).members.U.timeoutUntil).toBe(e.ts + TIMEOUT_MAX_MS)
    const f = okOut(w, 'M1', 'V', TIMEOUT_MAX_MS)
    expect(new Map(timeouts(w)).get('V')).toBe(f.c.until as number)
  })

  test('it counts in the hourly window, unlike a kick', () => {
    const { w } = room()
    const e = okOut(w, 'M1', 'U', MIN)
    expect(w.ref.rec(e.id).exempt).toBe(false)
    expect(w.ref.rec(w.ok('O1', 'kick', { to: 'U' }).id).exempt).toBe(true)
  })

  test('the re-apply list can offer one: its check has no time of its own', () => {
    const { w } = room()
    const e = w.build('M1', 'timeout', { to: 'V', until: 1_800_000_000_000 })
    const probe = { ...e, id: '', ap: [], ts: 0 }
    const F = w.state().facts
    expect(authority(probe, F) && guards(probe, F, w.ref.lim)).toBe(true)
  })

  test('malformed fields are refused as content', () => {
    const { w } = room()
    const e = w.build('M1', 'timeout', { to: 'U', until: 'later' })
    expect(w.ref.receive(e)).toEqual({ s: 'M', why: 'content' })
  })

  test('the latest write counts: a longer one, a shorter one, then its end', () => {
    const { w } = room()
    okOut(w, 'M1', 'U', 10 * MIN)
    const longer = okOut(w, 'O1', 'U', 60 * MIN)
    expect(timeouts(w)).toEqual([['U', longer.c.until as number]])
    const shorter = okOut(w, 'M1', 'U', MIN)
    expect(timeouts(w)).toEqual([['U', shorter.c.until as number]])
    const end = okOut(w, 'M1', 'U', 0)
    expect(w.ref.rec(end.id).cls).toBe('G')
    expect(timeouts(w)).toEqual([])
  })

  test('of two concurrent timeouts the more senior author wins', () => {
    const { w } = room()
    const heads = w.heads()
    const low = okOut(w, 'M1', 'U', 10 * MIN)
    const high = out(w, 'O1', 'U', 0)
    expect(high.v).toEqual({ s: 'A' })
    const e = w.build('O1', 'timeout', { to: 'V' }, { ap: heads })
    e.c.until = e.ts + 5 * MIN
    expect(w.ref.receive(e)).toEqual({ s: 'A' })
    const f = w.build('M1', 'timeout', { to: 'V' }, { ap: heads })
    f.c.until = f.ts + 50 * MIN
    expect(w.ref.receive(f)).toEqual({ s: 'A' })
    expect(low.c.until).toBeGreaterThan(0)
    expect(new Map(timeouts(w)).get('V')).toBe(e.c.until as number)
    expect(new Map(timeouts(w)).has('U')).toBe(false)
  })

  test('a timeout of someone promoted above its author at the same time is cut', () => {
    const { w } = room()
    const heads = w.heads()
    const top = w.ok('O1', 'role_create', { pos: 9, bits: 0 }).id
    w.ok('O1', 'assign', { to: 'U', role: top })
    const e = w.build('M1', 'timeout', { to: 'U' }, { ap: heads })
    e.c.until = e.ts + 10 * MIN
    expect(w.ref.receive(e)).toEqual({ s: 'A' })
    expect(w.state().eff.has(e.id)).toBe(false)
    expect(timeouts(w)).toEqual([])
  })

  test('the batch evaluation agrees with the incremental one', () => {
    const { w } = room()
    const e = okOut(w, 'M1', 'U', 10 * MIN)
    okOut(w, 'O1', 'V', 20 * MIN)
    okOut(w, 'O1', 'V', 0)
    const batch = evaluate([...w.ref.order].reverse(), w.ref)
    expect([...batch.facts.timeouts]).toEqual([['U', e.c.until as number]])
    expect([...batch.eff].sort()).toEqual([...w.state().eff].sort())
  })

  test('a kicked member shows no timeout', () => {
    const { w } = room()
    okOut(w, 'M1', 'U', 10 * MIN)
    w.ok('O1', 'kick', { to: 'U' })
    expect(summary(w).members.U.timeoutUntil).toBeUndefined()
  })

  test('earlier rules admit the type from any member and read nothing', () => {
    const { w } = room(false)
    const e = w.ok('V1', 'timeout', { to: 'O', until: 9e15, reason: 7 })
    expect(w.ref.rec(e.id).cls).toBe('A')
    expect(timeouts(w)).toEqual([])
    const m = w.content('O1')
    expect(w.admitContent(m).ok).toBe(true)
  })
})

describe('content of a timed-out member', () => {
  test('the kinds a timeout stops are refused until it ends', () => {
    const { w } = room()
    const before = w.content('U1')
    expect(w.admitContent(before).ok).toBe(true)
    const e = okOut(w, 'M1', 'U', 10 * MIN)
    for (const t of TIMEOUT_CONTENT)
      expect(w.admitContent(w.content('U1', t, { body: 'x', target: before.id }))).toEqual({
        ok: false,
        why: 'timeout',
      })
    expect(w.admitContent(w.content('U1', 'redact', { target: before.id })).ok).toBe(true)
    expect(w.admitContent(w.content('V1')).ok).toBe(true)
    const until = e.c.until as number
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x' }, { ts: until - 1 })).ok).toBe(false)
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x' }, { ts: until })).ok).toBe(true)
  })

  test('content held without its body is refused the same way', () => {
    const { w } = room()
    okOut(w, 'M1', 'U', 10 * MIN)
    const m = w.content('U1')
    expect(w.admitContent({ ...m, c: null })).toEqual({ ok: false, why: 'timeout' })
  })

  test('ending the timeout lets the member post again', () => {
    const { w } = room()
    okOut(w, 'M1', 'U', 10 * MIN)
    expect(w.admitContent(w.content('U1')).ok).toBe(false)
    okOut(w, 'O1', 'U', 0)
    expect(w.admitContent(w.content('U1')).ok).toBe(true)
  })

  test('a message that does not have the timeout in its past is kept', () => {
    const { w } = room()
    const heads = w.heads()
    okOut(w, 'M1', 'U', 10 * MIN)
    expect(w.admitContent(w.content('U1', 'msg', { body: 'x' }, { ap: heads })).ok).toBe(true)
  })
})

describe('the summary of a timed-out member', () => {
  test('says when it ends, who made it and why', () => {
    const { w } = room()
    const { e, v } = out(w, 'M1', 'U', 10 * MIN, { reason: 'calm down' })
    expect(v).toEqual({ s: 'A' })
    const s = summary(w)
    expect(s.rules).toBe(RULES_NEXT)
    expect(s.members.U).toMatchObject({
      timeoutUntil: e.c.until as number,
      timeoutBy: 'M',
      timeoutReason: 'calm down',
    })
    expect(s.members.V.timeoutUntil).toBeUndefined()
  })
})

const viewOf = (s: Summary, me: string, lim = LOCAL) =>
  serverView('room', { missing: [], lastSeq: 0, full: false } as unknown as RoomRecord, s, null, {
    me,
    online: () => new Set<string>(),
    name: ik => ik,
    contact: () => false,
    trying: () => false,
    readOnly: () => null,
    frozen: () => false,
    voice: () => ({}),
    syncing: () => false,
    lim,
    now: () => Date.now(),
  })

describe('the view of a room with timeouts', () => {
  const world = () => {
    const { w } = room()
    const { e } = out(w, 'M1', 'U', 10 * MIN, { reason: 'calm down' })
    return { s: summary(w), until: e.c.until as number }
  }

  test('a moderator sees the end and the reason, and may time out', () => {
    const { s, until } = world()
    const v = viewOf(s, 'M')
    expect(v.timeouts).toBe(true)
    expect(v.timedOutUntil).toBeUndefined()
    expect(v.members.find(m => m.ik === 'U')).toMatchObject({
      timeoutUntil: until,
      timeoutReason: 'calm down',
    })
    expect(v.members.find(m => m.ik === 'V')?.timeoutUntil).toBeUndefined()
  })

  test('a moderator gets the whole reason, as long as a timeout may give', () => {
    const { w } = room()
    const reason = 'é'.repeat(TIMEOUT_REASON_MAX)
    out(w, 'M1', 'U', 10 * MIN, { reason })
    const lim = { ...LOCAL, display: { ...LOCAL.display, reason: 32 } }
    expect(viewOf(summary(w), 'M', lim).members.find(m => m.ik === 'U')?.timeoutReason).toBe(reason)
  })

  test('a member without the permission sees the end, never the reason', () => {
    const { s, until } = world()
    const u = viewOf(s, 'U')
    expect(u.timedOutUntil).toBe(until)
    expect(u.members.find(m => m.ik === 'U')?.timeoutReason).toBeUndefined()
    const v = viewOf(s, 'V').members.find(m => m.ik === 'U')
    expect(v?.timeoutUntil).toBe(until)
    expect(v?.timeoutReason).toBeUndefined()
  })

  test('rooms on earlier rules have none', () => {
    const { w } = room(false)
    const v = viewOf(summary(w), 'O')
    expect(v.timeouts).toBeUndefined()
    expect(permItems(v.rules).some(i => i.bit === BigInt(P.TimeoutMembers))).toBe(false)
    expect(viewOf({ ...emptySummary(), rules: RULES_VERSION }, 'O').timeouts).toBeUndefined()
  })

  test('the permission is offered for roles and @everyone where timeouts are read', () => {
    const v = viewOf(summary(room().w), 'O')
    expect(v.timeouts).toBe(true)
    expect(permItems(v.rules).find(i => i.bit === BigInt(P.TimeoutMembers))).toMatchObject({
      name: 'TimeoutMembers',
      bit: 16777216n,
      hint: 'Stop members from chatting for a while',
    })
    expect(everyoneItems(v.rules).some(i => i.bit === BigInt(P.TimeoutMembers))).toBe(true)
    expect(everyoneItems(RULES_VERSION).some(i => i.bit === BigInt(P.TimeoutMembers))).toBe(false)
  })
})

describe('timeouts on a device', () => {
  test('who is timed out now', () => {
    const members = [{ ik: 'a', timeoutUntil: 500 }, { ik: 'b', timeoutUntil: 100 }, { ik: 'c' }]
    expect(timedOutIn(members, 200)).toEqual(['a'])
    expect(timedOutIn(members, 500)).toEqual([])
    expect(timedOutIn(undefined, 0)).toEqual([])
  })

  test('a running timeout as the badge reads it', () => {
    expect(peerTimeout({ timeoutUntil: 500, timeoutReason: 'x' }, 200)).toEqual({
      ends: 500,
      reason: 'x',
    })
    expect(peerTimeout({ timeoutUntil: 500 }, 200)).toEqual({ ends: 500, reason: null })
    expect(peerTimeout({ timeoutUntil: 500 }, 500)).toBeNull()
    expect(peerTimeout({}, 0)).toBeNull()
    expect(peerTimeout(undefined, 0)).toBeNull()
  })

  test('both sides take 1 second to 28 days', () => {
    expect(TIMEOUT_MAX * 1000).toBe(TIMEOUT_MAX_MS)
    for (const p of TIMEOUT_PRESETS) expect(timeoutSeconds(p.seconds)).toBe(p.seconds)
    expect(timeoutSeconds(0)).toBeNull()
    expect(timeoutSeconds(1)).toBe(1)
    expect(timeoutSeconds(TIMEOUT_MAX)).toBe(TIMEOUT_MAX)
    expect(timeoutSeconds(TIMEOUT_MAX + 1)).toBeNull()
    expect(timeoutSeconds(1.5)).toBeNull()
    expect(customSeconds('28', 86400)).toBe(TIMEOUT_MAX)
    expect(customSeconds('29', 86400)).toBeNull()
  })

  test('a refused message says why, and lists name the act', () => {
    expect(refusalText('timeout')).toBe(TIMED_OUT_TEXT)
    expect(actParts('timeout', 'U')).toEqual({ act: 'Time out', who: 'U' })
    expect(actParts('timeout', 'U', true)).toEqual({ act: 'Remove the timeout of', who: 'U' })
    expect(RESIGN_ACL).toContain('timeout')
    expect(endsTimeout('timeout', { ts: 500, c: { to: 'U', until: 500 } })).toBe(true)
    expect(endsTimeout('timeout', { ts: 500, c: { to: 'U', until: 501 } })).toBe(false)
    expect(endsTimeout('ban', { ts: 500, c: { to: 'U', until: 100 } })).toBe(false)
  })

  test('a timeout of ours holds while its end is the one in force', () => {
    const s = { ...emptySummary(), members: { U: { timeoutUntil: 900 } } } as unknown as Summary
    const holds = (c: Record<string, unknown>, ts = 50) =>
      effectHolds('timeout', c, 'id', 'M', s, ts, 200)
    expect(holds({ to: 'U', until: 900 })).toBe(true)
    expect(holds({ to: 'U', until: 100 })).toBe(false)
    expect(holds({ to: 'V', until: 900 })).toBe(false)
    expect(holds({ to: 'U', until: 900 + TIMEOUT_MAX_MS }, 900 - TIMEOUT_MAX_MS)).toBe(true)
    expect(holds({ to: 'U', until: 900 + TIMEOUT_MAX_MS }, 901 - TIMEOUT_MAX_MS)).toBe(false)
  })

  test('a removal of ours holds while no timeout runs, like a lifted ban', () => {
    const end = { to: 'U', until: 300 }
    const sumOf = (U: Record<string, unknown>) =>
      ({ ...emptySummary(), members: { U: { m: 'join', ...U } } }) as unknown as Summary
    const holds = (s: Summary, now: number) => effectHolds('timeout', end, 'id', 'M', s, 300, now)
    expect(holds(sumOf({}), 400)).toBe(true)
    expect(holds(sumOf({ timeoutUntil: 1000 }), 400)).toBe(false)
    expect(holds(sumOf({ timeoutUntil: 1000 }), 1000)).toBe(true)
    expect(effectHolds('timeout', end, 'id', 'M', sumOf({}), 300, 400)).toBe(
      effectHolds('unban', { to: 'U' }, 'id', 'M', sumOf({}), 300, 400)
    )
    expect(effectHolds('timeout', { to: 'V', until: 300 }, 'id', 'M', sumOf({}), 300)).toBe(false)
  })
})

describe('the end of our own timeout in a voice channel', () => {
  test('is waited out past the longest timer, and runs the change once it passes', () => {
    jest.useFakeTimers()
    try {
      const longest = 2 ** 31 - 1
      let end: number | null = null
      let reads = 0
      let changes = 0
      const watch = endWatch(
        () => {
          reads += 1
          return end
        },
        () => void (changes += 1)
      )
      watch.sync()
      expect([reads, changes]).toEqual([1, 0])
      end = Date.now() + 60 * 86_400_000
      watch.sync()
      watch.sync()
      expect([reads, changes]).toEqual([3, 1])
      jest.advanceTimersByTime(longest)
      jest.advanceTimersByTime(longest)
      expect([reads, changes]).toEqual([5, 1])
      end = null
      jest.advanceTimersByTime(longest)
      expect([reads, changes]).toEqual([6, 2])
      jest.advanceTimersByTime(longest)
      expect(reads).toBe(6)
      end = Date.now() + MIN
      watch.sync()
      watch.stop()
      jest.advanceTimersByTime(2 * MIN)
      expect([reads, changes]).toEqual([7, 3])
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('signing a timeout', () => {
  const ctx = (rules: number, now: number, planTs: number) => {
    const made: unknown[] = []
    const cx = {
      sumOf: () => ({ rules }),
      clock: { now: () => now },
      emit: (room: string, t: string, make: (plan: { ts: number }) => unknown) => {
        made.push([room, t, make({ ts: planTs })])
        return Promise.resolve('id')
      },
    } as unknown as ServerCtx
    return { cx, made }
  }

  test('its length counts from the time it is signed, with the reason cut to 300', async () => {
    const { cx, made } = ctx(RULES_NEXT, 1_000, 5_000)
    await signTimeout(cx, 'room', 'U', 600, 'x'.repeat(400))
    await signTimeout(cx, 'room', 'U', 60)
    expect(made).toEqual([
      ['room', 'timeout', { to: 'U', until: 605_000, reason: 'x'.repeat(300) }],
      ['room', 'timeout', { to: 'U', until: 65_000 }],
    ])
    const late = ctx(RULES_NEXT, 9_000, 5_000)
    await signTimeout(late.cx, 'room', 'U', 1)
    expect(late.made).toEqual([['room', 'timeout', { to: 'U', until: 10_000 }]])
  })

  test('0 seconds ends it and carries no reason; more than 28 days is cut to 28', async () => {
    const { cx, made } = ctx(RULES_NEXT, 1_000, 1_000)
    await signTimeout(cx, 'room', 'U', 0, 'why')
    await signTimeout(cx, 'room', 'U', 99 * 86400)
    expect(made).toEqual([
      ['room', 'timeout', { to: 'U', until: 1_000 }],
      ['room', 'timeout', { to: 'U', until: 1_000 + TIMEOUT_MAX_MS }],
    ])
  })

  test('a room on earlier rules signs none', async () => {
    const { cx, made } = ctx(RULES_VERSION, 1_000, 1_000)
    expect(() => signTimeout(cx, 'room', 'U', 60)).toThrow(CANT_TEXT)
    expect(made).toEqual([])
    const clock = new ManualClock()
    const a = await makeMember(new Hub(), 'Alice', clock)
    const id = await a.servers.create('Club')
    expect(() => a.servers.timeout(id, 'someone', 60)).toThrow(CANT_TEXT)
    expect(a.servers.view(id)?.timeouts).toBeUndefined()
  })
})
