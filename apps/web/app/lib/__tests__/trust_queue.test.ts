import { describe, expect, test } from 'bun:test'
import { PRIORITIES, SolveCancelled, SolveQueue, type Priority, type Turn } from '../trust/queue'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const settle = () => new Promise<void>(r => setTimeout(r, 0))
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  )

// A solve of `chunks` chunks: each chunk ends when the test lets it, then the queue gets its say.
const solve = (name: string, log: string[], chunks = 1) => {
  const gates = Array.from({ length: chunks }, () => deferred())
  const run = async (turn: Turn) => {
    for (let i = 0; i < chunks; i += 1) {
      log.push(`${name}${i}`)
      await gates[i].promise
      await turn.next()
    }
    log.push(`${name} done`)
    return name
  }
  return { run, finish: (i = 0) => gates[i].resolve() }
}

describe('the solve queue', () => {
  test('lists its priorities, most urgent first', () => {
    expect([...PRIORITIES]).toEqual(['foreground', 'socket', 'form', 'renew-shown', 'renew-other'])
  })

  test('runs one solve at a time', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const a = solve('a', log)
    const b = solve('b', log)
    const first = q.add('foreground', a.run)
    const second = q.add('foreground', b.run)
    await settle()
    expect(log).toEqual(['a0'])
    expect(q.running()).toBe('foreground')
    expect(q.waiting()).toBe(1)
    a.finish()
    expect(await first.done).toBe('a')
    await settle()
    expect(log).toEqual(['a0', 'a done', 'b0'])
    b.finish()
    expect(await second.done).toBe('b')
    expect(q.running()).toBeNull()
    expect(q.waiting()).toBe(0)
  })

  test('starts the most urgent waiting solve next, oldest first among equals', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const head = solve('head', log)
    const done = [q.add('renew-other', head.run).done]
    await settle()
    const order: [Priority, string][] = [
      ['renew-other', 'other'],
      ['form', 'form'],
      ['renew-shown', 'shown'],
      ['socket', 'socket'],
      ['foreground', 'fg1'],
      ['foreground', 'fg2'],
    ]
    const jobs = order.map(([priority, name]) => {
      const job = solve(name, log)
      job.finish()
      done.push(q.add(priority, job.run).done)
      return job
    })
    expect(jobs).toHaveLength(6)
    head.finish()
    await Promise.all(done)
    expect(log.filter(l => l.endsWith('0'))).toEqual([
      'head0',
      'fg10',
      'fg20',
      'socket0',
      'form0',
      'shown0',
      'other0',
    ])
  })

  test('a less urgent solve yields at a chunk boundary and goes on afterwards', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const renew = solve('renew', log, 3)
    const fg = solve('fg', log)
    const renewing = q.add('renew-shown', renew.run)
    await settle()
    const urgent = q.add('foreground', fg.run)
    await settle()
    expect(log).toEqual(['renew0'])
    expect(q.running()).toBe('renew-shown')
    renew.finish(0)
    await settle()
    expect(log).toEqual(['renew0', 'fg0'])
    expect(q.running()).toBe('foreground')
    renew.finish(1)
    await settle()
    expect(log).toEqual(['renew0', 'fg0'])
    fg.finish()
    expect(await urgent.done).toBe('fg')
    await settle()
    expect(log).toEqual(['renew0', 'fg0', 'fg done', 'renew1', 'renew2'])
    renew.finish(2)
    expect(await renewing.done).toBe('renew')
  })

  test('a solve keeps its turn against equal and less urgent ones', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const a = solve('a', log, 2)
    const b = solve('b', log)
    const c = solve('c', log)
    const first = q.add('form', a.run)
    await settle()
    q.add('form', b.run)
    q.add('renew-other', c.run)
    a.finish(0)
    await settle()
    expect(log).toEqual(['a0', 'a1'])
    a.finish(1)
    await first.done
    await settle()
    expect(log).toEqual(['a0', 'a1', 'a done', 'b0'])
  })

  test('a cancelled waiting solve never runs', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const a = solve('a', log)
    const b = solve('b', log)
    const c = solve('c', log)
    const first = q.add('foreground', a.run)
    const second = q.add('foreground', b.run)
    const third = q.add('foreground', c.run)
    second.cancel()
    expect((await failure(second.done)) instanceof SolveCancelled).toBe(true)
    a.finish()
    await first.done
    await settle()
    expect(log).toEqual(['a0', 'a done', 'c0'])
    c.finish()
    await third.done
  })

  test('cancelling the running solve aborts it, and the next starts once it has stopped', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const stopped = deferred()
    let signal: AbortSignal | null = null
    let after: unknown = 'not asked'
    const running = q.add('foreground', async turn => {
      signal = turn.signal
      log.push('a0')
      await stopped.promise
      after = await failure(turn.next())
      log.push('a stopped')
      throw new Error('aborted by the solver')
    })
    const b = solve('b', log)
    const next = q.add('foreground', b.run)
    await settle()
    running.cancel()
    expect(signal!.aborted).toBe(true)
    expect((await failure(running.done)) instanceof SolveCancelled).toBe(true)
    await settle()
    expect(log).toEqual(['a0'])
    stopped.resolve()
    await settle()
    expect(after instanceof SolveCancelled).toBe(true)
    expect(log).toEqual(['a0', 'a stopped', 'b0'])
    b.finish()
    expect(await next.done).toBe('b')
  })

  test('a solve cancelled while it waits its turn never resumes', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const renew = solve('renew', log, 2)
    const fg = solve('fg', log)
    const renewing = q.add('renew-shown', renew.run)
    await settle()
    const urgent = q.add('foreground', fg.run)
    renew.finish(0)
    await settle()
    renewing.cancel()
    expect((await failure(renewing.done)) instanceof SolveCancelled).toBe(true)
    fg.finish()
    await urgent.done
    await settle()
    expect(log).toEqual(['renew0', 'fg0', 'fg done'])
    expect(q.running()).toBeNull()
    expect(q.waiting()).toBe(0)
  })

  test('cancelAll stops everything', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const a = solve('a', log)
    const handles = [q.add('foreground', a.run), q.add('form', solve('b', log).run)]
    await settle()
    q.cancelAll()
    for (const h of handles) expect((await failure(h.done)) instanceof SolveCancelled).toBe(true)
    a.finish()
    await settle()
    expect(log).toEqual(['a0'])
    const c = solve('c', log)
    c.finish()
    expect(await q.add('renew-other', c.run).done).toBe('c')
  })

  test('a solve that fails passes its error on and frees the queue', async () => {
    const q = new SolveQueue(() => false)
    const broken = q.add('foreground', async () => {
      throw new Error('no challenge')
    })
    expect(((await failure(broken.done)) as Error).message).toBe('no challenge')
    expect(await q.add('foreground', async () => 7).done).toBe(7)
  })

  test('two asks with one key share one solve, at the more urgent priority', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const head = solve('head', log)
    q.add('foreground', head.run)
    const form = solve('form', log)
    const renew = solve('renew', log)
    const again = solve('again', log)
    form.finish()
    renew.finish()
    const waitingForm = q.add('form', form.run)
    const first = q.add('renew-shown', renew.run, 'alice@chat.example.com')
    const second = q.add('foreground', again.run, 'alice@chat.example.com')
    expect(q.waiting()).toBe(2)
    head.finish()
    expect(await first.done).toBe('renew')
    expect(await second.done).toBe('renew')
    await waitingForm.done
    expect(log).toEqual(['head0', 'head done', 'renew0', 'renew done', 'form0', 'form done'])
    const fresh = solve('fresh', log)
    fresh.finish()
    expect(await q.add('renew-shown', fresh.run, 'alice@chat.example.com').done).toBe('fresh')
  })
})

