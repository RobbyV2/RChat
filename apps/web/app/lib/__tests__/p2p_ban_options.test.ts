import { describe, expect, test } from 'bun:test'
import { hostedBan, p2pBan, p2pBanSupport, purgeLabel, purgeNote, PURGE_ALL } from '../durations'
import {
  aclContentOk,
  banEnd,
  banOver,
  banReason,
  banTerms,
  banWipes,
  knownRules,
  RULES_NEXT,
  RULES_TEXT_ONLY,
} from '../p2p/acl/rules'
import { BanExpiry, banStateText, dueUnbans, unbanWait, UNBAN_WAIT_MAX } from '../p2p/ban_expiry'
import type { MemberView } from '../p2p/server/types'

const HOUR = 3_600_000
const ban = (c: Record<string, unknown>, ts = 1_000_000) => ({ ts, c: { to: 'bob', ...c } })

describe('ban terms', () => {
  test('the rules that read ban terms come after the text-only rules, and servers join them', () => {
    expect(RULES_NEXT).toBe(5)
    expect(RULES_NEXT).toBeGreaterThan(RULES_TEXT_ONLY)
    expect(knownRules(RULES_NEXT)).toBe(true)
  })

  test('earlier rules read only the reason', () => {
    const e = ban({ until: 2_000_000, reason: 'spam', purge_h: 1, wipe: true })
    expect(banTerms(RULES_TEXT_ONLY, e)).toEqual({ until: null, reason: 'spam', purgeH: null })
    expect(banWipes(RULES_TEXT_ONLY, e, 0)).toBe(true)
    expect(banOver(RULES_TEXT_ONLY, e.c, 5_000_000)).toBe(false)
    expect(aclContentOk('ban', { to: 'bob', until: 'soon', purge_h: -4 }, RULES_TEXT_ONLY)).toBe(
      true
    )
    expect(banTerms(RULES_TEXT_ONLY, ban({ reason: 7 })).reason).toBeNull()
    expect(banTerms(RULES_TEXT_ONLY, ban({ reason: '' })).reason).toBeNull()
    expect([...banTerms(RULES_TEXT_ONLY, ban({ reason: '😀'.repeat(400) })).reason!].length).toBe(
      300
    )
  })

  test('the next rules read the end, the reason and the window', () => {
    const e = ban({ until: 2_000_000, reason: 'spam', purge_h: 2, wipe: true })
    expect(banTerms(RULES_NEXT, e)).toEqual({ until: 2_000_000, reason: 'spam', purgeH: 2 })
    expect(banTerms(RULES_NEXT, ban({}))).toEqual({ until: null, reason: null, purgeH: null })
  })

  test('an end at or before the ban itself is a ban already over, never one without an end', () => {
    expect(banTerms(RULES_NEXT, ban({ until: 1_000_000 })).until).toBe(1_000_000)
    expect(banTerms(RULES_NEXT, ban({ until: 999 })).until).toBe(999)
    expect(banOver(RULES_NEXT, { until: 999 }, 1_000_000)).toBe(true)
    expect(banOver(RULES_NEXT, { until: 2_000_000 }, 1_000_000)).toBe(false)
    expect(banOver(RULES_NEXT, {}, 1_000_000)).toBe(false)
  })

  test('malformed known fields are refused under the next rules, unknown ones are kept', () => {
    const ok = (c: Record<string, unknown>) => aclContentOk('ban', { to: 'bob', ...c }, RULES_NEXT)
    expect(ok({ until: 5, reason: 'x', purge_h: 0, later: { any: 1 } })).toBe(true)
    expect(ok({ purge_h: 168 })).toBe(true)
    expect(ok({ until: 'soon' })).toBe(false)
    expect(ok({ until: 0 })).toBe(false)
    expect(ok({ until: 1.5 })).toBe(false)
    expect(ok({ reason: 7 })).toBe(false)
    expect(ok({ reason: 'x'.repeat(301) })).toBe(false)
    expect(ok({ reason: '😀'.repeat(300) })).toBe(true)
    expect(ok({ purge_h: 169 })).toBe(false)
    expect(ok({ purge_h: -1 })).toBe(false)
  })

  test('a wipe window reaches back its hours from the ban', () => {
    const at = 100 * HOUR
    const e = ban({ wipe: true, purge_h: 24 }, at)
    expect(banWipes(RULES_NEXT, e, at - 24 * HOUR)).toBe(true)
    expect(banWipes(RULES_NEXT, e, at - 24 * HOUR - 1)).toBe(false)
    expect(banWipes(RULES_NEXT, e, at + 5)).toBe(true)
    expect(banWipes(RULES_NEXT, ban({ wipe: true }, at), 0)).toBe(true)
    expect(banWipes(RULES_NEXT, ban({ wipe: true, purge_h: 0 }, at), at - 1)).toBe(false)
  })

  test('an unban keeps a wipe window in force up to the ban, and lifts any other wipe', () => {
    const at = 100 * HOUR
    const e = ban({ wipe: true, purge_h: 24 }, at)
    expect(banWipes(RULES_NEXT, e, at - HOUR, true)).toBe(true)
    expect(banWipes(RULES_NEXT, e, at, true)).toBe(true)
    expect(banWipes(RULES_NEXT, e, at - 24 * HOUR - 1, true)).toBe(false)
    expect(banWipes(RULES_NEXT, e, at + 1, true)).toBe(false)
    expect(banWipes(RULES_NEXT, e, undefined, true)).toBe(true)
    expect(banWipes(RULES_NEXT, ban({ wipe: true }, at), at - HOUR, true)).toBe(false)
    expect(banWipes(RULES_NEXT, ban({ wipe: true }, at), undefined, true)).toBe(false)
    expect(banWipes(RULES_TEXT_ONLY, e, at - HOUR, true)).toBe(false)
    expect(banWipes(RULES_TEXT_ONLY, e, undefined, true)).toBe(false)
    expect(banWipes(RULES_TEXT_ONLY, e, undefined)).toBe(true)
  })

  test('standing bans end with the last of them, never while one has no end', () => {
    const t = (until: number | null, by: string) => ({ until, by, reason: by, purgeH: null })
    expect(banEnd([])).toBeNull()
    expect(banEnd([t(5, 'a'), t(9, 'b'), t(7, 'c')])).toEqual({ until: 9, by: 'b', reason: 'b' })
    expect(banEnd([t(5, 'a'), t(null, 'b')])).toBeNull()
  })

  test('the reason shown is that of the ban that ends last, or of the newest', () => {
    const t = (until: number | null, reason: string | null, ts: number) => ({
      until,
      by: 'a',
      reason,
      purgeH: null,
      ts,
    })
    expect(banReason([])).toBeNull()
    expect(banReason([t(9, 'late', 1), t(5, 'soon', 2)])).toBe('late')
    expect(banReason([t(null, 'old', 1), t(5, 'new', 2)])).toBe('new')
    expect(banReason([t(null, 'old', 1), t(null, null, 2)])).toBeNull()
    expect(banReason([t(null, 'only', 1)])).toBe('only')
  })
})

