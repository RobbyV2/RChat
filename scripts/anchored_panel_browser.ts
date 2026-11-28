// Run with bun scripts/anchored_panel_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/anchored_panel.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build panel fixture')
const js = await bundle.outputs[0].text()
const WIDE = { width: 1000, height: 700 }
const NARROW = { width: 400, height: 700 }
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: WIDE })
  page.setDefaultTimeout(5000)
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<body><script type="module" src="/bundle.js"></script></body>',
      })
    if (url.pathname === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript', body: js })
    return route.abort()
  })
  await page.goto('https://panel.test/')
  const opener = page.getByRole('button', { name: 'Open' })
  const panel = page.getByRole('dialog', { name: 'Panel' })
  const inner = page.getByRole('dialog', { name: 'Inner' })
  const look = () =>
    page.evaluate(() => {
      const el = document.querySelector('[role="dialog"][aria-label="Panel"]')
      const active = document.activeElement
      return {
        same: el?.hasAttribute('data-first') ?? false,
        mode: el?.querySelector('output')?.textContent ?? null,
        modal: el?.getAttribute('aria-modal') ?? null,
        text: el?.querySelector('input')?.value ?? null,
        count: el?.querySelector('button')?.textContent ?? null,
        focus: !active
          ? null
          : active === el
            ? 'panel'
            : el?.contains(active)
              ? 'inside'
              : (active.textContent ?? ''),
      }
    })

  await opener.click()
  await panel.waitFor()
  assert.equal((await look()).focus, 'panel')
  await panel.evaluate(el => el.setAttribute('data-first', ''))
  await page.getByRole('textbox', { name: 'Text' }).fill('kept text')
  await page.getByRole('button', { name: 'Pressed 0' }).click()
  const kept = { same: true, text: 'kept text', count: 'Pressed 1', focus: 'inside' }
  assert.deepEqual(await look(), { ...kept, mode: 'floating', modal: null })
  await page.setViewportSize(NARROW)
  await page.getByText('sheet', { exact: true }).waitFor()
  assert.deepEqual(await look(), { ...kept, mode: 'sheet', modal: 'true' })
  await page.setViewportSize(WIDE)
  await page.getByText('floating', { exact: true }).waitFor()
  assert.deepEqual(await look(), { ...kept, mode: 'floating', modal: null })

  await page.getByRole('button', { name: 'More' }).click()
  await inner.waitFor()
  await page.keyboard.press('Escape')
  await inner.waitFor({ state: 'detached' })
  assert.equal(await panel.count(), 1)
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'More')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open')

  await opener.click()
  await panel.waitFor()
  await page.locator('[data-outside]').click()
  await panel.waitFor({ state: 'detached' })

  await opener.click()
  await panel.waitFor()
  await opener.click()
  await panel.waitFor({ state: 'detached' })
  assert.equal(await panel.count(), 0)

  assert.deepEqual(errors, [])
  console.log(
    'An anchored panel keeps its node and state across modes, closes on Esc from the top down, on a press outside and by its anchor, and gives focus back.'
  )
} finally {
  await browser.close()
}
