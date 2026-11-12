import { describe, expect, test } from 'bun:test'
import { WHEN_LIMITS, checkWhen, evalWhen, patternsOf, type When } from '../plugins/when'

const never = () => {
  throw new Error('the matcher was called')
}
const ctx = {
  target: { kind: 'message', id: 'm1', author: 'u1', reply_to: null, pinned: false, count: 3 },
  me: { id: 'u1' },
  place: { kind: 'channel', tags: ['a', 'b'] },
}
const on = (w: When) => evalWhen(w, ctx, never)

describe('when: comparing', () => {
  test('eq compares a path with a literal or with another path', () => {
    expect(on({ eq: ['target.kind', 'message'] })).toBe(true)
    expect(on({ eq: ['target.kind', 'dm'] })).toBe(false)
    expect(on({ eq: ['target.count', 3] })).toBe(true)
    expect(on({ eq: ['target.count', '3'] })).toBe(false)
    expect(on({ eq: ['target.pinned', false] })).toBe(true)
    expect(on({ eq: ['target.author', { path: 'me.id' }] })).toBe(true)
    expect(on({ eq: ['target.id', { path: 'me.id' }] })).toBe(false)
    expect(on({ eq: ['target.reply_to', null] })).toBe(true)
  })

  test('a path that leads nowhere equals nothing, not even another missing path', () => {
    expect(on({ eq: ['target.nope', null] })).toBe(false)
    expect(on({ eq: ['target.nope', { path: 'me.nope' }] })).toBe(false)
    expect(on({ eq: ['target.kind.length', 7] })).toBe(false)
    expect(on({ eq: ['nope.kind', 'message'] })).toBe(false)
  })

  test('objects and lists are never equal to anything', () => {
    expect(on({ eq: ['target', { path: 'target' }] })).toBe(false)
    expect(on({ eq: ['place.tags', { path: 'place.tags' }] })).toBe(false)
  })

  test('in looks a value up in a list of literals', () => {
    expect(on({ in: ['place.kind', ['channel', 'dm']] })).toBe(true)
    expect(on({ in: ['place.kind', ['server']] })).toBe(false)
    expect(on({ in: ['target.count', [1, 2, 3]] })).toBe(true)
    expect(on({ in: ['target.reply_to', [null]] })).toBe(true)
    expect(on({ in: ['target.nope', [null]] })).toBe(false)
    expect(on({ in: ['place.kind', []] })).toBe(false)
  })

  test('has is true for a value that is there and not null', () => {
    expect(on({ has: 'target.id' })).toBe(true)
    expect(on({ has: 'target.pinned' })).toBe(true)
    expect(on({ has: 'place.tags' })).toBe(true)
    expect(on({ has: 'place.tags.1' })).toBe(true)
    expect(on({ has: 'place.tags.2' })).toBe(false)
    expect(on({ has: 'target.reply_to' })).toBe(false)
    expect(on({ has: 'target.nope' })).toBe(false)
  })
})

describe('when: combining', () => {
  const yes: When = { has: 'target.id' }
  const no: When = { has: 'target.nope' }

  test('all, any and not', () => {
    expect(on({ all: [yes, yes] })).toBe(true)
    expect(on({ all: [yes, no] })).toBe(false)
    expect(on({ any: [no, yes] })).toBe(true)
    expect(on({ any: [no, no] })).toBe(false)
    expect(on({ not: no })).toBe(true)
    expect(on({ not: yes })).toBe(false)
    expect(on({ all: [] })).toBe(true)
    expect(on({ any: [] })).toBe(false)
  })

  test('nested', () => {
    const w: When = {
      all: [
        { eq: ['target.kind', 'message'] },
        { any: [{ eq: ['target.author', { path: 'me.id' }] }, { eq: ['place.kind', 'dm'] }] },
        { not: { eq: ['target.pinned', true] } },
      ],
    }
    expect(on(w)).toBe(true)
    expect(evalWhen(w, { ...ctx, me: { id: 'u2' } }, never)).toBe(false)
  })
})

describe('when: only what the context itself holds', () => {
  test('inherited names are not values', () => {
    for (const path of [
      'target.constructor',
      'target.toString',
      'target.__proto__',
      'place.tags.length',
    ])
      expect(on({ has: path })).toBe(false)
    expect(on({ eq: ['target.constructor.name', 'Object'] })).toBe(false)
    expect(on({ has: 'place.tags.map' })).toBe(false)
  })

  test('a context that is not an object has nothing', () => {
    for (const bad of [null, undefined, 'x', 7])
      expect(evalWhen({ has: 'target' }, bad, never)).toBe(false)
  })
})

