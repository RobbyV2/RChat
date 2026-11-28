import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CAPS,
  type DocEvent,
  docFits,
  type Ev,
  onboardingOf,
  parseAuto,
  parseOnb,
  parsePress,
  resolveDocs,
  topoOrder,
} from '../p2p/automation_docs'
import { LIMITS } from '../p2p/content'
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

const perms = <T>(xs: T[]): T[][] =>
  xs.length <= 1
    ? [xs]
    : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r]))

const EVENT = 'A'.repeat(43)

const welcome = {
  name: 'Welcome',
  trigger: { type: 'member_admitted' },
  actions: [{ aid: 'a1', type: 'send_message', channel: { channel: 'c1' }, text: 'Hi' }],
}
const auto = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  v: 1,
  body: welcome,
  ...over,
})

describe('the deterministic topological order', () => {
  const evs: Ev[] = [
    { id: 'c', deps: ['a'] },
    { id: 'b', deps: [] },
    { id: 'a', deps: [] },
    { id: 'd', deps: ['c', 'b'] },
    { id: 'e', deps: ['missing'] },
  ]

  test('every arrival order gives the same order', () => {
    const want = topoOrder(evs)
    expect(want).toEqual(['a', 'b', 'c', 'd', 'e'])
    for (const p of perms(evs)) expect(topoOrder(p)).toEqual(want)
  })

  test('the topological order vector', () => {
    const c = vectors('runner').cases.find(c => c.case === 'topo') as {
      events: Ev[]
      order: string[]
    }
    expect(topoOrder(c.events)).toEqual(c.order)
  })

  test('an event given twice is listed once, and a cycle is left out', () => {
    expect(
      topoOrder([
        { id: 'a', deps: [] },
        { id: 'a', deps: [] },
        { id: 'b', deps: ['a', 'a'] },
      ])
    ).toEqual(['a', 'b'])
    expect(
      topoOrder([
        { id: 'x', deps: ['y'] },
        { id: 'y', deps: ['x'] },
        { id: 'z', deps: [] },
      ])
    ).toEqual(['z'])
  })

  test('ids are compared as text, not by locale', () => {
    expect(topoOrder(['b', 'B', 'a', '_', '10', '9'].map(id => ({ id, deps: [] })))).toEqual([
      '10',
      '9',
      'B',
      '_',
      'a',
      'b',
    ])
  })

  test('a long chain does not grow slowly', () => {
    const chain = Array.from({ length: 5000 }, (_, i) => ({
      id: `e${String(i).padStart(5, '0')}`,
      deps: i ? [`e${String(i - 1).padStart(5, '0')}`] : [],
    }))
    const out = topoOrder([...chain].reverse())
    expect(out.length).toBe(5000)
    expect(out[4999]).toBe('e04999')
  })

  test('many presses on one event order in linear time', () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => `e${String(i).padStart(5, '0')}`)
    const evs = [
      { id: 'root', deps: [] },
      ...[...ids].reverse().map(id => ({ id, deps: ['root'] })),
    ]
    const start = performance.now()
    const out = topoOrder(evs)
    expect(performance.now() - start).toBeLessThan(2000)
    expect(out).toEqual(['root', ...ids])
  })
})

