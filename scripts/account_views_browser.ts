// Run with bun scripts/account_views_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const fixture = await Bun.build({
  entrypoints: [
    fileURLToPath(
      new URL('../apps/web/app/lib/__tests__/browser/account_views.tsx', import.meta.url)
    ),
  ],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!fixture.success) throw new AggregateError(fixture.logs)
const js = await fixture.outputs[0].text()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const saved = Promise.withResolvers<void>()
  const requests: string[][] = []
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<body><script type="module" src="/bundle.js"></script></body>',
      })
    if (url.pathname === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript', body: js })
    if (url.pathname !== '/api/servers/club/upload_expiry') return route.abort()
    requests.push([url.host, request.method(), request.headers().authorization])
    if (request.method() === 'PUT') await saved.promise
    await route.fulfill({
      json: {
        upload_expiry: request.postDataJSON() ?? { mode: 'default', seconds: null },
        upload_ttl: null,
      },
    })
  })
  await page.goto('https://shown.test/')
  await page.getByRole('button', { name: 'Reader' }).press('Enter')
  await page.waitForFunction(() => document.body.dataset.owner === '["reader",null]')
  await page.locator('[style*="color-mix"]').filter({ hasText: 'peer' }).waitFor()
  const tileColor = () =>
    page
      .locator('[style*="color-mix"]')
      .filter({ hasText: 'peer' })
      .first()
      .evaluate(el => (el as HTMLElement).style.background)
  assert.match(await tileColor(), /#0033ff|rgb\(0, 51, 255\)/i)
  const saving = page.waitForRequest(req => req.method() === 'PUT')
  await page.getByRole('radio', { name: 'Never' }).click()
  await saving
  await page.getByRole('button', { name: 'Switch account' }).click()
  await page.getByRole('radio', { name: 'Never' }).waitFor()
  assert.match(await tileColor(), /#ff1100|rgb\(255, 17, 0\)/i)
  saved.resolve()
  await page.waitForFunction(() => document.body.dataset.owner === '["reader","never"]')
  assert.equal(await page.locator('body').getAttribute('data-shown'), null)
  assert.deepEqual(requests, [
    ['owner.test', 'GET', 'Bearer owner.test'],
    ['owner.test', 'PUT', 'Bearer owner.test'],
    ['shown.test', 'GET', 'Bearer shown.test'],
  ])
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