describe('when: match', () => {
  test('goes to the matcher it was given, with the pattern and the text', () => {
    const seen: [string, string][] = []
    const matcher = (pattern: string, text: string) => {
      seen.push([pattern, text])
      return text.startsWith('mess')
    }
    expect(evalWhen({ match: ['target.kind', '^mess'] }, ctx, matcher)).toBe(true)
    expect(evalWhen({ match: ['place.kind', '^mess'] }, ctx, matcher)).toBe(false)
    expect(seen).toEqual([
      ['^mess', 'message'],
      ['^mess', 'channel'],
    ])
  })

  test("the pattern never reaches the page's own RegExp", () => {
    const calls: string[] = []
    const w: When = { match: ['target.kind', '(('] }
    expect(checkWhen(w)).toEqual([])
    expect(evalWhen(w, ctx, p => calls.push(p) > 0)).toBe(true)
    expect(calls).toEqual(['(('])
  })

  test('only text is matched, at most 64 KiB of it', () => {
    expect(on({ match: ['target.count', '3'] })).toBe(false)
    expect(on({ match: ['target.nope', '.'] })).toBe(false)
    expect(on({ match: ['target', '.'] })).toBe(false)
    let calls = 0
    const yes = () => {
      calls += 1
      return true
    }
    const long = { target: { text: 'a'.repeat(WHEN_LIMITS.text + 1) } }
    expect(evalWhen({ match: ['target.text', 'a'] }, long, yes)).toBe(false)
    expect(evalWhen({ match: ['target.count', '3'] }, ctx, yes)).toBe(false)
    expect(calls).toBe(0)
    const fits = { target: { text: 'a'.repeat(WHEN_LIMITS.text) } }
    expect(evalWhen({ match: ['target.text', 'a'] }, fits, () => true)).toBe(true)
  })

  test('a matcher that fails counts as no match', () => {
    const boom = () => {
      throw new Error('bad pattern')
    }
    expect(evalWhen({ match: ['target.kind', 'x'] }, ctx, boom)).toBe(false)
    expect(evalWhen({ not: { match: ['target.kind', 'x'] } }, ctx, boom)).toBe(true)
  })

  test('the patterns of a condition, for the matcher caps', () => {
    const w: When = {
      all: [
        { match: ['target.kind', 'a+'] },
        { not: { any: [{ match: ['place.kind', 'b'] }, { has: 'me.id' }] } },
        { match: ['target.id', 'a+'] },
      ],
    }
    expect(patternsOf(w)).toEqual(['a+', 'b', 'a+'])
    expect(patternsOf({ has: 'x' })).toEqual([])
  })
})