describe('parsing', () => {
  test('an automation doc', () => {
    expect(parseAuto(auto('welcome'))).toEqual({ id: 'welcome', v: 1, body: welcome, gone: false })
    expect(parseAuto({ id: 'welcome', v: 1, gone: true })).toEqual({
      id: 'welcome',
      v: 1,
      body: {},
      gone: true,
    })
    expect(parseAuto({ ...auto('w'), later: 'field', gone: false })?.id).toBe('w')
  })

  test('a malformed known field or another version makes the doc inert', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      auto(''),
      auto('a b'),
      auto('x'.repeat(65)),
      auto('w', { v: 2 }),
      auto('w', { v: '1' }),
      auto('w', { gone: 'yes' }),
      auto('w', { body: null }),
      auto('w', { body: [] }),
      auto('w', { body: { ...welcome, trigger: 'member_admitted' } }),
      auto('w', { body: { ...welcome, trigger: {} } }),
      auto('w', { body: { ...welcome, actions: {} } }),
      auto('w', { body: { ...welcome, actions: [{ aid: 'a1' }] } }),
      auto('w', { body: { ...welcome, actions: ['kick'] } }),
      auto('w', { body: { ...welcome, conditions: {} } }),
      auto('w', { body: { ...welcome, name: 7 } }),
      { id: 7, v: 1, body: welcome },
    ])
      expect(parseAuto(bad)).toBeNull()
  })

  test('an onboarding part', () => {
    expect(parseOnb({ part: 'rules', v: 1, body: { items: [] }, extra: 1 })).toEqual({
      part: 'rules',
      v: 1,
      body: { items: [] },
    })
    for (const bad of [
      null,
      {},
      { part: 'other', v: 1, body: {} },
      { part: 'rules', v: 3, body: {} },
      { part: 'rules', v: 1 },
      { part: 'rules', v: 1, body: 'text' },
      { part: 'rules', v: 1, body: [] },
      { part: 'toString', v: 1, body: {} },
    ])
      expect(parseOnb(bad)).toBeNull()
  })

  test('a press carries what the presser wants', () => {
    expect(parsePress({ target: EVENT, cid: 'gamer', want: 'on' })).toEqual({
      target: EVENT,
      cid: 'gamer',
      want: 'on',
    })
    expect(parsePress({ target: EVENT, cid: 'menu', want: ['r1', 'r2'], more: 1 })?.want).toEqual([
      'r1',
      'r2',
    ])
    expect(parsePress({ target: EVENT, cid: 'menu', want: [] })?.want).toEqual([])
    for (const bad of [
      null,
      {},
      { target: 'short', cid: 'a', want: 'on' },
      { target: EVENT, cid: '', want: 'on' },
      { target: EVENT, cid: 'x'.repeat(33), want: 'on' },
      { target: EVENT, cid: 'a', want: 'toggle' },
      { target: EVENT, cid: 'a', want: [1] },
      { target: EVENT, cid: 'a', want: ['r', 'r'] },
      { target: EVENT, cid: 'a', want: Array.from({ length: 26 }, (_, i) => `r${i}`) },
      { target: EVENT, cid: 'a' },
    ])
      expect(parsePress(bad)).toBeNull()
  })
})

