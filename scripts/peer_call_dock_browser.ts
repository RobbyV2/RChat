// Run with bun scripts/peer_call_dock_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/peer_call_dock.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build call fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ])
    for (const colorScheme of ['dark', 'light'] as const) {
      const page = await browser.newPage({ viewport, colorScheme, hasTouch: viewport.width < 500 })
      page.setDefaultTimeout(6000)
      const errors: Error[] = []
      page.on('pageerror', err => errors.push(err))
      await page.route('**/*', route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<body><script type="module" src="/bundle.js"></script></body>',
          })
        if (path === '/bundle.js')
          return route.fulfill({ contentType: 'application/javascript', body: js })
        return route.abort()
      })
      for (const kind of ['contact', 'voice']) {
        for (const bg of [false, true]) {
          await page.goto('https://shown.test/?' + kind + (bg ? '&background' : ''))
          const voice = kind === 'voice'
          await page
            .getByTitle(voice ? 'Go to voice channel' : 'Go to call')
            .first()
            .click()
          const dialog = page.getByRole('dialog', {
            name: voice ? 'Voice channel' : 'Call',
            exact: true,
          })
          await dialog.locator('.stage').waitFor()
          await page.evaluate(() =>
            (window as Window & { confirmOverCall(): void }).confirmOverCall()
          )
          const confirm = page.getByRole('dialog', { name: 'Confirm action' })
          await confirm.waitFor()
          await page.keyboard.press('Escape')
          await confirm.waitFor({ state: 'detached' })
          await dialog.locator('.stage').waitFor()
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'detached' })
          const go = page.getByTitle(voice ? 'Go to voice channel' : 'Go to call').first()
          await go.click()
          await dialog.getByRole('button', { name: 'Close', exact: true }).click()
          await dialog.waitFor({ state: 'detached' })
          await go.waitFor()
        }
      }
      assert.deepEqual(errors, [])
      await page.close()
    }
} finally {
  await browser.close()
}
