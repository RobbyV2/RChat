import { plugin } from 'bun'
import { afterAll, afterEach, beforeEach, jest } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { fixtureScopes } from './fixture'

// Every test file runs in this one process, so what one test changes the next one sees. After
// each test its fixtures are undone and real timers and the time zone are put back. After each
// file its file fixtures are undone, real timers and the time zone are put back, and the store
// starts over (if the file loaded it).

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const STORE = fileURLToPath(new URL('../../store.ts', import.meta.url))

const putBack = () => {
  jest.useRealTimers()
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== zone) process.env.TZ = zone
}

let testRunning = false
const testEnds = () => {
  testRunning = false
  putBack()
  return fixtureScopes.testEnds()
}

// An undo that fails outside its own test is reported at once and fails the run at its end, not
// the next test or the next file's load.
let late = 0
const later = async (undo: () => unknown) => {
  try {
    await undo()
  } catch (e) {
    console.error('A test fixture failed to undo:', e)
    late += 1
  }
}

beforeEach(async () => {
  // A file's afterEach that throws skips this preload's: what that test left is undone here.
  if (testRunning) await later(testEnds)
  testRunning = true
  fixtureScopes.testStarts()
})

afterEach(testEnds)

const fileEnds = async () => {
  if (testRunning) await later(testEnds)
  await later(fixtureScopes.fileEnds)
  putBack()
  const store = require.cache[STORE]?.exports as typeof import('../../store') | undefined
  await later(() => store?.resetSessionCaches())
}

// A test file ends where the next one starts to load, or with the run.
plugin({
  name: 'test file ends',
  setup(build) {
    build.onLoad({ filter: /\.test\.tsx?$/ }, async ({ path }) => {
      await fileEnds()
      return { contents: await readFile(path, 'utf8'), loader: path.endsWith('x') ? 'tsx' : 'ts' }
    })
  },
})

afterAll(async () => {
  await fileEnds()
  if (late) throw new Error(`${late} test fixtures failed to undo between tests`)
})
