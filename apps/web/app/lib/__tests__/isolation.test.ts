import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetSessionCaches, useStore } from '../store'
import { me, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

// Test files run in one process, in any order, and share the store. These keep one file's
// leftovers out of the next.
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

  // Reads every test file: a budget for a loaded machine.
  test('every test file that uses the store calls resetSessionCaches', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const uses = /\buseStore\.(setState|getState|getInitialState)\(/
    const missing = readdirSync(dir)
      .filter(f => /\.test\.tsx?$/.test(f))
      .filter(f => {
        const text = readFileSync(`${dir}${f}`, 'utf8')
        return uses.test(text) && !text.includes('resetSessionCaches')
      })
    expect(missing).toEqual([])
  }, 60_000)
})