describe('doc resolution', () => {
  const ev = (
    id: string,
    deps: string[],
    author: string,
    content: unknown,
    kind = 'auto'
  ): DocEvent => ({ id, deps, author, kind, content, channel: 'lobby' })
  const named = (name: string) => auto('w', { body: { ...welcome, name } })
  const staff = (...who: string[]) => {
    const set = new Set(who)
    return (author: string) => set.has(author)
  }
  const names = (events: DocEvent[], may: (a: string) => boolean) =>
    resolveDocs(events, may).autos.map(a => `${a.doc.id}:${String(a.doc.body.name)}@${a.event}`)

  test('the newest doc in causal order wins, whatever order the events arrive in', () => {
    const events = [
      ev('e1', [], 'dave', named('first')),
      ev('e2', ['e1'], 'erin', named('second')),
      ev('e3', ['e2'], 'dave', named('third')),
    ]
    for (const p of perms(events)) expect(names(p, staff('dave', 'erin'))).toEqual(['w:third@e3'])
  })

  test("the author's own time never decides: concurrent docs resolve by event id", () => {
    const events = [ev('zz', [], 'dave', named('late id')), ev('aa', [], 'erin', named('early id'))]
    for (const p of perms(events)) expect(names(p, staff('dave', 'erin'))).toEqual(['w:late id@zz'])
  })

  test('a doc whose author lost Manage server stops counting, and the earlier one applies', () => {
    const events = [ev('e1', [], 'dave', named('first')), ev('e2', ['e1'], 'erin', named('second'))]
    expect(names(events, staff('dave', 'erin'))).toEqual(['w:second@e2'])
    expect(names(events, staff('dave'))).toEqual(['w:first@e1'])
    expect(names(events, staff())).toEqual([])
  })

  test('a doc that is not valid is passed over, never a reason to drop the earlier one', () => {
    const events = [
      ev('e1', [], 'dave', named('first')),
      ev('e2', ['e1'], 'dave', { id: 'w', v: 2, body: welcome }),
      ev('e3', ['e2'], 'dave', { id: 'w', v: 1, body: 'broken' }),
      ev('e4', ['e3'], 'dave', named('msg'), 'msg'),
    ]
    expect(names(events, staff('dave'))).toEqual(['w:first@e1'])
  })

  test('a removal by a manager removes; one by someone else does not', () => {
    const events = [
      ev('e1', [], 'dave', named('first')),
      ev('e2', ['e1'], 'mallory', { id: 'w', v: 1, gone: true }),
    ]
    expect(names(events, staff('dave'))).toEqual(['w:first@e1'])
    expect(names(events, staff('dave', 'mallory'))).toEqual([])
    const back = [...events, ev('e3', ['e2'], 'dave', named('again'))]
    expect(names(back, staff('dave', 'mallory'))).toEqual(['w:again@e3'])
  })

  test('each id resolves by itself, and the result keeps who saved it and where', () => {
    const events = [
      ev('e1', [], 'dave', auto('b')),
      ev('e2', ['e1'], 'erin', auto('a')),
      ev('e3', ['e2'], 'erin', auto('constructor')),
    ]
    const { autos } = resolveDocs(events, staff('dave', 'erin'))
    expect(autos.map(a => [a.doc.id, a.author, a.event, a.channel])).toEqual([
      ['a', 'erin', 'e2', 'lobby'],
      ['b', 'dave', 'e1', 'lobby'],
      ['constructor', 'erin', 'e3', 'lobby'],
    ])
  })

  test('at most 50 automations count, the same 50 on every device', () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      ev(`e${String(i).padStart(2, '0')}`, [], 'dave', auto(`a${String(59 - i).padStart(2, '0')}`))
    )
    const ids = resolveDocs(events, staff('dave')).autos.map(a => a.doc.id)
    expect(CAPS.automations).toBe(50)
    expect(ids.length).toBe(50)
    expect([ids[0], ids[49]]).toEqual(['a00', 'a49'])
    expect(resolveDocs([...events].reverse(), staff('dave')).autos.map(a => a.doc.id)).toEqual(ids)
  })

  test('a doc over a cap is passed over: keywords per list, regexes, nested conditions', () => {
    const guard = (conditions: unknown[]) =>
      auto('g', {
        body: {
          name: 'Guard',
          trigger: { type: 'message_sent', guard: true },
          conditions,
          actions: [{ aid: 'a1', type: 'kick' }],
        },
      })
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`)
    const kept = (conditions: unknown[]) =>
      resolveDocs([ev('e1', [], 'dave', guard(conditions))], staff('dave')).autos.length === 1
    expect(kept([{ type: 'keywords', list: words(250), allow: words(250) }])).toBe(true)
    expect(kept([{ type: 'keywords', list: words(251) }])).toBe(false)
    expect(kept([{ type: 'keywords', list: [], allow: words(251) }])).toBe(false)
    expect(kept([{ type: 'regex', patterns: words(5) }])).toBe(true)
    expect(kept([{ type: 'regex', patterns: words(6) }])).toBe(false)
    expect(
      kept([
        { type: 'regex', patterns: words(3) },
        { type: 'not', of: { type: 'regex', patterns: words(3) } },
      ])
    ).toBe(false)
    expect(kept([{ type: 'any', of: [{ type: 'keywords', list: words(251) }] }])).toBe(false)
    expect(kept([{ type: 'keywords', list: 'all' }])).toBe(false)
    expect(kept([{ type: 'regex', patterns: {} }])).toBe(false)
  })

  test("a name condition's list is capped like a keyword list", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`)
    const named = (conditions: unknown[]) =>
      auto('n', {
        body: {
          name: 'Names',
          trigger: { type: 'member_joined', guard: true },
          conditions,
          actions: [{ aid: 'a1', type: 'kick' }],
        },
      })
    const kept = (conditions: unknown[]) =>
      resolveDocs([ev('e1', [], 'dave', named(conditions))], staff('dave')).autos.length === 1
    expect(kept([{ type: 'name', list: words(250) }])).toBe(true)
    expect(kept([{ type: 'name', list: words(251) }])).toBe(false)
    expect(kept([{ type: 'not', of: { type: 'name', list: words(251) } }])).toBe(false)
    expect(kept([{ type: 'name', list: 'all' }])).toBe(false)
  })

  test('the profanity preset is never part of a resolved doc', () => {
    const doc = auto('g', {
      body: {
        name: 'Words',
        trigger: { type: 'message_sent', guard: true },
        conditions: [
          { type: 'not', of: { type: 'is_staff' } },
          { type: 'keywords', list: ['x'], allow: [], profanity_preset: true },
          { type: 'any', of: [{ type: 'keywords', list: [], profanity_preset: true }] },
        ],
        actions: [{ aid: 'a1', type: 'kick' }],
      },
    })
    const [got] = resolveDocs([ev('e1', [], 'dave', doc)], staff('dave')).autos
    expect(got.doc.body.conditions).toEqual([
      { type: 'not', of: { type: 'is_staff' } },
      { type: 'keywords', list: ['x'], allow: [] },
      { type: 'any', of: [{ type: 'keywords', list: [] }] },
    ])
    expect(JSON.stringify(doc)).toContain('profanity_preset')
  })
})

