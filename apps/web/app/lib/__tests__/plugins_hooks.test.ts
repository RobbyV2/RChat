import { testClock, type ManualTime } from './helpers/test_clock'
import { describe, expect, test, beforeEach } from 'bun:test'
import {
  CANCEL,
  Late,
  runChain,
  runChainAsync,
  type AsyncHandler,
  type Handler,
} from '../plugins/hooks'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

const isStr = (v: unknown): v is string => typeof v === 'string'
const h = (
  plugin: string,
  kind: Handler<string>['kind'],
  fn: Handler<string>['fn'],
  priority = 0,
  installed = 0
): Handler<string> => ({ plugin, kind, fn, priority, installed })

describe('hook chains', () => {
  const original = (s: string) => `[${s}]`

  test('no handlers runs the original', () => {
    const out = runChain([], 'x', original, isStr)
    expect(out).toEqual({ output: '[x]', strikes: [], conflicts: [] })
  })

  test('before by priority then install order, after likewise', () => {
    const out = runChain(
      [
        h('a', 'before', s => s + 'a', 0, 1),
        h('b', 'before', s => s + 'b', 5, 2),
        h('c', 'before', s => s + 'c', 0, 0),
        h('d', 'after', s => s + 'd', 0, 0),
        h('e', 'after', s => s + 'e', 9, 1),
      ],
      'x',
      original,
      isStr
    )
    expect(out.output).toBe('[xbca]ed')
  })

  test('one replace wins; the others are conflicts', () => {
    const out = runChain(
      [
        h('low', 'replace', s => `low(${s})`, 0, 0),
        h('high', 'replace', s => `high(${s})`, 10, 1),
        h('tie', 'replace', s => `tie(${s})`, 10, 2),
      ],
      'x',
      original,
      isStr
    )
    expect(out.output).toBe('high(x)')
    expect(out.conflicts).toEqual([
      ['high', 'tie'],
      ['high', 'low'],
    ])
  })

  test('around wraps outermost first and may short-circuit', () => {
    const out = runChain(
      [
        h('outer', 'around', (s, next) => `o(${next!(s)})`, 5),
        h('inner', 'around', (s, next) => `i(${next!(s)})`, 0),
      ],
      'x',
      original,
      isStr
    )
    expect(out.output).toBe('o(i([x]))')
    const short = runChain([h('stop', 'around', () => 'stopped')], 'x', original, isStr)
    expect(short.output).toBe('stopped')
  })

  test('a throwing or invalid handler is skipped with a strike, and next runs once', () => {
    let calls = 0
    const counted = (s: string) => {
      calls += 1
      return original(s)
    }
    const out = runChain(
      [
        h('bad-before', 'before', () => {
          throw new Error('x')
        }),
        h('bad-shape', 'after', () => 42 as unknown as string),
        h('late-throw', 'around', (s, next) => {
          next!(s)
          throw new Error('after next')
        }),
      ],
      'x',
      counted,
      isStr
    )
    expect(out.output).toBe('[x]')
    expect(calls).toBe(1)
    expect(out.strikes.sort()).toEqual(['bad-before', 'bad-shape', 'late-throw'])
  })

  test('an around handler that calls next twice runs the inner chain once', () => {
    let calls = 0
    const counted = (s: string) => {
      calls += 1
      return original(s)
    }
    const twice = h('twice', 'around', (s, next) => next!(s) + next!(s + '!'))
    const out = runChain([twice], 'x', counted, isStr)
    expect(out.output).toBe('[x][x]')
    expect(calls).toBe(1)
  })

  test('a throwing replace falls back to the original', () => {
    const r = h('r', 'replace', () => {
      throw new Error('x')
    })
    const out = runChain([r], 'x', original, isStr)
    expect(out.output).toBe('[x]')
    expect(out.strikes).toEqual(['r'])
  })

  test('cancel only where the point allows it', () => {
    const cancel = [h('c', 'before', () => CANCEL)]
    expect(runChain(cancel, 'x', original, isStr, true).output).toBe(CANCEL)
    const refused = runChain(cancel, 'x', original, isStr, false)
    expect(refused.output).toBe('[x]')
    expect(refused.strikes).toEqual(['c'])
  })

  test('only a before handler may cancel, even where the point allows it', () => {
    for (const kind of ['replace', 'around', 'after'] as const) {
      const out = runChain([h('c', kind, () => CANCEL)], 'x', original, isStr, true)
      expect(out.output).toBe('[x]')
      expect(out.strikes).toEqual(['c'])
    }
  })

  test('a cancel stops the chain before the original and every later handler', () => {
    let ran = 0
    const count = (s: string) => {
      ran += 1
      return s
    }
    const out = runChain(
      [
        h('stop', 'before', () => CANCEL, 5),
        h('later', 'before', count, 0),
        h('wrap', 'around', (s, next) => next!(count(s))),
        h('end', 'after', count),
      ],
      'x',
      count,
      isStr,
      true
    )
    expect(out.output).toBe(CANCEL)
    expect(ran).toBe(0)
  })

  test('a failed around that never called next lets the inner chain run in its place', () => {
    let calls = 0
    const counted = (s: string) => {
      calls += 1
      return original(s)
    }
    const bad = h('bad', 'around', () => {
      throw new Error('before next')
    })
    const out = runChain(
      [bad, h('ok', 'around', (s, next) => `ok(${next!(s)})`, -1)],
      'x',
      counted,
      isStr
    )
    expect(out.output).toBe('ok([x])')
    expect(calls).toBe(1)
    expect(out.strikes).toEqual(['bad'])
  })

  test('an error from the inner chain reaches every later call of next too', () => {
    const boom = () => {
      throw new Error('inner')
    }
    let seen = 0
    const twice = h('twice', 'around', (s, next) => {
      for (let i = 0; i < 2; i++)
        try {
          next!(s)
        } catch {
          seen += 1
        }
      return 'handled'
    })
    expect(runChain([twice], 'x', boom, isStr).output).toBe('handled')
    expect(seen).toBe(2)
  })

  test('handlers and their order are left as given', () => {
    const list = [h('a', 'before', s => s, 0, 1), h('b', 'before', s => s, 9, 0)]
    runChain(list, 'x', original, isStr)
    expect(list.map(x => x.plugin)).toEqual(['a', 'b'])
  })
})

