import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedOf, solve, trust, wins, wire } from './solve.mjs'

// The reference solvers for scripts (solve.mjs, solve.py) against the vectors of crates/pow.

const root = join(import.meta.dir, '../..')
const v = JSON.parse(readFileSync(join(root, 'crates/pow/tests/vectors.json'), 'utf8'))
const python = spawnSync('python3', ['--version']).status === 0

describe('solve.mjs', () => {
  test('matches the vectors', () => {
    expect(seedOf(v.challenge).toString('hex')).toBe(v.seed_hex)
    const nonces = solve(v.challenge, v.k, BigInt(v.target))
    expect(nonces.map(String)).toEqual(v.nonces)
    expect(wire(nonces)).toBe(v.nonces_wire)
  })

  test('a try below the target wins and the nonce before the winner does not', () => {
    const seed = seedOf(v.challenge)
    const target = BigInt(v.target)
    for (const [i, n] of v.nonces.entries()) {
      expect(wins(seed, i, BigInt(n), target)).toBe(true)
      if (BigInt(n) > 0n) expect(wins(seed, i, BigInt(n) - 1n, target)).toBe(false)
    }
  })

  test('hashes the first try as the vectors do', () => {
    const value = BigInt(`0x${v.hash_sub0_nonce0_hex.slice(0, 16)}`)
    expect(wins(seedOf(v.challenge), 0, 0n, value + 1n)).toBe(true)
    expect(wins(seedOf(v.challenge), 0, 0n, value)).toBe(false)
  })
})

describe('trust()', () => {
  const instance = () => {
    const seen: { path: string; auth: string | null; body: Record<string, unknown> }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async req => {
        const path = new URL(req.url).pathname
        const body = (await req.json()) as Record<string, unknown>
        seen.push({ path, auth: req.headers.get('authorization'), body })
        if (path === '/api/v1/pow/challenge')
          return Response.json({ challenge: v.challenge, alg: 's256', k: v.k, target: v.target })
        const nonces = String(body.nonces).match(/.{16}/g) ?? []
        const solved =
          body.challenge === v.challenge &&
          nonces.length === v.k &&
          nonces.every((h, sub) => {
            const input = Buffer.concat([
              Buffer.from('rchat-pow1'),
              seedOf(v.challenge),
              Buffer.from([sub]),
              Buffer.from(h, 'hex'),
            ])
            return createHash('sha256').update(input).digest().readBigUInt64BE(0) < BigInt(v.target)
          })
        return solved
          ? Response.json({ token: v.token, kind: 'general', budget: 1000 })
          : Response.json({ error: 'Invalid or expired challenge' }, { status: 400 })
      },
    })
    return { seen, server, base: `http://127.0.0.1:${server.port}` }
  }

  test('asks for a challenge, solves it and trades the nonces for a token', async () => {
    const { seen, server, base } = instance()
    try {
      const answer = await trust(base, null)
      expect(answer.token).toBe(v.token)
      expect(seen.map(s => s.path)).toEqual(['/api/v1/pow/challenge', '/api/v1/pow/token'])
      expect(seen[0].body).toEqual({ class: 'general' })
      expect(seen[1].body).toEqual({ challenge: v.challenge, nonces: v.nonces_wire })
      expect(seen.map(s => s.auth)).toEqual([null, null])
    } finally {
      server.stop(true)
    }
  })

  test('sends the session on both calls, and the class and username of a sign-in', async () => {
    const { seen, server, base } = instance()
    try {
      await trust(base, 's3cret', 'signin', 'alice')
      expect(seen.map(s => s.auth)).toEqual(['Bearer s3cret', 'Bearer s3cret'])
      expect(seen[0].body).toEqual({ class: 'signin', username: 'alice' })
    } finally {
      server.stop(true)
    }
  })
})

describe('solve.py', () => {
  test.skipIf(!python)('matches the vectors', () => {
    const run = spawnSync('python3', ['-I', join(root, 'scripts/pow/solve.py')], {
      encoding: 'utf8',
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('python reference solver matches the vectors')
  })
})