describe('adapters', () => {
  test('the hosted request carries only what was chosen', () => {
    expect(hostedBan()).toEqual({})
    expect(hostedBan({ seconds: null, reason: null, purgeHours: 0 })).toEqual({})
    expect(hostedBan({ seconds: 86400, reason: 'spam', purgeHours: 24 })).toEqual({
      duration_secs: 86400,
      reason: 'spam',
      purge_hours: 24,
    })
    expect(hostedBan({ seconds: null, reason: null, purgeHours: PURGE_ALL })).toEqual({})
    expect(purgeNote({ purge_skipped: 0, purge_busy: 0 })).toBeNull()
    expect(purgeNote({ purge_skipped: 1, purge_busy: 0 })).toBe(
      "Messages in 1 place were kept. You can't delete there."
    )
    expect(purgeNote({ purge_skipped: 3, purge_busy: 0 })).toContain('3 places ')
    expect(purgeNote({ purge_skipped: 0, purge_busy: 2 })).toBe(
      'Messages in 2 places were kept. A deletion of yours is already running there.'
    )
    expect(purgeNote({ purge_skipped: 1, purge_busy: 1 })).toContain("You can't delete there. ")
  })

  test('a wipe window deletes, a wipe of everything hides', () => {
    expect(purgeLabel('window')).toBe('Delete their messages from')
    expect(purgeLabel('all')).toBe('Hide their messages')
  })

  test('a P2P ban follows what the room and the member allow', () => {
    expect(p2pBanSupport(false, false)).toEqual({ timed: false, purge: 'none' })
    expect(p2pBanSupport(false, true)).toEqual({ timed: false, purge: 'all' })
    expect(p2pBanSupport(true, true)).toEqual({ timed: true, purge: 'window' })
    expect(p2pBanSupport(true, false)).toEqual({ timed: true, purge: 'none' })
    const choice = { seconds: 3600, reason: 'spam', purgeHours: 24 }
    expect(p2pBan(choice, p2pBanSupport(true, true))).toEqual({
      wipe: true,
      reason: 'spam',
      seconds: 3600,
      purgeH: 24,
    })
    expect(p2pBan(choice, p2pBanSupport(false, true))).toEqual({
      wipe: false,
      reason: 'spam',
    })
    expect(p2pBan({ ...choice, purgeHours: PURGE_ALL }, p2pBanSupport(false, true))).toEqual({
      wipe: true,
      reason: 'spam',
    })
    expect(p2pBan(choice, p2pBanSupport(true, false)).wipe).toBe(false)
  })
})

const member = (o: Partial<MemberView>): MemberView => ({
  ik: 'bob',
  m: 'ban',
  name: 'Bob',
  owner: false,
  online: false,
  contact: false,
  below: true,
  waits: false,
  myInvite: false,
  unban: true,
  roles: [],
  top: null,
  ...o,
})

