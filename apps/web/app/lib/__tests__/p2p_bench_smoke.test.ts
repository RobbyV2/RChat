import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BenchWorld } from '../../../scripts/p2p_bench/world'

// The P2P bench harness (scripts/p2p_bench): every script runs at a small size within a minute
// and prints JSON lines that carry the load, universes are built once per shape and size, and
// acl_bench's visibility universe admits content. acl_bench builds its shapes with the same world.

const OUT = mkdtempSync(join(tmpdir(), 'p2p-bench-'))
afterAll(() => rmSync(OUT, { recursive: true, force: true }))

const SCRIPTS_DIR = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const script = (name: string) => join(SCRIPTS_DIR, `${name}.ts`)

const run = (name: string, args: string[]) => {
  const t = performance.now()
  const r = spawnSync(process.execPath, [script(name), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const ms = performance.now() - t
  const lines = (r.stdout ?? '')
    .split('\n')
    .filter(l => l.startsWith('{'))
    .map(l => JSON.parse(l) as Record<string, unknown>)
  return { status: r.status, signal: r.signal, stderr: r.stderr ?? '', ms, lines }
}

const exited = (r: ReturnType<typeof run>) => ({
  status: r.status,
  signal: r.signal,
  err: r.status === 0 ? '' : r.stderr.slice(-2000),
})
const CLEAN = { status: 0, signal: null, err: '' }

const SMALL = ['--events', '300', '--members', '20', '--out', OUT]
const EXTRA: Record<string, string[]> = {
  join: ['--arrivals', '10'],
  batch: ['--arrivals', '10'],
  content: ['--contents', '2000'],
  phases: ['--reps', '2'],
}
const SCRIPTS = [
  'gossip',
  'join',
  'batch',
  'content',
  'phases',
  'overlay',
  'sumsize',
  'ancwin',
  'verify',
]

describe('P2P bench harness', () => {
  for (const name of SCRIPTS)
    test(`${name} runs small and reports the load`, () => {
      const r = run(`p2p_bench/${name}`, [...SMALL, ...(EXTRA[name] ?? [])])
      expect(exited(r)).toEqual(CLEAN)
      expect(r.ms).toBeLessThan(60_000)
      expect(r.lines.length).toBeGreaterThan(0)
      for (const l of r.lines) expect(Number.isFinite(l.load)).toBe(true)
    }, 90_000)

  test('a universe is built once per shape, members, events and seed', () => {
    const first = run('p2p_bench/gossip', [...SMALL, '--seed', '5'])
    const again = run('p2p_bench/gossip', [...SMALL, '--seed', '5'])
    const other = run('p2p_bench/gossip', [...SMALL, '--seed', '5', '--chan'])
    expect([first, again, other].map(r => r.lines[r.lines.length - 1]?.cached)).toEqual([
      false,
      true,
      false,
    ])
    expect(again.lines[again.lines.length - 1]?.events).toBe(
      first.lines[first.lines.length - 1]?.events
    )
  }, 180_000)

  test('the visibility universe has a channel everyone may post in', () => {
    const r = run('acl_bench', ['visibility', '300', '1', '1000'])
    expect(exited(r)).toEqual(CLEAN)
    const v = r.lines.find(l => l.shape === 'visibility')!
    expect(v.contents).toBe(1000)
    expect(v.admit_refused as number).toBeLessThan(1000)
  }, 90_000)

  test('one bench world: acl_bench builds with p2p_bench/world', () => {
    const owners = readdirSync(SCRIPTS_DIR, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts'))
      .filter(f =>
        /^(export )?class (BenchWorld|Rng)\b/m.test(readFileSync(join(SCRIPTS_DIR, f), 'utf8'))
      )
    expect(owners).toEqual([join('p2p_bench', 'world.ts')])
    expect(readFileSync(script('acl_bench'), 'utf8')).toContain("from './p2p_bench/world'")
  })

  test('the bench world revokes a device as an honest client does', () => {
    const w = new BenchWorld()
    w.genesis('O1', ['O'])
    const add = w.act('O2', 'device_add', {}, { ts: 1 })
    expect(add.v.s).toBe('A')
    const rev = w.act('O1', 'device_revoke', { dk: 'O2', seen: add.e.seq }, { ts: 2 })
    expect([rev.e.c.ik, rev.v.s]).toEqual(['O', 'A'])
  })
})