describe('when: checking a condition from a plugin', () => {
  const deep = (n: number): unknown => (n === 0 ? { has: 'a' } : { not: deep(n - 1) })

  test('well-formed conditions pass', () => {
    for (const w of [
      { has: 'target.id' },
      { eq: ['a.b_c.0', 'x'] },
      { eq: ['a', { path: 'b.c' }] },
      { eq: ['a', null] },
      { in: ['a', ['x', 1, true, null]] },
      { match: ['a', '^x$'] },
      { all: [] },
      { any: [{ not: { has: 'a' } }] },
      deep(WHEN_LIMITS.depth - 1),
    ])
      expect(checkWhen(w)).toEqual([])
  })

  test('anything else is refused with what is wrong', () => {
    const cases: [unknown, string][] = [
      [null, 'not a condition'],
      ['has', 'not a condition'],
      [[], 'not a condition'],
      [{}, 'needs one operator'],
      [{ has: 'a', not: { has: 'b' } }, 'needs one operator'],
      [{ equals: ['a', 1] }, 'unknown operator equals'],
      [{ has: 7 }, 'has: bad path'],
      [{ has: '' }, 'has: bad path'],
      [{ has: 'a..b' }, 'has: bad path'],
      [{ has: 'a.b-c' }, 'has: bad path'],
      [{ has: 'a.__proto__' }, 'has: bad path'],
      [{ has: 'constructor' }, 'has: bad path'],
      [{ has: 'a.prototype.b' }, 'has: bad path'],
      [{ has: 'a'.repeat(WHEN_LIMITS.path + 1) }, 'has: bad path'],
      [{ eq: ['a'] }, 'eq: needs a path and a value'],
      [{ eq: ['a', 1, 2] }, 'eq: needs a path and a value'],
      [{ eq: 'a' }, 'eq: needs a path and a value'],
      [{ eq: ['a', undefined] }, 'eq: bad value'],
      [{ eq: ['a', { path: 'b', more: 1 }] }, 'eq: bad value'],
      [{ eq: ['a', { path: '__proto__' }] }, 'eq: bad path'],
      [{ eq: ['a', ['x']] }, 'eq: bad value'],
      [{ eq: ['a', NaN] }, 'eq: bad value'],
      [{ eq: ['a', 'x'.repeat(WHEN_LIMITS.pattern + 1)] }, 'eq: bad value'],
      [{ in: ['a', 'x'] }, 'in: needs a path and a list'],
      [{ in: ['a', [{}]] }, 'in: bad value'],
      [{ in: ['a', Array(WHEN_LIMITS.list + 1).fill(1)] }, 'in: too many values'],
      [{ match: ['a'] }, 'match: needs a path and a pattern'],
      [{ match: ['a', 7] }, 'match: needs a path and a pattern'],
      [{ match: ['a', ''] }, 'match: bad pattern'],
      [{ match: ['a', 'x'.repeat(WHEN_LIMITS.pattern + 1)] }, 'match: bad pattern'],
      [{ all: { has: 'a' } }, 'all: needs a list'],
      [{ any: 'x' }, 'any: needs a list'],
      [{ not: [{ has: 'a' }] }, 'not a condition'],
      [{ all: [{ has: 'a' }, { nope: 1 }] }, 'unknown operator nope'],
      [deep(WHEN_LIMITS.depth), 'too deep'],
    ]
    for (const [w, want] of cases) {
      const got = checkWhen(w)
      if (got[0] !== want)
        throw new Error(`${JSON.stringify(w)?.slice(0, 60)}: ${got[0]} vs ${want}`)
    }
  })

  test('at most 64 conditions in one', () => {
    const many = (n: number) => ({ all: Array.from({ length: n }, () => ({ has: 'a' })) })
    expect(checkWhen(many(WHEN_LIMITS.nodes - 1))).toEqual([])
    expect(checkWhen(many(WHEN_LIMITS.nodes))).toEqual(['too many conditions'])
  })

  test('a list is refused by its length before it is read, and a hole is not a condition', () => {
    const huge: unknown[] = []
    huge.length = 2 ** 32 - 1
    const holes = (...items: unknown[]) => {
      const list = [...items]
      list.length += 2
      return list
    }
    for (const [w, want] of [
      [{ all: huge }, ['too many conditions']],
      [{ any: huge }, ['too many conditions']],
      [{ not: { all: [{ has: 'a' }, { any: huge }] } }, ['too many conditions']],
      [{ in: ['a', huge] }, ['in: too many values']],
      [{ any: holes({ has: 'a' }) }, ['not a condition', 'not a condition']],
      [{ in: ['a', holes('x')] }, ['in: bad value']],
    ] as const) {
      const start = performance.now()
      expect(checkWhen(w)).toEqual([...want])
      expect(performance.now() - start).toBeLessThan(1000)
    }
    const many = (n: number) => ({ any: Array.from({ length: n }, () => null) })
    expect(checkWhen(many(WHEN_LIMITS.nodes - 1))).toHaveLength(WHEN_LIMITS.errors)
    expect(checkWhen(many(WHEN_LIMITS.nodes))).toEqual(['too many conditions'])
  })

  test('only plain data is read: a typed array is not a condition, not walked', () => {
    const bytes = new Uint8Array(10_000_000)
    for (const [w, want] of [
      [bytes, 'not a condition'],
      [{ not: bytes }, 'not a condition'],
      [{ eq: ['a', bytes] }, 'eq: bad value'],
      [{ any: [new Map([['has', 'a']])] }, 'not a condition'],
    ] as const) {
      const start = performance.now()
      expect(checkWhen(w)).toEqual([want])
      expect(performance.now() - start).toBeLessThan(1000)
    }
    expect(checkWhen(Object.assign(Object.create(null), { has: 'a' }))).toEqual([])
    expect(checkWhen({ eq: ['a', Object.assign(Object.create(null), { path: 'b' })] })).toEqual([])
  })

  test('the limits', () => {
    expect(WHEN_LIMITS).toEqual({
      depth: 8,
      nodes: 64,
      path: 128,
      list: 64,
      pattern: 1024,
      text: 65536,
      errors: 20,
    })
  })

  test('a condition that was never checked is cut off at 64 conditions', () => {
    const yes = { has: 'target.id' }
    const many = (n: number) => ({ all: Array.from({ length: n }, () => yes) }) as When
    expect(evalWhen(many(WHEN_LIMITS.nodes - 1), ctx, never)).toBe(true)
    expect(evalWhen(many(WHEN_LIMITS.nodes), ctx, never)).toBe(false)
    expect(evalWhen(many(1_000_000), ctx, never)).toBe(false)
    // Thirty branches at each of seven levels, built from shared parts: 30^7 conditions to read.
    let wide: unknown = yes
    for (let level = 0; level < 7; level++) wide = { all: Array.from({ length: 30 }, () => wide) }
    expect(evalWhen(wide as When, ctx, never)).toBe(false)
    expect(evalWhen({ not: many(WHEN_LIMITS.nodes) }, ctx, never)).toBe(false)
    const huge: unknown[] = []
    huge.length = 2 ** 32 - 1
    const start = performance.now()
    for (const w of [{ in: ['target.kind', huge] }, { any: huge }, new Uint8Array(10_000_000)])
      expect(evalWhen(w as unknown as When, ctx, never)).toBe(false)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  test('a condition that was never checked still evaluates without throwing', () => {
    for (const w of [
      null,
      {},
      { nope: 1 },
      { has: 7 },
      { eq: 'a' },
      { in: ['a', 'x'] },
      { all: 'x' },
      deep(500),
    ])
      expect(evalWhen(w as When, ctx, never)).toBe(false)
    expect(evalWhen({ not: null } as unknown as When, ctx, never)).toBe(false)
  })
})
