// Run with bun scripts/account_controls_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const bundle = await Bun.build({
  entrypoints: ['apps/web/app/lib/__tests__/browser/account_controls.tsx'],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build account controls fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors: Error[] = []
  page.on('pageerror', error => {
    errors.push(error)
    console.error(error)
  })
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript', body: js })
    if (path !== '/') return route.fulfill({ json: [] })
    return route.fulfill({
      contentType: 'text/html',
      body: '<body><script type="module" src="/bundle.js"></script></body>',
    })
  })
  await page.goto('https://shown.test/')
  const home = page.getByRole('region', { name: 'Home', exact: true })
  const messages = page.getByRole('region', { name: 'Messages', exact: true })
  const palette = page.locator('[data-palette-input]')
  await home.locator('[data-palette-button]').waitFor()
  for (const guard of ['confirm', 'preview', 'viewing'] as const) {
    await page.evaluate(guard => window.accountControls.guard(guard), guard)
    await page.keyboard.press('Control+k')
    assert.equal(await page.evaluate(() => window.accountControls.actor()), null, guard)
  }
  await page.evaluate(() => window.accountControls.guard(null))

  await home.locator('[data-palette-button]').click()
  assert.equal(await page.evaluate(() => window.accountControls.actor()), 'owner.test')
  await page.keyboard.press('Control+k')
  const openPoll = async () => {
    await home
      .getByRole('button', { name: /Command palette/ })
      .filter({ hasText: 'Command palette' })
      .click()
    assert.equal(await page.evaluate(() => window.accountControls.actor()), 'owner.test')
    await palette.fill('Create poll')
    await page.locator('[data-palette-item="poll"]').click()
  }
  await openPoll()
  const question = page.getByPlaceholder('What do you want to ask?')
  await question.fill('Lunch?')
  await page.keyboard.press('Control+k')
  assert.equal(await page.evaluate(() => window.accountControls.actor()), 'shown.test')
  await page.keyboard.press('Control+k')
  assert.equal(await question.inputValue(), 'Lunch?')
  await page.getByLabel('Option 1', { exact: true }).fill('Soup')
  await page.getByLabel('Option 2', { exact: true }).fill('Sandwich')
  await page.getByRole('button', { name: 'Post poll' }).click()
  assert.equal(await page.locator('body').getAttribute('data-post'), 'owner.test/thread/12')
  await page.evaluate(() => window.accountControls.replacePoll())
  await question.fill('Replacement')
  await page.evaluate(() => window.accountControls.finishPost())
  assert.equal(await question.inputValue(), 'Replacement')
  await page
    .getByRole('dialog', { name: 'Create poll' })
    .getByRole('button', { name: 'Cancel' })
    .click()

  const selected = () => page.evaluate(() => window.accountControls.selected())
  const mainRow = messages.locator('[data-mid="12"]')
  await messages.getByRole('button', { name: 'Select messages' }).click()
  await messages.getByRole('checkbox', { name: 'Select message' }).click()
  assert.deepEqual(await selected(), [null, { scope: 'c1', ids: [12], all: false, ranging: false }])
  await messages
    .getByRole('toolbar', { name: 'Selected messages' })
    .getByRole('button', { name: 'Stop selecting' })
    .click()
  await mainRow.getByText('Root message', { exact: true }).click({ modifiers: ['Control'] })
  assert.deepEqual((await selected())[1]?.ids, [12])
  await page.keyboard.press('Control+Shift+s')
  assert.deepEqual(await selected(), [null, null])
  await page.locator('[data-thread-panel] button').first().focus()
  await page.keyboard.press('Control+Shift+s')
  await page.keyboard.press('Control+a')
  assert.deepEqual(await selected(), [null, { scope: 't12', ids: [], all: true, ranging: false }])
  await page.keyboard.press('Control+Shift+s')
  await messages.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.locator('body').getAttribute('data-cancel'), 'owner.test/6')

  await page.setViewportSize({ width: 420, height: 900 })
  await page.keyboard.press('Control+Shift+s')
  await messages.getByRole('button', { name: 'Select range' }).click()
  await mainRow.getByText('Root message', { exact: true }).click()
  assert.deepEqual(await selected(), [null, { scope: 'c1', ids: [12], all: false, ranging: true }])
  await messages.getByRole('button', { name: 'Stop selecting' }).last().click()
  await page.setViewportSize({ width: 1280, height: 900 })

  for (const writable of [true, false]) {
    await page.evaluate(writable => window.accountControls.writable(writable), writable)
    for (const row of [mainRow, page.locator('[data-thread-panel] [data-mid="13"]')]) {
      await row.locator('p').first().click({ button: 'right' })
      const menu = page.getByRole('menu')
      await menu.waitFor()
      assert.equal(
        await menu.getByRole('button', { name: 'Add reaction' }).count(),
        writable ? 1 : 0
      )
      await page.keyboard.press('Escape')
    }
  }
  await openPoll()
  await page.keyboard.press('Control+k')
  await page.evaluate(() => window.accountControls.disposeOwner())
  await question.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.accountControls.actor()), 'shown.test')
  assert.deepEqual(errors, [])
  console.log(
    'Passed two-account palette, poll lifetime, shortcut guards, selection controls and reaction headers'
  )
} finally {
  await browser.close()
}