describe('async hook chains with deadlines', () => {
  const D = 40
  const wait = (ms: number) => clock.pass(ms)
  const a = (
    plugin: string,
    kind: AsyncHandler<string>['kind'],
    fn: AsyncHandler<string>['fn'],
    priority = 0
  ): AsyncHandler<string> => ({ plugin, kind, fn, priority, installed: 0 })
  const counter = () => {
    let n = 0
    return {
      run: async (s: string) => {
        n += 1
        return `[${s}]`
      },
      count: () => n,
    }
  }

  test('an around that calls next twice runs the original once', async () => {
    const c = counter()
    const twice = a('twice', 'around', async (s, next) => (await next!(s)) + (await next!(s)))
    const out = await runChainAsync([twice], 'x', c.run, isStr, D)
    expect(out.output).toBe('[x][x]')
    expect(c.count()).toBe(1)
  })

  test('an around that misses its deadline: the host runs next, the late next is refused', async () => {
    const c = counter()
    let lateError: unknown = null
    const slow = a('slow', 'around', async (s, next) => {
      await wait(D * 3)
      try {
        return await next!(s)
      } catch (e) {
        lateError = e
        return 'late'
      }
    })
    const out = await runChainAsync([slow], 'x', c.run, isStr, D)
    expect(out.output).toBe('[x]')
    expect(out.strikes).toEqual(['slow'])
    await wait(D * 4)
    expect(lateError instanceof Late).toBe(true)
    expect(out.late).toEqual(['slow'])
    expect(c.count()).toBe(1)
  })

  test('an around that called next in time and then stalls reuses that call', async () => {
    const c = counter()
    const stall = a('stall', 'around', async (s, next) => {
      const v = await next!(s)
      await wait(D * 3)
      return v + '!'
    })
    const out = await runChainAsync([stall], 'x', c.run, isStr, D)
    expect(out.output).toBe('[x]')
    expect(c.count()).toBe(1)
  })

  test('a slow before keeps its input, a slow replace falls back, a slow after keeps its output', async () => {
    const c = counter()
    const out = await runChainAsync(
      [
        a('b', 'before', async s => {
          await wait(D * 3)
          return s + 'b'
        }),
        a('r', 'replace', async s => {
          await wait(D * 3)
          return 'r' + s
        }),
        a('f', 'after', async s => {
          await wait(D * 3)
          return s + 'f'
        }),
      ],
      'x',
      c.run,
      isStr,
      D
    )
    expect(out.output).toBe('[x]')
    expect(out.strikes.sort()).toEqual(['b', 'f', 'r'])
    expect(c.count()).toBe(1)
  })

  test('cancel from a before where the point allows it', async () => {
    const c = counter()
    const out = await runChainAsync(
      [a('c', 'before', async () => CANCEL)],
      'x',
      c.run,
      isStr,
      D,
      true
    )
    expect(out.output).toBe(CANCEL)
    expect(c.count()).toBe(0)
  })

  test('a cancel where the point does not allow it is a strike and the chain goes on', async () => {
    const c = counter()
    const out = await runChainAsync([a('c', 'before', async () => CANCEL)], 'x', c.run, isStr, D)
    expect(out.output).toBe('[x]')
    expect(out.strikes).toEqual(['c'])
    expect(c.count()).toBe(1)
  })

  test('the same order as the sync chain, with conflicts', async () => {
    const c = counter()
    const out = await runChainAsync(
      [
        a('b1', 'before', async s => s + '1'),
        a('b2', 'before', async s => s + '2', 5),
        a('r1', 'replace', async s => `r1(${s})`),
        a('r2', 'replace', async s => `r2(${s})`, 3),
        a('w', 'around', async (s, next) => `w(${await next!(s)})`),
        a('f', 'after', async s => s + 'f'),
      ],
      'x',
      c.run,
      isStr,
      D
    )
    expect(out).toEqual({ output: 'w(r2(x21))f', strikes: [], conflicts: [['r2', 'r1']], late: [] })
    expect(c.count()).toBe(0)
  })

  test('a rejecting or invalid handler is skipped with a strike', async () => {
    const c = counter()
    const out = await runChainAsync(
      [
        a('throws', 'before', async () => {
          throw new Error('x')
        }),
        a('sync-throw', 'around', () => {
          throw new Error('x')
        }),
        a('shape', 'after', async () => 7 as unknown as string),
        a('cancels', 'after', async () => CANCEL),
      ],
      'x',
      c.run,
      isStr,
      D,
      true
    )
    expect(out.output).toBe('[x]')
    expect(out.strikes.sort()).toEqual(['cancels', 'shape', 'sync-throw', 'throws'])
    expect(c.count()).toBe(1)
  })

  test('a handler that is late and then fails leaves nothing unhandled', async () => {
    const c = counter()
    const slow = a('slow', 'before', async () => {
      await wait(D * 2)
      throw new Error('late failure')
    })
    const out = await runChainAsync([slow], 'x', c.run, isStr, D)
    expect(out.output).toBe('[x]')
    expect(out.strikes).toEqual(['slow'])
    await wait(D * 3)
  })
})
