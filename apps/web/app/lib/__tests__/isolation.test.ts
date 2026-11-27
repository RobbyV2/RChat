import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetSessionCaches, useStore } from '../store'
import { me, serverDetail } from './fixtures'
import { fixtureScopes, own } from './helpers/fixture'

// Test files run in one process, in any order, and share the store. The preload keeps one test's
// and one file's leftovers out of the next.

const web = fileURLToPath(new URL('../../../', import.meta.url))
const here = (module: string) => JSON.stringify(fileURLToPath(new URL(module, import.meta.url)))

// A test file that notes what it finds at load, sets up a session, the store and a fixture at
// load and in each of its tests, and moves the time zone and the timers. A `failing` file's
// afterEach throws; a `breaking` file's file fixture fails to undo.
const probe = (name: string, log: string) => `
import { afterEach, jest, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { client } from ${here('../client/client')}
import { useStore } from ${here('../store')}
import { me } from ${here('./fixtures')}
import { own } from ${here('./helpers/fixture')}
import { testAccount } from ${here('./test_account')}

const note = (line: string) => appendFileSync(${JSON.stringify(log)}, line + '\\n')
const found = {
  me: useStore.getState().me?.username ?? null,
  live: client.live().length,
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  fake: jest.isFakeTimers(),
}
note('${name} loads ' + JSON.stringify(found))
own('${name}', n => {
  note(n + ' file fixture undone')
  if (n === 'breaking') throw new Error('this undo fails')
})
testAccount('${name}-file', 'https://${name}-file.test')
useStore.setState({ me: me('${name}') })
if ('${name}' === 'failing') {
  afterEach(() => {
    throw new Error('this afterEach fails')
  })
}

for (const n of [1, 2]) {
  test('${name} ' + n, () => {
    own('${name} test ' + n, t => note(t + ' fixture undone'))
    testAccount('${name}-test-' + n, 'https://${name}-test.test')
    process.env.TZ = 'Pacific/Chatham'
    jest.useFakeTimers()
    note('${name} test ' + n + ' runs')
  })
}
`

describe('test isolation', () => {
  test('resetSessionCaches puts the store back as it starts', () => {
    const start = { ...useStore.getState() }
    const initial = useStore.getInitialState()
    useStore.setState({
      me: me('bob'),
      guest: true,
      error: 'nope',
      servers: { club: serverDetail('club') },
      settings: { ...start.settings, guests_enabled: false },
    })
    // Server rendering reads the initial state, so tests of markup write there too.
    Object.assign(initial, { me: me('carol'), streamer: true })
    resetSessionCaches()
    expect(useStore.getState()).toEqual(start)
    expect(useStore.getState().settings).toBe(start.settings)
    expect(useStore.getInitialState()).toBe(initial)
    expect(initial).toEqual(start)
    useStore.setState({ guest: true })
    resetSessionCaches()
    expect(useStore.getState().guest).toBe(false)
  })

  test('each test and each file starts with what the ones before set up undone', () => {
    const dir = own(mkdtempSync(join(tmpdir(), 'rchat-fixtures-')), d =>
      rmSync(d, { recursive: true, force: true })
    )
    const log = join(dir, 'log')
    const names = ['first', 'failing', 'breaking', 'last']
    const files = names.map(name => {
      const file = join(dir, `${name}.test.ts`)
      writeFileSync(file, probe(name, log))
      return file
    })
    const run = spawnSync(process.execPath, ['test', ...files], {
      cwd: web,
      encoding: 'utf8',
      timeout: 50_000,
    })
    expect(run.stderr).toContain('this afterEach fails')
    expect(run.stderr).toContain('this undo fails')
    expect(run.stderr).toContain('1 test fixtures failed to undo between tests')
    expect(run.status).toBe(1)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const start = lines[0]!.slice('first loads '.length)
    expect(lines).toEqual(
      names.flatMap(name => [
        `${name} loads ${start}`,
        `${name} test 1 runs`,
        `${name} test 1 fixture undone`,
        `${name} test 2 runs`,
        `${name} test 2 fixture undone`,
        `${name} file fixture undone`,
      ])
    )
    expect(JSON.parse(start).me).toBeNull()
    expect(JSON.parse(start).fake).toBe(false)
  }, 60_000)

  test('undoing runs every undo, the newest first, and fails with what failed', async () => {
    const log: string[] = []
    own('first', name => log.push(name))
    own('broken', () => {
      throw new Error('broken undo')
    })
    own('last', name => log.push(name))
    let failed: unknown = null
    await fixtureScopes.testEnds().catch(e => (failed = e))
    fixtureScopes.testStarts()
    expect(log).toEqual(['last', 'first'])
    expect(failed instanceof Error && failed.message).toBe('broken undo')
  })
})