describe('a key whose solve was cancelled', () => {
  test('later asks join the new solve, not the one that is stopping', async () => {
    const log: string[] = []
    const q = new SolveQueue(() => false)
    const a = solve('a', log)
    const b = solve('b', log)
    const c = solve('c', log)
    const first = q.add('foreground', a.run, 'alice@chat.example.com')
    await settle()
    first.cancel()
    const second = q.add('foreground', b.run, 'alice@chat.example.com')
    const third = q.add('renew-shown', c.run, 'alice@chat.example.com')
    expect(third === second).toBe(true)
    expect(second === first).toBe(false)
    a.finish()
    b.finish()
    c.finish()
    expect((await failure(first.done)) instanceof SolveCancelled).toBe(true)
    expect(await second.done).toBe('b')
    expect(await third.done).toBe('b')
    expect(log).toEqual(['a0', 'b0', 'b done'])
  })
})

describe('a hidden tab', () => {
  test('holds renewals back, and runs socket and foreground solves', async () => {
    const log: string[] = []
    let hidden = true
    const q = new SolveQueue(() => hidden)
    const threads: Record<string, string> = {}
    const job = (name: string) => {
      const s = solve(name, log)
      s.finish()
      return (turn: Turn) => {
        threads[name] = turn.threads()
        return s.run(turn)
      }
    }
    const shown = q.add('renew-shown', job('shown'))
    const other = q.add('renew-other', job('other'))
    const socket = q.add('socket', job('socket'))
    const fg = q.add('foreground', job('fg'))
    const form = q.add('form', job('form'))
    await Promise.all([socket.done, fg.done, form.done])
    await settle()
    expect(log.filter(l => l.endsWith('0'))).toEqual(['socket0', 'fg0', 'form0'])
    expect(threads).toEqual({ socket: 'one', fg: 'all', form: 'all' })
    expect(q.running()).toBeNull()
    expect(q.waiting()).toBe(2)
    hidden = false
    q.visibility()
    expect(await shown.done).toBe('shown')
    expect(await other.done).toBe('other')
    expect(threads.shown).toBe('all')
  })

  test('a socket solve uses every core while the tab is shown', async () => {
    const q = new SolveQueue(() => false)
    expect(await q.add('socket', async turn => turn.threads()).done).toBe('all')
  })

  test('a renewal that is running stops at its next chunk and goes on when the tab is back', async () => {
    const log: string[] = []
    let hidden = false
    const q = new SolveQueue(() => hidden)
    const renew = solve('renew', log, 2)
    const renewing = q.add('renew-shown', renew.run)
    await settle()
    hidden = true
    q.visibility()
    renew.finish(0)
    await settle()
    expect(log).toEqual(['renew0'])
    expect(q.running()).toBeNull()
    expect(q.waiting()).toBe(1)
    const socket = solve('socket', log)
    socket.finish()
    expect(await q.add('socket', socket.run).done).toBe('socket')
    await settle()
    expect(log).toEqual(['renew0', 'socket0', 'socket done'])
    hidden = false
    q.visibility()
    await settle()
    expect(log).toEqual(['renew0', 'socket0', 'socket done', 'renew1'])
    renew.finish(1)
    expect(await renewing.done).toBe('renew')
  })

  test('renews over its socket on one core and keeps the socket open', async () => {
    let hidden = true
    const q = new SolveQueue(() => hidden)
    const socket = { sent: [] as unknown[], closed: false }
    const solves: string[] = []
    const renew = (priority: Priority) =>
      q.add(
        priority,
        async turn => {
          solves.push(`${priority} on ${turn.threads()}`)
          await turn.next()
          return `t1.1.${priority}.tag`
        },
        priority
      ).done
    const proactive = renew('renew-shown')
    const onTrustLow = async () => {
      const trust = await renew('socket')
      socket.sent.push({ type: 'trust', trust })
    }
    await onTrustLow()
    expect(socket.sent).toEqual([{ type: 'trust', trust: 't1.1.socket.tag' }])
    expect(socket.closed).toBe(false)
    expect(solves).toEqual(['socket on one'])
    hidden = false
    q.visibility()
    expect(await proactive).toBe('t1.1.renew-shown.tag')
    expect(solves).toEqual(['socket on one', 'renew-shown on all'])
  })
})
