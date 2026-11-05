import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

describe('ui builders', () => {
  test('a builder run before store.ts binds the store says so', () => {
    const ui = JSON.stringify(fileURLToPath(new URL('../slices/ui.ts', import.meta.url)))
    const run = spawnSync(process.execPath, [
      '-e',
      `const { confirmKick, noteTimeout } = await import(${ui})
      for (const call of [() => confirmKick('s', 'bob'), () => noteTimeout('s', 'bob', undefined)])
        try { call() } catch (e) { console.log(e.message) }`,
    ])
    expect(run.stdout.toString().trim().split('\n')).toEqual([
      'The store is not bound yet: import store.ts first',
      'The store is not bound yet: import store.ts first',
    ])
  })
})
