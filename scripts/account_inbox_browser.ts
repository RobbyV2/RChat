// Run with bun scripts/account_inbox_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import type { InboxItem } from '../apps/web/app/lib/types'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/account_inbox.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build inbox fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
  const calls: [string, string, unknown][] = []
  const pending = Promise.withResolvers<void>()
  const until = { friends: 3, groups: 0, pings: 0 }
  await page.route('**/*', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<body><script type="module" src="/bundle.js"></script></body>',
      })
    if (url.pathname === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript', body: js })
    if (!url.pathname.startsWith('/api/inbox')) return route.abort()
    calls.push([url.host, url.pathname, req.postDataJSON()])
    if (url.pathname === '/api/inbox/read_all') await pending.promise
    const items = [1, 2].map((id): InboxItem => ({
      id,
      source: 'friend',
      kind: 'friend_request',
      unread: true,
      created_at: id,
      actor: {
        username: url.hostname.split('.')[0],
        display_name: url.hostname.split('.')[0],
        avatar_kind: 'identicon',
        avatar_color: null,
      },
      emoji: null,
      role: null,
      scope: null,
      server: null,
      server_name: null,
      channel_name: null,
      message_id: null,
      thread_root_id: null,
      content: null,
      media_filename: null,
    }))
    await route.fulfill({ json: req.method() === 'GET' ? { items, next: null, until } : {} })
  })
  await page.goto('https://shown.test/')
  const row = page.locator('[data-inbox-item="instance:friend:2"]')
  await row.filter({ hasText: 'owner' }).waitFor()
  await row.locator('..').getByRole('button', { name: 'Mark as read', exact: true }).click()
  await row.waitFor({ state: 'detached' })
  const markAll = page.waitForRequest(req => req.url().endsWith('/inbox/read_all'))
  await page.getByRole('button', { name: 'Mark all as read' }).click()
  await markAll
  await page.getByRole('button', { name: 'Switch account' }).click()
  await row.filter({ hasText: 'shown' }).waitFor()
  const settled = page.waitForLoadState('networkidle')
  pending.resolve()
  await settled
  assert.deepEqual(errors, [])
  assert.deepEqual(calls, [
    ['owner.test', '/api/inbox', null],
    ['owner.test', '/api/inbox/read', { source: 'friend', id: 2 }],
    ['owner.test', '/api/inbox/read_all', { until }],
    ['shown.test', '/api/inbox', null],
  ])
  console.log(
    'Inbox loads, single reads, bulk reads and pending completion stayed with their provider.'
  )
} finally {
  await browser.close()
}
