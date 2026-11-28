import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BAN, KICK, P, type Rank, ROLES, SEND, SERVER } from '../p2p/acl/rules'
import { type AutoDoc, type Held, topoOrder, type Want } from '../p2p/automation_docs'
import {
  applyWant,
  candidates,
  type Change,
  CAP_MS,
  collapse,
  counters,
  delayMs,
  latestPress,
  localRows,
  type MemberEvent,
  mayAdmit,
  mayGiveRole,
  mayRun,
  MEMBER_OK,
  needsOf,
  opCap,
  OPS_PER_HOUR,
  order,
  type PanelMode,
  type Post,
  type Press,
  PRESS_MAX_AGE_MS,
  pressLive,
  reconcile,
  roomForPanelOp,
  SELF_SERVICE_OK,
  selfService,
  slotKey,
  STABLE_MS,
  stable,
  type Standing,
  STEP_MS,
  waitFor,
} from '../p2p/automation_runner'
import { importsOf } from './import_graph'

const vectors = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../../../crates/automation/vectors/${name}.json`, import.meta.url)
      ),
      'utf8'
    )
  ) as { cases: Record<string, unknown>[] }

const runner = vectors('runner').cases
const rank = (n: number): Rank => [n, '']
const st = (bits: number, n: number): Standing => ({ bits, rank: rank(n) })

const perms = <T>(xs: T[]): T[][] =>
  xs.length <= 1
    ? [xs]
    : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r]))

describe('the authority intersection', () => {
  test('an author without Ban gets no ban from a Ban-holding runner', () => {
    const dave = st(SERVER, 5)
    const alice = st(SERVER | BAN | ROLES, 9)
    const target = { rank: rank(1) }
    expect(mayRun(dave, alice, BAN, target)).toBe(false)
    expect(mayRun(alice, alice, BAN, target)).toBe(true)
    expect(mayRun(alice, dave, BAN, target)).toBe(false)
  })

  test('the shared vector, with its own bits', () => {
    const c = runner.find(c => c.case === 'author lacks ban') as {
      author: { bits: number; rank: number }
      runner: { bits: number; rank: number }
      needs: number
      target: { rank: number }
      allowed: boolean
    }
    expect(
      mayRun(st(c.author.bits, c.author.rank), st(c.runner.bits, c.runner.rank), c.needs, {
        rank: rank(c.target.rank),
      })
    ).toBe(c.allowed)
  })

  test('a role above the author is never given, even by a runner who outranks it', () => {
    const author = st(ROLES, 3)
    const run = st(ROLES, 9)
    expect(mayRun(author, run, ROLES, { rank: rank(1) }, { rank: rank(5) })).toBe(false)
    expect(mayRun(author, run, ROLES, { rank: rank(1) }, { rank: rank(2) })).toBe(true)
    expect(mayRun(author, run, ROLES, { rank: rank(1) }, { rank: rank(3) })).toBe(false)
    expect(mayRun(run, author, ROLES, { rank: rank(1) }, { rank: rank(5) })).toBe(false)
  })

  test('exhaustive: allowed exactly when within both authorities', () => {
    let allowed = 0
    let checked = 0
    let wrong = 0
    for (let ab = 0; ab < 16; ab += 1)
      for (let rb = 0; rb < 16; rb += 1)
        for (let needs = 1; needs < 16; needs += 1)
          for (const ar of [1, 2, 3])
            for (const rr of [1, 2, 3])
              for (const tr of [0, 1, 2, 3]) {
                const got = mayRun(st(ab, ar), st(rb, rr), needs, { rank: rank(tr) })
                const within = (needs & ~ab) === 0 && (needs & ~rb) === 0 && ar > tr && rr > tr
                if (got !== within) wrong += 1
                if (got) allowed += 1
                checked += 1
              }
    const c = runner.find(c => c.case === 'exhaustive') as { checked: number; allowed: number }
    expect(wrong).toBe(0)
    expect(checked).toBe(16 * 16 * 15 * 3 * 3 * 4)
    expect([checked, allowed]).toEqual([c.checked, c.allowed])
  })

  test('ranks tie-break by role id as the ACL does', () => {
    const author = st(KICK, 3)
    expect(mayRun(author, author, KICK, { rank: [3, 'a'] })).toBe(false)
    expect(
      mayRun({ bits: KICK, rank: [3, 'b'] }, { bits: KICK, rank: [3, 'c'] }, KICK, {
        rank: [3, 'a'],
      })
    ).toBe(true)
  })

  test('self-service roles: Mention everyone only, unless marked', () => {
    const all = P.MentionEveryone | P.ViewChannel | P.SendMessages | KICK
    expect(SELF_SERVICE_OK).toBe(P.MentionEveryone)
    expect(selfService(0, false, all)).toBeNull()
    expect(selfService(P.ViewChannel | P.SendMessages, false, all)).toBe('gives_permissions')
    expect(selfService(P.ViewChannel, false, all)).toBe('gives_permissions')
    expect(selfService(P.SendMessages, false, all)).toBe('gives_permissions')
    expect(selfService(P.ViewChannel | P.SendMessages, true, all)).toBeNull()
    expect(selfService(P.MentionEveryone, false, all)).toBeNull()
    expect(selfService(KICK, false, all)).toBe('gives_permissions')
    expect(selfService(P.Invite, false, all | P.Invite)).toBe('gives_permissions')
    expect(selfService(KICK, true, all)).toBeNull()
    expect(selfService(BAN, true, all)).toBe('owner_cant_grant')
    expect(selfService(P.MentionEveryone, false, 0)).toBe('owner_cant_grant')
  })

  test('giving a role needs Manage roles, both ranks above it, and its bits within both', () => {
    const view = P.ViewChannel | P.SendMessages
    const mention = P.MentionEveryone
    const author = st(ROLES | view | mention, 5)
    const run = st(ROLES | view | mention | KICK, 9)
    const target = { rank: rank(0) }
    const role = (bits: number, n: number, mayGive = false) => ({ bits, rank: rank(n), mayGive })
    expect(mayGiveRole(author, run, target, role(mention, 2))).toBe(true)
    expect(mayGiveRole(author, run, target, role(0, 2))).toBe(true)
    expect(mayGiveRole(author, run, target, role(mention, 5))).toBe(false)
    expect(mayGiveRole(author, run, target, role(KICK, 2))).toBe(false)
    expect(mayGiveRole(author, run, target, role(KICK, 2, true))).toBe(false)
    expect(mayGiveRole(run, run, target, role(KICK, 2, true))).toBe(true)
    expect(mayGiveRole(st(view | mention, 5), run, target, role(mention, 2))).toBe(false)
    expect(mayGiveRole(author, run, { rank: rank(6) }, role(mention, 2))).toBe(false)
  })

  test('a panel, answer or reaction role with channel access is refused unless marked', () => {
    const view = P.ViewChannel | P.SendMessages
    const author = st(ROLES | view, 5)
    const run = st(ROLES | view, 9)
    const target = { rank: rank(0) }
    expect(mayGiveRole(author, run, target, { bits: view, rank: rank(2), mayGive: false })).toBe(
      false
    )
    expect(
      mayGiveRole(author, run, target, { bits: P.ViewChannel, rank: rank(2), mayGive: false })
    ).toBe(false)
    expect(mayGiveRole(author, run, target, { bits: view, rank: rank(2), mayGive: true })).toBe(
      true
    )
  })

  test('admission gives the Member role with channel access and Mention everyone, no more', () => {
    const view = P.ViewChannel | P.SendMessages
    const author = st(ROLES | view | P.MentionEveryone | KICK, 5)
    const run = st(ROLES | view | P.MentionEveryone | KICK, 9)
    const target = { rank: rank(0) }
    const member = (bits: number, n = 2) => ({ bits, rank: rank(n) })
    expect(MEMBER_OK).toBe(view | P.MentionEveryone)
    expect(mayAdmit(author, run, target, member(view))).toBe(true)
    expect(mayAdmit(author, run, target, member(view | P.MentionEveryone))).toBe(true)
    expect(mayAdmit(author, run, target, member(0))).toBe(true)
    expect(mayAdmit(author, run, target, member(view | KICK))).toBe(false)
    expect(mayAdmit(author, run, target, member(view | P.Invite))).toBe(false)
    expect(mayAdmit(author, run, target, member(view | ROLES))).toBe(false)
    expect(mayAdmit(author, run, target, member(view, 5))).toBe(false)
    expect(mayAdmit(author, run, { rank: rank(6) }, member(view))).toBe(false)
    expect(mayAdmit(st(view | KICK, 5), run, target, member(view))).toBe(false)
    expect(mayAdmit(author, st(view | KICK, 9), target, member(view))).toBe(false)
    expect(mayAdmit(st(ROLES | P.ViewChannel, 5), run, target, member(view))).toBe(false)
    expect(mayAdmit(author, st(ROLES | P.SendMessages, 9), target, member(view))).toBe(false)
  })

  test('what each action needs; actions runners never carry out need nothing they can hold', () => {
    expect(needsOf('add_role')).toBe(ROLES)
    expect(needsOf('remove_role')).toBe(ROLES)
    expect(needsOf('toggle_role')).toBe(ROLES)
    expect(needsOf('kick')).toBe(KICK)
    expect(needsOf('ban')).toBe(BAN)
    for (const other of ['send_message', 'timeout', 'hold', 'slowmode', 'toString', ''])
      expect(needsOf(other)).toBeNull()
    expect(SEND).toBe(P.SendMessages)
  })
})

describe('election', () => {
  const c = ['ik-a', 'ik-b', 'ik-c', 'ik-d']

  test('every device computes the same order', () => {
    const o = order('ev1', c)
    expect(order('ev1', [...c].reverse())).toEqual(o)
    expect(order('ev1', [...c, 'ik-a'])).toEqual(o)
    expect(new Set(o)).toEqual(new Set(c))
  })

  test('the candidate order vectors', () => {
    const cases = runner.filter(c => typeof c.event === 'string') as {
      event: string
      candidates: string[]
      order: string[]
    }[]
    expect(cases.length).toBe(2)
    for (const v of cases) expect(order(v.event, v.candidates)).toEqual(v.order)
  })

  test('stagger is 2 s a place, capped at 20 s; non-candidates never act', () => {
    expect([STEP_MS, CAP_MS]).toEqual([2000, 20_000])
    expect(delayMs(0)).toBe(0)
    expect(delayMs(3)).toBe(6000)
    expect(delayMs(50)).toBe(20_000)
    expect(waitFor('ev1', ['ik-a'], 'ik-z')).toBeNull()
    expect(waitFor('ev1', ['ik-a'], 'ik-a')).toBe(0)
    expect(c.map(me => waitFor('ev1', c, me))).toEqual([0, 4000, 2000, 6000])
  })

  test('candidates are the online identities that may run, each once', () => {
    const presence = { online: ['ik-b', 'ik-a', 'ik-b', 'ik-x'] }
    expect(candidates(presence, ik => ik !== 'ik-x')).toEqual(['ik-a', 'ik-b'])
    expect(candidates({ online: [] }, () => true)).toEqual([])
  })
})

describe('slot collapse counts only valid runners, in causal order', () => {
  const s = slotKey('honeypot', 'ev9')
  const runners = new Set(['alice'])
  const valid = (p: Post) => runners.has(p.author)

  test("a plain member's forged slot and earlier place never suppress the runner's alert", () => {
    const posts: Post[] = [
      { id: 'real', author: 'alice', pos: 12, slot: s, via: 'honeypot' },
      { id: 'forged', author: 'bob', pos: 11, slot: s, via: 'honeypot' },
    ]
    const { shown, labelled } = collapse(posts, valid)
    expect(shown.map(p => p.id).sort()).toEqual(['forged', 'real'])
    expect([...labelled]).toEqual(['real'])
  })

  test('the forged slot vector', () => {
    const v = runner.find(c => c.case === 'forged slot') as {
      posts: Post[]
      shown: string[]
      labelled: string[]
    }
    const { shown, labelled } = collapse(v.posts, valid)
    expect(shown.map(p => p.id)).toEqual(v.shown)
    expect([...labelled]).toEqual(v.labelled)
    expect(s).toBe('honeypot:ev9')
  })

  test('two runner posts for one slot collapse to the first in causal order, ties by id', () => {
    runners.add('carol')
    const posts: Post[] = [
      { id: 'b', author: 'carol', pos: 20, slot: s },
      { id: 'a', author: 'alice', pos: 20, slot: s },
      { id: 'c', author: 'alice', pos: 25, slot: s },
      { id: 'd', author: 'dave', pos: 1 },
    ]
    expect(collapse(posts, valid).shown.map(p => p.id)).toEqual(['a', 'd'])
  })

  test('collapse over topological positions keeps the same post on every reader', () => {
    const o = topoOrder([
      { id: 'x2', deps: [] },
      { id: 'x1', deps: [] },
    ])
    const key = slotKey('auto', 'ev')
    const posts: Post[] = [
      { id: 'x2', author: 'alice', pos: o.indexOf('x2'), slot: key },
      { id: 'x1', author: 'carol', pos: o.indexOf('x1'), slot: key },
    ]
    expect(collapse(posts, () => true).shown.map(p => p.id)).toEqual(['x1'])
  })
})

const TOGGLE: PanelMode = { kind: 'toggle' }

describe('presses carry the desired state', () => {
  const panel = ['r1', 'r2', 'r3']
  const run = (wants: Want[], role: string, start: string[]) => {
    let held = [...start]
    for (const w of wants) {
      const c = applyWant(w, held, panel, role, TOGGLE)
      held = held.filter(r => !c.remove.includes(r)).concat(c.add)
    }
    return held.sort()
  }

  test('on then off converges to off once the last want wins', () => {
    expect(run(['on', 'off'], 'r1', [])).toEqual([])
    expect(run(['off', 'on', 'off'], 'r1', [])).toEqual([])
    expect(run(['on', 'on'], 'r1', [])).toEqual(['r1'])
  })

  test('the same want applied twice is a no-op the second time', () => {
    expect(applyWant('on', ['r1'], panel, 'r1', TOGGLE)).toEqual({ add: [], remove: [] })
    expect(applyWant('off', [], panel, 'r1', TOGGLE)).toEqual({ add: [], remove: [] })
  })

  test('menu wants set the panel roles exactly, and never a role outside the panel', () => {
    expect(applyWant(['r2', 'r3'], ['r1', 'r9'], panel, '', TOGGLE)).toEqual({
      add: ['r2', 'r3'],
      remove: ['r1'],
    })
    expect(applyWant(['r2', 'admin', 'r2'], [], panel, '', TOGGLE)).toEqual({
      add: ['r2'],
      remove: [],
    })
    expect(applyWant('on', [], panel, 'admin', TOGGLE)).toEqual({
      add: [],
      remove: [],
      refused: 'not_in_panel',
    })
  })

  test("a want does only what the panel's mode lets its buttons and menus do", () => {
    const none = { add: [], remove: [] }
    const want = (mode: PanelMode, w: Want, held: string[], role = 'r2') =>
      applyWant(w, held, panel, role, mode)
    const unique: PanelMode = { kind: 'unique' }
    expect(want(unique, panel, [])).toEqual({ ...none, refused: 'too_many' })
    expect(want(unique, ['r2'], ['r1', 'r9'])).toEqual({ add: ['r2'], remove: ['r1'] })
    expect(want(unique, 'on', ['r1', 'r9'])).toEqual({ add: ['r2'], remove: ['r1'] })
    expect(want(unique, 'off', ['r2'])).toEqual({ add: [], remove: ['r2'] })
    const one: PanelMode = { kind: 'limit', n: 1 }
    expect(want(one, ['r1', 'r2'], [])).toEqual({ ...none, refused: 'limit' })
    expect(want(one, 'on', ['r1'])).toEqual({ ...none, refused: 'limit' })
    expect(want(one, 'on', ['r2'])).toEqual(none)
    expect(want({ kind: 'limit', n: 2 }, 'on', ['r1'])).toEqual({ add: ['r2'], remove: [] })
    const verify: PanelMode = { kind: 'verify' }
    expect(want(verify, 'off', ['r2'])).toEqual(none)
    expect(want(verify, ['r3'], ['r1', 'r2'])).toEqual({ add: ['r3'], remove: [] })
    expect(want(verify, 'on', [])).toEqual({ add: ['r2'], remove: [] })
    const binding: PanelMode = { kind: 'binding' }
    expect(want(binding, 'off', ['r2'])).toEqual(none)
    expect(want(binding, 'on', ['r1'])).toEqual({ ...none, refused: 'binding' })
    expect(want(binding, 'on', ['r9'])).toEqual({ add: ['r2'], remove: [] })
    expect(want(binding, 'on', ['r2'])).toEqual(none)
    expect(want(binding, ['r3'], ['r1'])).toEqual({ ...none, refused: 'binding' })
    expect(want(binding, [], ['r1'])).toEqual(none)
    const drop: PanelMode = { kind: 'drop' }
    expect(want(drop, 'on', [])).toEqual(none)
    expect(want(drop, 'off', ['r2'])).toEqual({ add: [], remove: ['r2'] })
    expect(want(drop, ['r3'], ['r1', 'r2'])).toEqual({ add: [], remove: ['r1', 'r2'] })
    for (const mode of [TOGGLE, { kind: 'reversed' } as PanelMode]) {
      expect(want(mode, panel, ['r9'])).toEqual({ add: panel, remove: [] })
      expect(want(mode, 'off', ['r2'])).toEqual({ add: [], remove: ['r2'] })
    }
    const all: Press = { id: 'p', deps: [], want: panel, at: 0 }
    expect(reconcile([all], [], panel, '', unique)).toEqual({ ...none, refused: 'too_many' })
  })
})

describe("the crate's per-mode want vectors", () => {
  test('every case gives the same change here', () => {
    const cases = vectors('wants').cases as {
      case: string
      mode: PanelMode
      want: 'on' | 'off' | number[]
      held: number[]
      panel: number[]
      role: number
      out: Change
    }[]
    expect(cases.length).toBe(40)
    const ids = (xs: number[]) => xs.map(String)
    for (const c of cases) {
      const want: Want = Array.isArray(c.want) ? ids(c.want) : c.want
      const out = { ...c.out, add: ids(c.out.add as unknown as number[]) }
      out.remove = ids(c.out.remove as unknown as number[])
      const args = [ids(c.held), ids(c.panel), String(c.role), c.mode] as const
      expect([c.case, applyWant(want, ...args)]).toEqual([c.case, out])
      const press: Press = { id: 'p', deps: [], want, at: 0 }
      expect([c.case, reconcile([press], ...args)]).toEqual([c.case, out])
    }
  })
})

describe('runners reconcile to the latest want in any delivery order, without flapping', () => {
  type Who = 'A' | 'B'
  interface Op {
    add: boolean
    cause: string
  }
  const panel = ['r1', 'r2', 'r3']
  const presses: Press[] = [
    { id: 'p1', deps: [], want: 'on', at: 0 },
    { id: 'p2', deps: ['p1'], want: 'off', at: 0 },
  ]
  const deliveries = perms<[Who, number]>([
    ['A', 0],
    ['A', 1],
    ['B', 0],
    ['B', 1],
  ])

  test('every interleaving ends at the latest want, with a bounded number of ops', () => {
    let runs = 0
    for (const o of deliveries)
      for (const opsAtOnce of [true, false]) {
        let held: string[] = []
        let opCount = 0
        const seen: Record<Who, Press[]> = { A: [], B: [] }
        const queue: Op[] = []
        const act = (who: Who) => {
          const c = reconcile(seen[who], held, panel, 'r1', TOGGLE)
          const cause = latestPress(seen[who])?.id ?? ''
          if (c.add.length) queue.push({ add: true, cause })
          if (c.remove.length) queue.push({ add: false, cause })
        }
        const deliver = () => {
          let guard = 0
          while (queue.length) {
            guard += 1
            if (guard > 50) throw new Error('flapping')
            const op = queue.shift() as Op
            opCount += 1
            held = op.add ? ['r1'] : []
            for (const who of ['A', 'B'] as Who[]) if (counters(seen[who], op.cause)) act(who)
          }
        }
        for (const [who, i] of o) {
          seen[who].push(presses[i])
          act(who)
          if (opsAtOnce) deliver()
        }
        deliver()
        expect(held).toEqual([])
        expect(opCount).toBeLessThanOrEqual(6)
        runs += 1
      }
    expect(runs).toBe(48)
  })

  test('a runner never counters an op caused by a press it has not seen', () => {
    expect(counters(presses, 'unknown')).toBe(false)
    expect(counters(presses, 'p2')).toBe(false)
    expect(counters(presses, 'p1')).toBe(true)
    expect(counters([], 'p1')).toBe(false)
    expect(reconcile([], ['r1'], panel, 'r1', TOGGLE)).toEqual({ add: [], remove: [] })
  })
})

describe('presses are ordered per person across devices, stable for 3 s, and capped', () => {
  test('a phone at seq 40 then a desktop at seq 12 that saw it: the desktop press is latest', () => {
    const phone: Press = { id: 'ev-phone-40', deps: [], want: 'on', at: 0 }
    const desktop: Press = { id: 'ev-desk-12', deps: ['ev-phone-40'], want: 'off', at: 10 }
    for (const ps of [
      [phone, desktop],
      [desktop, phone],
    ])
      expect(latestPress(ps)?.id).toBe('ev-desk-12')
  })

  test('the latest press vectors', () => {
    const cases = vectors('panels').cases.filter(c => c.op === 'latest') as {
      presses: Omit<Press, 'at'>[]
      latest: string
    }[]
    expect(cases.length).toBe(2)
    for (const v of cases)
      expect(latestPress(v.presses.map(p => ({ ...p, at: 0 })))?.id).toBe(v.latest)
  })

  test('concurrent presses from two devices resolve the same on every runner', () => {
    const a: Press = { id: 'ev-a', deps: [], want: 'on', at: 0 }
    const b: Press = { id: 'ev-b', deps: [], want: 'off', at: 0 }
    expect(latestPress([a, b])?.id).toBe(latestPress([b, a])?.id)
    expect(latestPress([a, b])?.id).toBe('ev-b')
    expect(latestPress([])).toBeNull()
  })

  test('a want is acted on only once it has been the latest for 3 s', () => {
    const p: Press = { id: 'x', deps: [], want: 'on', at: 1000 }
    expect(STABLE_MS).toBe(3000)
    expect(stable([p], 3999)).toBe(false)
    expect(stable([p], 4000)).toBe(true)
    expect(stable([], 4000)).toBe(false)
    const later: Press = { id: 'y', deps: ['x'], want: 'off', at: 3500 }
    expect(stable([p, later], 4000)).toBe(false)
    expect(stable([p, later], 6500)).toBe(true)
  })

  test('the 11th role op in an hour for one member and panel is refused', () => {
    const cap = opCap()
    expect(OPS_PER_HOUR).toBe(10)
    for (let i = 0; i < 10; i += 1) expect(cap.take('bob', 'panel1', i * 1000)).toBe(true)
    expect(cap.take('bob', 'panel1', 11_000)).toBe(false)
    expect(cap.take('carol', 'panel1', 11_000)).toBe(true)
    expect(cap.take('bob', 'panel2', 11_000)).toBe(true)
    expect(cap.take('bob', 'panel1', 3_600_000 + 1)).toBe(true)
  })

  test('a member and panel whose names run together are counted apart', () => {
    const cap = opCap()
    for (let i = 0; i < 10; i += 1) expect(cap.take('a:b', 'c', i)).toBe(true)
    expect(cap.take('a', 'b:c', 20)).toBe(true)
  })

  test('presses older than 24 h are ignored', () => {
    expect(PRESS_MAX_AGE_MS).toBe(86_400_000)
    expect(pressLive(1000, 1000 + 86_400_000)).toBe(true)
    expect(pressLive(1000, 1001 + 86_400_000)).toBe(false)
    expect(pressLive(5000, 1000)).toBe(true)
  })

  test('half of the ACL rate stays free for moderation', () => {
    expect(roomForPanelOp(0, 20)).toBe(true)
    expect(roomForPanelOp(9, 20)).toBe(true)
    expect(roomForPanelOp(10, 20)).toBe(false)
    expect(roomForPanelOp(0, 1)).toBe(false)
    expect(roomForPanelOp(0, 2)).toBe(true)
    expect(roomForPanelOp(0, 0)).toBe(false)
  })
})

describe('welcome and leave messages, rendered locally', () => {
  const doc = (
    id: string,
    trigger: string,
    over: Record<string, unknown> = {},
    held: Partial<Held<AutoDoc>> = {}
  ): Held<AutoDoc> => ({
    doc: {
      id,
      v: 1,
      gone: false,
      body: {
        name: id === 'w' ? 'Welcome' : 'Leave',
        trigger: { type: trigger },
        actions: [
          { aid: 'a1', type: 'send_message', channel: { channel: 'c-hello' }, text: 'Hi {member}' },
        ],
        ...over,
      },
    },
    event: `ev-${id}`,
    author: 'dave',
    channel: 'c-lobby',
    ...held,
  })
  const docs = [doc('w', 'member_admitted'), doc('l', 'member_left')]
  const render = (template: string) => template.replace('{member}', 'bob')
  const rows = (
    t: 'join' | 'assign' | 'leave' | 'kick' | 'ban',
    memberRole: string | null,
    role?: string,
    autos = docs
  ) => localRows({ t, member: 'bob', ...(role ? { role } : {}) }, autos, { memberRole, render })

  test('a join renders the welcome when onboarding is off', () => {
    expect(rows('join', null)).toEqual([
      {
        auto: 'w',
        kind: 'welcome',
        name: 'Welcome',
        channel: 'c-hello',
        text: 'Hi bob',
        savedBy: 'dave',
      },
    ])
  })

  test('with onboarding on, the Member assign renders it and the join does not', () => {
    expect(rows('join', 'member')).toEqual([])
    expect(rows('assign', 'member', 'member').map(r => r.auto)).toEqual(['w'])
    expect(rows('assign', 'member', 'gamer')).toEqual([])
    expect(rows('assign', null, 'member')).toEqual([])
  })

  test("the wizard's grandfathering assigns and repeated assigns render no welcome", () => {
    const ctx = { memberRole: 'member', render }
    const assign = (extra: Partial<MemberEvent>) =>
      localRows({ t: 'assign', member: 'old1', role: 'member', ...extra }, docs, ctx)
    expect(assign({ grandfathered: true })).toEqual([])
    expect(assign({ held: true })).toEqual([])
    expect(assign({}).map(r => r.auto)).toEqual(['w'])
    expect(assign({ grandfathered: undefined, held: false }).map(r => r.auto)).toEqual(['w'])
  })

  test('a leave message renders only for the leaves its trigger names', () => {
    const facts = { leave: [false, false], kick: [true, false], ban: [false, true] } as const
    const picks = [undefined, true, false]
    let checked = 0
    for (const kicked of picks)
      for (const banned of picks)
        for (const t of ['leave', 'kick', 'ban'] as const) {
          const d = doc('l', 'member_left')
          d.doc.body.trigger = { type: 'member_left', kicked, banned }
          const [k, b] = facts[t]
          const fires =
            (kicked === undefined || kicked === k) && (banned === undefined || banned === b)
          expect([kicked, banned, t, rows(t, null, undefined, [d]).length]).toEqual([
            kicked,
            banned,
            t,
            fires ? 1 : 0,
          ])
          checked += 1
        }
    expect(checked).toBe(27)
    const own = doc('l', 'member_left', { trigger: { type: 'member_left', kicked: false } })
    expect(rows('leave', null, undefined, [own]).length).toBe(1)
    expect(rows('kick', null, undefined, [own]).length).toBe(0)
    for (const bad of ['yes', 1, {}]) {
      const odd = doc('l', 'member_left', { trigger: { type: 'member_left', banned: bad } })
      for (const t of ['leave', 'kick', 'ban'] as const)
        expect(rows(t, null, undefined, [odd])).toEqual([])
    }
    const nulls = doc('l', 'member_left', {
      trigger: { type: 'member_left', kicked: null, banned: null },
    })
    for (const t of ['leave', 'kick', 'ban'] as const)
      expect(rows(t, null, undefined, [nulls]).length).toBe(1)
  })

  test('leave, kick and ban render the leave message', () => {
    for (const t of ['leave', 'kick', 'ban'] as const)
      expect(rows(t, 'member')).toEqual([
        {
          auto: 'l',
          kind: 'leave',
          name: 'Leave',
          channel: 'c-hello',
          text: 'Hi bob',
          savedBy: 'dave',
        },
      ])
  })

  test('nothing is rendered when no doc resolves, as for an author without Manage server', () => {
    expect(rows('join', null, undefined, [])).toEqual([])
  })

  test('only a doc whose one action is a message renders; a switched-off one does not', () => {
    const two = doc('w', 'member_admitted', {
      actions: [
        { aid: 'a1', type: 'send_message', channel: { channel: 'c' }, text: 'Hi' },
        { aid: 'a2', type: 'add_role', role: 'r1' },
      ],
    })
    const role = doc('w', 'member_admitted', {
      actions: [{ aid: 'a1', type: 'add_role', role: 'r' }],
    })
    const off = doc('w', 'member_admitted', { enabled: false })
    const cond = doc('w', 'member_admitted', { conditions: [{ type: 'has_role', role: 'r' }] })
    const other = doc('w', 'message_sent')
    const noText = doc('w', 'member_admitted', {
      actions: [{ aid: 'a1', type: 'send_message', channel: { channel: 'c' } }],
    })
    for (const d of [two, role, off, cond, other, noText])
      expect(rows('join', null, undefined, [d])).toEqual([])
    const on = doc('w', 'member_admitted', { enabled: true, conditions: [] })
    expect(rows('join', null, undefined, [on]).length).toBe(1)
  })

  test('a message with no channel of its own goes where the doc was posted', () => {
    const here = doc('w', 'member_admitted', {
      actions: [{ aid: 'a1', type: 'send_message', channel: 'here', text: 'Hi' }],
    })
    expect(rows('join', null, undefined, [here])[0].channel).toBe('c-lobby')
    const bare = doc('w', 'member_admitted', {
      actions: [{ aid: 'a1', type: 'send_message', text: 'Hi' }],
    })
    expect(rows('join', null, undefined, [bare])[0].channel).toBe('c-lobby')
    const nowhere = { ...here, channel: undefined }
    expect(rows('join', null, undefined, [nowhere])).toEqual([])
    const numbered = doc('w', 'member_admitted', {
      actions: [{ aid: 'a1', type: 'send_message', channel: { channel: 7 }, text: 'Hi' }],
    })
    expect(rows('join', null, undefined, [numbered])[0].channel).toBe('c-lobby')
  })

  test('a doc without a name is shown by its id, and a failing renderer renders nothing', () => {
    const unnamed = doc('w', 'member_admitted', { name: undefined })
    expect(rows('join', null, undefined, [unnamed])[0].name).toBe('w')
    expect(
      localRows({ t: 'join', member: 'bob' }, docs, {
        memberRole: null,
        render: () => {
          throw new Error('wasm not loaded')
        },
      })
    ).toEqual([])
  })
})

describe('layering', () => {
  test('pure: the ACL rules, the docs module and what those load, and one hash package', () => {
    const files = [...importsOf('apps/web/app/lib/p2p/automation_runner.ts')].sort()
    expect(files).toEqual([
      'apps/web/app/lib/bytes.ts',
      'apps/web/app/lib/p2p/acl/rules.ts',
      'apps/web/app/lib/p2p/automation_docs.ts',
      'apps/web/app/lib/p2p/canonical.ts',
      'apps/web/app/lib/p2p/limits.ts',
      'apps/web/app/lib/perms.ts',
      'apps/web/app/lib/schema.ts',
    ])
  })
})
