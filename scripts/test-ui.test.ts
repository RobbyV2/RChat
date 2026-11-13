import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test starts a shell: a budget for a loaded machine.
setDefaultTimeout(30_000)

// A stand-in `bun` that records how it was called and exits as told.
const bin = mkdtempSync(join(tmpdir(), 'test-ui-'))
writeFileSync(
  join(bin, 'bun'),
  '#!/bin/sh\necho "$PWD" > "$CALL_LOG"\necho "$@" >> "$CALL_LOG"\nexit "${BUN_EXIT:-0}"\n'
)
chmodSync(join(bin, 'bun'), 0o755)
afterAll(() => rmSync(bin, { recursive: true, force: true }))

const run = (env: Record<string, string> = {}, args: string[] = []) => {
  const log = join(bin, 'call.log')
  const out = spawnSync('bash', [join(import.meta.dir, 'test-ui.sh'), ...args], {
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CALL_LOG: log, ...env },
    encoding: 'utf8',
  })
  const [cwd, call] = readFileSync(log, 'utf8').trim().split('\n')
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, cwd, call }
}

describe('web tests in a random order', () => {
  test('run in apps/web with a new seed each time', () => {
    const a = run()
    const b = run()
    expect(a.status).toBe(0)
    expect(a.cwd).toBe(join(import.meta.dir, '../apps/web'))
    expect(a.call).toMatch(/^test app --randomize --seed=\d+$/)
    expect(a.call).not.toBe(b.call)
    expect([a.stdout, a.stderr]).toEqual(['', ''])
  })

  test('SEED runs a given order again, and arguments go to bun test', () => {
    const { status, call } = run({ SEED: '42' }, ['--bail', '-t', 'guest'])
    expect([status, call]).toEqual([0, 'test app --randomize --seed=42 --bail -t guest'])
  })

  test('a failure prints the seed and how to run that order again', () => {
    const { status, stdout, stderr, call } = run({ BUN_EXIT: '1' })
    const seed = /--seed=(\d+)$/.exec(call)?.[1]
    expect(status).toBe(1)
    expect(stderr).toBe(
      `Web tests failed in the order of seed ${seed}. Run the same order again: SEED=${seed} bun run test:ui\n`
    )
    expect(stdout).toBe('')
  })

  test('on GitHub the failure is also an error annotation', () => {
    const { status, stdout } = run({ BUN_EXIT: '3', SEED: '7', GITHUB_ACTIONS: 'true' })
    expect(status).toBe(1)
    expect(stdout).toBe(
      '::error title=Web tests failed (seed 7)::Run the same order again: SEED=7 bun run test:ui\n'
    )
  })
})