describe('ban expiry', () => {
  test('the banner goes at once, others after up to ten minutes', () => {
    expect(unbanWait(true, () => 0.9)).toBe(0)
    expect(unbanWait(false, () => 0)).toBe(0)
    expect(unbanWait(false, () => 0.5)).toBe(UNBAN_WAIT_MAX / 2)
    expect(unbanWait(false, () => 0.999999)).toBeLessThan(UNBAN_WAIT_MAX)
  })

  test('due bans are the ended ones this device may lift', () => {
    const members = [
      member({ ik: 'a', banUntil: 50 }),
      member({ ik: 'b', banUntil: 150 }),
      member({ ik: 'c', banUntil: 50, unban: false }),
      member({ ik: 'd' }),
      member({ ik: 'e', m: 'join', banUntil: 50 }),
    ]
    expect(dueUnbans({ members }, 100).map(m => m.ik)).toEqual(['a'])
  })

  test('the member list says when a ban ends, then that it waits', () => {
    expect(banStateText(member({}), 100)).toBeNull()
    expect(banStateText(member({ banUntil: 9_000_000 }), 100, 'en-US')).toContain('Ban ends ')
    expect(banStateText(member({ banUntil: 50 }), 100)).toBe("Waiting for a moderator's device")
  })

  const rig = (random = 0.5) => {
    let now = 0
    const timers: { at: number; fn: () => void; live: boolean }[] = []
    const rooms: Record<string, { members: MemberView[] }> = {}
    const unbans: string[] = []
    const expiry = new BanExpiry({
      now: () => now,
      random: () => random,
      setTimer: (fn, ms) => {
        const t = { at: now + ms, fn, live: true }
        timers.push(t)
        return t
      },
      clearTimer: t => void ((t as { live: boolean }).live = false),
      view: room => rooms[room] ?? null,
      unban: (room, ik) => void unbans.push(`${room}:${ik}`),
    })
    const advance = (to: number) => {
      for (;;) {
        const next = timers.filter(t => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = Math.max(now, next.at)
        next.live = false
        next.fn()
      }
      now = to
    }
    return { expiry, rooms, unbans, advance }
  }

  test('the banner lifts its ban when it ends', () => {
    const r = rig()
    r.rooms.room = { members: [member({ banUntil: 1000, banMine: true })] }
    r.expiry.sync(r.rooms)
    r.advance(999)
    expect(r.unbans).toEqual([])
    r.advance(1000)
    expect(r.unbans).toEqual(['room:bob'])
  })

  test('another moderator waits, and skips a ban that is already lifted', () => {
    const r = rig(0.5)
    r.rooms.one = { members: [member({ banUntil: 1000 })] }
    r.rooms.two = { members: [member({ ik: 'carol', banUntil: 1000 })] }
    r.expiry.sync(r.rooms)
    r.advance(1000 + UNBAN_WAIT_MAX / 2 - 1)
    expect(r.unbans).toEqual([])
    r.rooms.two = { members: [member({ ik: 'carol', m: 'leave' })] }
    r.advance(1000 + UNBAN_WAIT_MAX / 2)
    expect(r.unbans).toEqual(['one:bob'])
  })

  test('a device that may not lift the ban never writes, and gone bans drop their timers', () => {
    const r = rig()
    r.rooms.room = { members: [member({ banUntil: 1000, unban: false })] }
    r.expiry.sync(r.rooms)
    expect(r.expiry.pending).toBe(0)
    r.rooms.room = { members: [member({ banUntil: 1000, banMine: true })] }
    r.expiry.sync(r.rooms)
    r.expiry.sync(r.rooms)
    expect(r.expiry.pending).toBe(1)
    r.expiry.sync({})
    expect(r.expiry.pending).toBe(0)
    r.advance(5000)
    expect(r.unbans).toEqual([])
  })

  test('a ban is lifted once per end, however often the view changes before the unban shows', () => {
    const r = rig()
    const banned = (until: number) => ({ members: [member({ banUntil: until, banMine: true })] })
    r.rooms.room = banned(1000)
    r.expiry.sync(r.rooms)
    r.advance(1000)
    expect(r.unbans).toEqual(['room:bob'])
    for (let i = 0; i < 5; i++) {
      r.rooms.room = banned(1000)
      r.expiry.sync(r.rooms)
      r.advance(1000 + 30 * (i + 1))
    }
    expect(r.unbans).toEqual(['room:bob'])
    expect(r.expiry.pending).toBe(0)
    r.rooms.room = banned(9000)
    r.expiry.sync(r.rooms)
    r.advance(9000)
    expect(r.unbans).toEqual(['room:bob', 'room:bob'])
    r.rooms.room = { members: [] }
    r.expiry.sync(r.rooms)
    r.rooms.room = banned(9000)
    r.expiry.sync(r.rooms)
    r.advance(9001)
    expect(r.unbans).toEqual(['room:bob', 'room:bob', 'room:bob'])
  })

  test('an end far away is reached through repeated timers', () => {
    const r = rig()
    const until = 40 * 86_400_000
    r.rooms.room = { members: [member({ banUntil: until, banMine: true })] }
    r.expiry.sync(r.rooms)
    r.advance(until - 1)
    expect(r.unbans).toEqual([])
    r.advance(until)
    expect(r.unbans).toEqual(['room:bob'])
  })
})