describe('onboarding parts', () => {
  const part = (id: string, deps: string[], author: string, name: string, body: unknown) => ({
    id,
    deps,
    author,
    kind: 'onb',
    content: { part: name, v: 1, body },
  })
  const all = () => true

  test('each part resolves by itself and they merge into one config', () => {
    const events = [
      part('e1', [], 'dave', 'rules', { intro: 'old', items: [] }),
      part('e2', ['e1'], 'erin', 'rules', { intro: 'new', items: [{ id: 'r1', text: 'Be kind' }] }),
      part('e3', ['e1'], 'dave', 'requirements', { approval: true }),
      part('e4', ['e3'], 'dave', 'welcome', { description: 'Hello' }),
    ]
    const docs = resolveDocs(events, all)
    expect(onboardingOf(docs)).toEqual({
      requirements: { approval: true },
      rules: { intro: 'new', items: [{ id: 'r1', text: 'Be kind' }] },
      questions: null,
      welcome: { description: 'Hello' },
      savedBy: ['dave', 'erin'],
    })
    expect(onboardingOf(resolveDocs(events, a => a === 'dave')).rules).toEqual({
      intro: 'old',
      items: [],
    })
    expect(onboardingOf(resolveDocs([], all))).toEqual({
      requirements: null,
      rules: null,
      questions: null,
      welcome: null,
      savedBy: [],
    })
  })

  test('parts over their caps are passed over: 10 rules, 10 questions of 10 choices', () => {
    const rules = (n: number) => ({
      items: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: 't' })),
    })
    const questions = (n: number, choices: number) => ({
      items: Array.from({ length: n }, (_, i) => ({
        id: `q${i}`,
        options: Array.from({ length: choices }, (_, j) => ({ id: `c${j}` })),
      })),
    })
    const got = (name: 'rules' | 'questions', body: unknown) =>
      onboardingOf(resolveDocs([part('e1', [], 'dave', name, body)], all))[name] !== null
    expect(got('rules', rules(10))).toBe(true)
    expect(got('rules', rules(11))).toBe(false)
    expect(got('rules', { items: 'many' })).toBe(false)
    expect(got('questions', questions(10, 10))).toBe(true)
    expect(got('questions', questions(11, 1))).toBe(false)
    expect(got('questions', questions(1, 11))).toBe(false)
    expect(got('questions', { items: [{ id: 'q', options: 'x' }] })).toBe(false)
    expect(got('questions', { items: ['q'] })).toBe(false)
  })
})

describe('size and layering', () => {
  test('a doc fits in 16 KiB of content', () => {
    expect(CAPS.bytes).toBe(LIMITS.content)
    expect(docFits(auto('w'))).toBe(true)
    expect(docFits(auto('w', { body: { ...welcome, name: 'x'.repeat(17_000) } }))).toBe(false)
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(docFits(loop)).toBe(false)
  })

  test('the module is pure: it loads only the canonical codec, the schema and byte helpers', () => {
    expect([...importsOf('apps/web/app/lib/p2p/automation_docs.ts')].sort()).toEqual([
      'apps/web/app/lib/bytes.ts',
      'apps/web/app/lib/p2p/canonical.ts',
      'apps/web/app/lib/schema.ts',
    ])
  })
})
