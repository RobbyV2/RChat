import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

// The solver bench page (scripts/pow/bench.html): the committed wasm against the JavaScript
// fallback. The headless run needs the Chromium of playwright-core (PLAYWRIGHT_BROWSERS_PATH or
// its default cache); without one only the page's source is checked.

const root = join(import.meta.dir, '../..')
const html = readFileSync(join(import.meta.dir, 'bench.html'), 'utf8')
const v = JSON.parse(readFileSync(join(root, 'crates/pow/tests/vectors.json'), 'utf8'))
const browser = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

interface Rate {
  workers: number
  wasm: number | null
  js: number
}
interface Bench {
  done: boolean
  check: { wasm: boolean | null; js: boolean; high: boolean | null }
  wasm: number | null
  js: number
  ratio: number | null
  main: number
  workers: Rate[]
  cores: number
  error: string | null
}

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  wasm: 'application/wasm',
  json: 'application/json',
}

const serve = () =>
  Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: req => {
      const path = decodeURIComponent(new URL(req.url).pathname)
      const file = join(root, path)
      if (path.includes('..') || !existsSync(file))
        return new Response('Not found', { status: 404 })
      const type = types[path.split('.').pop() ?? ''] ?? 'application/octet-stream'
      return new Response(readFileSync(file), { headers: { 'content-type': type } })
    },
  })

const run = async (query: string, strip: string[] = []): Promise<Bench> => {
  const server = serve()
  const chrome = await chromium.launch({ headless: true })
  try {
    const page = await chrome.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(String(e)))
    await page.addInitScript(names => {
      for (const name of names) delete (globalThis as Record<string, unknown>)[name]
    }, strip)
    await page.goto(`http://127.0.0.1:${server.port}/scripts/pow/bench.html?${query}`)
    await page.waitForFunction('window.__bench && window.__bench.done', undefined, {
      timeout: 120_000,
    })
    expect(errors).toEqual([])
    const shown = await page.textContent('#result')
    const bench = (await page.evaluate('window.__bench')) as Bench
    expect(JSON.parse(shown ?? '')).toEqual(bench)
    return bench
  } finally {
    await chrome.close()
    server.stop(true)
  }
}

describe('the solver bench page', () => {
  test('carries the vectors it checks itself against', () => {
    expect(html).toContain(v.seed_hex)
    expect(html).toContain(v.target)
    for (const nonce of v.nonces) expect(html).toContain(nonce)
  })

  test('reads the wasm answer as unsigned, as the JavaScript solver gives it', () => {
    expect(html).toContain('BigInt.asUintN(64, powChunk(')
  })

  test('loads the committed wasm from the repository and nothing from anywhere else', () => {
    expect(html).toContain('../../apps/web/public/pow/rchat_pow.wasm')
    expect(existsSync(join(import.meta.dir, '../../apps/web/public/pow/rchat_pow.wasm'))).toBe(true)
    expect(/https?:\/\//.test(html)).toBe(false)
    expect(/<script[^>]+src=|<link[^>]+href=|@import/.test(html)).toBe(false)
  })

  test.skipIf(!browser)(
    'reports the wasm rate, the JavaScript rate and their ratio, per thread and for 1, 2, 4 and 8 workers',
    async () => {
      const bench = await run('ms=120')
      expect(bench.error).toBeNull()
      expect(bench.check).toEqual({ wasm: true, js: true, high: true })
      expect(bench.wasm! > 0).toBe(true)
      expect(bench.js > 0).toBe(true)
      expect(bench.main > 0).toBe(true)
      expect(bench.ratio).toBe(Math.round((bench.wasm! / bench.js) * 100) / 100)
      expect(bench.workers.map(r => r.workers)).toEqual([1, 2, 4, 8])
      for (const r of bench.workers) expect(r.wasm! > 0 && r.js > 0).toBe(true)
      expect(bench.cores > 0).toBe(true)
    },
    180_000
  )

  test.skipIf(!browser)(
    'still reports the JavaScript rate when the wasm cannot be loaded',
    async () => {
      const bench = await run('ms=60&workers=1,2&wasm=/scripts/pow/missing.wasm')
      expect(bench.check).toEqual({ wasm: null, js: true, high: null })
      expect(bench.wasm).toBeNull()
      expect(bench.ratio).toBeNull()
      expect(bench.js > 0).toBe(true)
      expect(bench.workers).toHaveLength(2)
      expect(bench.workers.every(r => r.wasm === null && r.js > 0)).toBe(true)
    },
    180_000
  )

  test.skipIf(!browser)(
    'runs on the main thread alone where there is no WebAssembly and no Worker',
    async () => {
      const bench = await run('ms=60', ['WebAssembly', 'Worker'])
      expect(bench.check).toEqual({ wasm: null, js: true, high: null })
      expect(bench.main > 0).toBe(true)
      expect(bench.js).toBe(bench.main)
      expect(bench.workers).toEqual([])
    },
    180_000
  )
})
