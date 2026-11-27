// Run with bun scripts/sheet_modes_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/sheet_modes.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build sheet fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
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
  await page.goto('https://sheet.test/')
  const panel = page.getByRole('dialog', { name: 'Panel' })
  const text = page.getByRole('textbox', { name: 'Text' })
  await text.fill('kept text')
  await page.getByRole('button', { name: 'Pressed 0' }).click()
  await page.getByRole('button', { name: 'Pressed 1' }).click()
  await text.focus()
  await panel.evaluate(el => el.setAttribute('data-first', ''))
  const look = () =>
    page.evaluate(() => {
      const el = document.querySelector('[role="dialog"]')
      const input = document.querySelector('input')
      return {
        same: el?.hasAttribute('data-first') ?? false,
        modal: el?.getAttribute('aria-modal') ?? null,
        backdrops: document.querySelectorAll('[data-backdrop]').length,
        text: input?.value ?? null,
        focused: document.activeElement === input,
        count: el?.querySelector('button')?.textContent ?? null,
      }
    })
  assert.deepEqual(await look(), {
    same: true,
    modal: 'true',
    backdrops: 1,
    text: 'kept text',
    focused: true,
    count: 'Pressed 2',
  })
  const turn = () =>
    page.evaluate(() => document.querySelector<HTMLElement>('[data-turn]')?.click())
  await turn()
  assert.deepEqual(await look(), {
    same: true,
    modal: null,
    backdrops: 0,
    text: 'kept text',
    focused: true,
    count: 'Pressed 2',
  })
  await turn()
  assert.deepEqual(await look(), {
    same: true,
    modal: 'true',
    backdrops: 1,
    text: 'kept text',
    focused: true,
    count: 'Pressed 2',
  })
  assert.deepEqual(errors, [])
  console.log('A sheet that turns into a floating panel and back keeps its node, state and focus.')
} finally {
  await browser.close()
}
