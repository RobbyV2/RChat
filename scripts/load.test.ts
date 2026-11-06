import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { joinCode } from './load/join'
import { findChrome, pct, stats } from './load/lib'
import { phaseError } from './load/run'
import { failures, multiStatements, splitStatements, truthy } from './load/upgrade'

const dir = join(import.meta.dir, 'load')
const scripts = () => readdirSync(dir).filter(name => name.endsWith('.ts'))
const read = (name: string) => readFileSync(join(dir, name), 'utf8')
const envNames = (code: string) =>
  [
    ...code.matchAll(
      /process\.env\.([A-Z_]+)|process\.env\[['"]([A-Z_]+)['"]\]|need\(['"]([A-Z_]+)['"]\)/g
    ),
  ].map(m => m[1] ?? m[2] ?? m[3])

describe('load harness files', () => {
  test('every script is there and none is a test', () => {
    expect(readdirSync(dir).sort()).toEqual(
      [
        'README.md',
        'client.ts',
        'count.ts',
        'join.ts',
        'lib.ts',
        'mem.ts',
        'perms.ts',
        'run.ts',
        'seed.sql',
        'upgrade.ts',
      ].sort()
    )
  })

  test('no script holds a /tmp path or a host with a port', () => {
    for (const name of scripts()) {
      const code = read(name)
      expect({ name, tmp: /\/tmp\b/.test(code) }).toEqual({ name, tmp: false })
      expect({ name, port: /(localhost|127\.0\.0\.1|0\.0\.0\.0):\d/.test(code) }).toEqual({
        name,
        port: false,
      })
    }
  })

  test('scripts read the shared env and README lists every variable they read', () => {
    const readme = read('README.md')
    const names = new Set(scripts().flatMap(name => envNames(read(name))))
    for (const name of ['BASE', 'WS_BASE', 'SERVER_PID', 'PG_CONTAINER', 'OUT', 'PHASES', 'CONC'])
      expect(names.has(name)).toBe(true)
    for (const name of names)
      expect({ name, listed: readme.includes(`\`${name}\``) }).toEqual({ name, listed: true })
  })

  test('the seed builds the recon shape and sets member counts', () => {
    const seed = read('seed.sql')
    expect(seed).toContain("WHERE username = 'pwref'")
    expect(seed).toContain('generate_series(0, 4999)')
    expect(seed).toContain('generate_series(1000, 1999)')
    expect(seed).toContain('generate_series(0::bigint, 599999::bigint)')
    expect(seed).toContain('generate_series(0::bigint, 399999::bigint)')
    expect(seed).toMatch(/UPDATE servers SET member_count = \(SELECT COUNT\(\*\) FROM members/)
  })
})

describe('load harness helpers', () => {
  test('percentiles pick from the sorted samples', () => {
    expect(pct([5, 1, 4, 2, 3], 50)).toBe(3)
    expect(pct([5, 1, 4, 2, 3], 100)).toBe(5)
    expect(pct([], 50)).toBeNaN()
    const load = String.raw`load=[\d.]+ [\d.]+ [\d.]+`
    expect(stats('x', [])).toMatch(new RegExp(`^x: n=0 ${load}$`))
    expect(stats('x', [1, 2], 'tail')).toMatch(
      new RegExp(`^x: n=2 p50=2\\.0ms p99=2\\.0ms max=2\\.0ms tail ${load}$`)
    )
    expect(stats('x', [1])).toMatch(new RegExp(`max=1\\.0ms ${load}$`))
  })

  test('run.ts phases are known and presence and send come after storm', () => {
    expect(phaseError('login,ready,storm,presence,send,members,search,unreads'.split(','))).toBe(
      null
    )
    expect(phaseError(['storm', 'send'])).toBe(null)
    expect(phaseError(['login', 'strom', 'search'])).toBe('Unknown phase strom')
    expect(phaseError(['toString'])).toBe('Unknown phase toString')
    expect(phaseError(['send'])).toBe('send needs storm earlier in PHASES')
    expect(phaseError(['presence', 'storm'])).toBe('presence needs storm earlier in PHASES')
  })

  test('join.ts fails unless every join succeeded and the count matches', () => {
    expect(joinCode(241, 240, 240)).toBe(0)
    expect(joinCode(46, 45, 240)).toBe(1)
    expect(joinCode(240, 240, 240)).toBe(1)
  })

  test('client.ts picks the newest Chromium for either Linux layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'rchat-load-test-'))
    try {
      expect(findChrome(join(root, 'missing'))).toBe(null)
      expect(findChrome(root)).toBe(null)
      const exe = (rev: string, sub: string) => {
        mkdirSync(join(root, rev, sub), { recursive: true })
        writeFileSync(join(root, rev, sub, 'chrome'), '')
        return join(root, rev, sub, 'chrome')
      }
      exe('chromium_headless_shell-1300', 'chrome-linux64')
      expect(findChrome(root)).toBe(null)
      exe('chromium-999', 'chrome-linux64')
      const arm = exe('chromium-1200', 'chrome-linux')
      mkdirSync(join(root, 'chromium-1300'))
      expect(findChrome(root)).toBe(arm)
      const x64 = exe('chromium-1200', 'chrome-linux64')
      expect(findChrome(root)).toBe(x64)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('check SQL splits on line-ending semicolons and drops comments', () => {
    expect(
      splitStatements(
        "-- users\nSELECT COUNT(*) = 2\n  FROM users;\n\nSELECT ';' <> 'x';\n-- end\nSELECT 1"
      )
    ).toEqual(['SELECT COUNT(*) = 2\n  FROM users', "SELECT ';' <> 'x'", 'SELECT 1'])
    expect(splitStatements('-- nothing\n\n')).toEqual([])
    expect(splitStatements('SELECT 1; -- c\nSELECT 2;\n')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements('SELECT 1;\t-- c;\r\nSELECT 2;\r\n')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements('SELECT 1;\n/* only a comment */\n')).toEqual(['SELECT 1'])
  })

  test('check SQL rejects more than one statement in a chunk', () => {
    const multi = (sql: string) => multiStatements(splitStatements(sql))
    expect(multi('SELECT 1; SELECT 2;')).toEqual(['SELECT 1; SELECT 2'])
    expect(multi('SELECT 1; /* x */\nSELECT 2;')).toEqual(['SELECT 1; /* x */\nSELECT 2'])
    expect(multi("SELECT ';' <> 'x';\nSELECT 'it''s;' = 'x' -- a;b\n;")).toEqual([])
    expect(multi('SELECT 1 /* a;b */ = 1;\nSELECT 2 AS "x;y";')).toEqual([])
  })

  test('check values count as true only when they are true', () => {
    for (const value of [true, 1, 1n, 't', 'true', '1']) expect(truthy(value)).toBe(true)
    for (const value of [false, 0, 0n, 'f', 'false', '0', null, undefined, 2, 'yes'])
      expect(truthy(value)).toBe(false)
  })

  test('a check fails on a false first column or on no rows', () => {
    expect(failures([{ sql: 'a', rows: [[true, 'x'], [1]] }])).toEqual([])
    expect(failures([{ sql: 'a', rows: [[true], [false, 'why']] }])).toEqual([
      'a: row 2 is ["false","why"]',
    ])
    expect(failures([{ sql: 'b', rows: [] }])).toEqual(['b: no rows'])
  })
})

describe('load harness scripts exit early', () => {
  const run = (args: string[], env: Record<string, string | undefined>, cwd?: string) =>
    Bun.spawn([process.execPath, ...args], { env, cwd, stdout: 'pipe', stderr: 'pipe' })
  const { BASE: _base, PHASES: _phases, ...env } = process.env

  test('upgrade.ts refuses a check file with two statements in a chunk before any server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rchat-load-test-'))
    try {
      const check = join(root, 'check.sql')
      writeFileSync(check, 'SELECT 1 = 1; -- fine\nSELECT 1 = 1; SELECT 1 = 0;\n')
      const missing = join(root, 'no-server')
      const proc = run(
        [
          join(dir, 'upgrade.ts'),
          '--old',
          missing,
          '--new',
          missing,
          '--db',
          'sqlite',
          '--check',
          check,
        ],
        env
      )
      expect(await proc.exited).toBe(2)
      expect(await new Response(proc.stderr).text()).toContain(
        'Check file: one statement per chunk: SELECT 1 = 1; SELECT 1 = 0'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('upgrade.ts runs a relative binary and reports a server killed by a signal at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rchat-load-test-'))
    let logs = ''
    try {
      mkdirSync(join(root, 'bin'))
      writeFileSync(join(root, 'bin', 'crash.sh'), '#!/bin/sh\nkill -SEGV $$\n')
      chmodSync(join(root, 'bin', 'crash.sh'), 0o755)
      const crash = join('bin', 'crash.sh')
      const proc = run(
        [join(dir, 'upgrade.ts'), '--old', crash, '--new', crash, '--db', 'sqlite'],
        env,
        root
      )
      expect(await proc.exited).toBe(1)
      const err = await new Response(proc.stderr).text()
      logs = /^Logs: (.+)$/m.exec(err)?.[1] ?? ''
      expect(err).toContain('old exited with SIGSEGV')
    } finally {
      rmSync(root, { recursive: true, force: true })
      if (logs.includes('rchat-upgrade-')) rmSync(logs, { recursive: true, force: true })
    }
  }, 60_000)

  test('run.ts checks PHASES before it starts', async () => {
    for (const [phases, message] of [
      ['send', 'send needs storm earlier in PHASES'],
      ['login,strom', 'Unknown phase strom'],
    ]) {
      const proc = run([join(dir, 'run.ts')], { ...env, PHASES: phases })
      expect(await proc.exited).toBe(2)
      expect(await new Response(proc.stderr).text()).toContain(message)
    }
  })
})
