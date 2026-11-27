import { describe, expect, test } from 'bun:test'
import { newestReads } from '../newest_read'

const gate = () => {
  let open = () => {}
  const wait = new Promise<void>(r => {
    open = r
  })
  return { wait, open }
}
const settle = () => new Promise<void>(r => setImmediate(r))

describe('newestReads', () => {
  test('a replaced read waits for the newest one and does not apply', async () => {
    const reads = newestReads()
    const shown: string[] = []
    const first = gate()
    const second = gate()
    let firstDone = false
    const a = reads
      .read(async live => {
        await first.wait
        if (live()) shown.push('first')
      })
      .then(() => {
        firstDone = true
      })
    const b = reads.read(async live => {
      await second.wait
      if (live()) shown.push('second')
    })
    first.open()
    await settle()
    expect(firstDone).toBe(false)
    second.open()
    await Promise.all([a, b])
    expect(firstDone).toBe(true)
    expect(shown).toEqual(['second'])
  })

  test('a chain of replaced reads all wait for the last', async () => {
    const reads = newestReads()
    const shown: number[] = []
    const gates = [gate(), gate(), gate()]
    const order: number[] = []
    const all = gates.map((g, i) =>
      reads
        .read(async live => {
          await g.wait
          if (live()) shown.push(i)
        })
        .then(() => order.push(i))
    )
    gates[0].open()
    gates[1].open()
    await settle()
    expect(order).toEqual([])
    gates[2].open()
    await Promise.all(all)
    expect(shown).toEqual([2])
    expect(order.sort()).toEqual([0, 1, 2])
  })

  test('drop stops the read in flight from applying without waiting on anything', async () => {
    const reads = newestReads()
    const shown: string[] = []
    const g = gate()
    const r = reads.read(async live => {
      await g.wait
      if (live()) shown.push('late')
    })
    reads.drop()
    g.open()
    await r
    expect(shown).toEqual([])
  })

  test('a failing newer read does not fail the read it replaced', async () => {
    const reads = newestReads()
    const first = gate()
    const a = reads.read(async () => {
      await first.wait
    })
    const b = reads.read(async () => {
      throw new Error('offline')
    })
    first.open()
    await a
    expect(
      await b.then(
        () => '',
        (e: unknown) => String(e)
      )
    ).toContain('offline')
  })

  test('a read alone applies and resolves', async () => {
    const reads = newestReads()
    const shown: string[] = []
    await reads.read(async live => {
      if (live()) shown.push('only')
    })
    expect(shown).toEqual(['only'])
  })
})
