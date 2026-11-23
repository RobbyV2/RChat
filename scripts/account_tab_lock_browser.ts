// Run with bun scripts/account_tab_lock_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import type { AccountTabLock } from '../apps/web/app/lib/client/tab_lock'

declare global {
  interface Window {
    lease: AccountTabLock
    alerts: string[]
    start(origin: string, name: string | null, fallback: boolean): void
  }
}

const bundle = await Bun.build({
  entrypoints: [new URL('../apps/web/app/lib/client/tab_lock.ts', import.meta.url).pathname],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs)
const script = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  for (const fallback of [false, true]) {
    const context = await browser.newContext()
    await context.route('**/*', route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/lock.js')
        return route.fulfill({ contentType: 'text/javascript', body: script })
      return route.fulfill({
        contentType: 'text/html',
        body: `<script type="module">
        import { AccountTabLock } from './lock.js'
        window.alerts = []
        window.start = (origin, name, fallback) => {
          window.lease = new AccountTabLock(() => true, fallback ? () => undefined : undefined)
          window.lease.start(origin, name)
          window.lease.whenHolder(origin, name, () => window.alerts.push('startup'))
        }
      </script>`,
      })
    })
    const tabs = await Promise.all([context.newPage(), context.newPage()])
    const [holder, follower] = tabs
    const origin = 'https://instance.test'
    for (const tab of tabs) {
      await tab.goto('https://shell.test/')
      await tab.evaluate(([origin, fallback]) => window.start(origin, 'alice', fallback), [
        origin,
        fallback,
      ] as const)
    }
    await holder.waitForFunction(origin => window.lease.holds(origin, 'alice'), origin)
    if (!fallback)
      await follower.waitForFunction(async () => {
        const locks = await navigator.locks.query()
        return (
          locks.held?.some(lock => lock.name?.startsWith('rchat-acct:')) &&
          locks.pending?.some(lock => lock.name?.startsWith('rchat-acct:'))
        )
      })
    assert.deepEqual(await holder.evaluate(() => window.alerts), ['startup'])
    assert.deepEqual(await follower.evaluate(() => window.alerts), [])
    for (const tab of tabs) {
      await tab.evaluate(
        origin => window.lease.whenHolder(origin, 'alice', () => window.alerts.push('message')),
        origin
      )
    }
    assert.deepEqual(await holder.evaluate(() => window.alerts), ['startup', 'message'])
    assert.deepEqual(await follower.evaluate(() => window.alerts), [])
    await follower.evaluate(origin => {
      window.lease.start(origin, 'old')
      window.lease.stop()
      window.lease.start(origin, 'alice')
    }, origin)
    if (!fallback) {
      await follower.waitForFunction(async () => {
        const locks = await navigator.locks.query()
        return (
          locks.pending?.length === 1 && !locks.held?.some(lock => lock.name?.includes('"old"'))
        )
      })
    }
    if (fallback) await holder.evaluate(() => window.lease.stop())
    else await holder.close()
    await follower.waitForFunction(origin => window.lease.holds(origin, 'alice'), origin)
    await follower.evaluate(
      origin => window.lease.whenHolder(origin, 'alice', () => window.alerts.push('next')),
      origin
    )
    assert.deepEqual(await follower.evaluate(() => window.alerts), ['next'])
    await context.close()
    console.log(
      'PASS two-tab startup, duplicate suppression and transfer using ' +
        (fallback ? 'storage' : 'Web Locks')
    )
  }
} finally {
  await browser.close()
}
