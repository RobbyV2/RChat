// Run with bun scripts/account_palette_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const bundle = await Bun.build({
  entrypoints: ['apps/web/app/lib/__tests__/browser/account_palette.tsx'],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build palette fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
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
  const shown = page.getByRole('region', { name: 'Shown', exact: true })
  const owner = page.getByRole('region', { name: 'Owner', exact: true })
  const clearHistory = owner.getByRole('button', { name: 'Clear request history' })
  await clearHistory.click()
  assert(await clearHistory.isDisabled())
  assert(await shown.getByRole('button', { name: 'Clear request history' }).isEnabled())
  const forget = owner.getByRole('button', { name: 'Forget recent commands' })
  await forget.click()
  assert(await forget.isDisabled())
  assert(await shown.getByRole('button', { name: 'Forget recent commands' }).isEnabled())

  const tip = owner.locator('[data-tip]').first()
  const id = await tip.getAttribute('data-tip')
  await tip.getByRole('button', { name: 'Dismiss tip' }).click()
  assert.equal(await owner.locator(`[data-tip="${id}"]`).count(), 0)
  assert.equal(await shown.locator(`[data-tip="${id}"]`).count(), 1)
  await owner.getByRole('button', { name: 'Got it', exact: true }).click()
  assert.equal(await owner.locator('[data-filter-note]').count(), 0)
  assert.equal(await shown.locator('[data-filter-note]').count(), 1)
  await owner.locator('[data-recent]').click({ button: 'right' })
  await owner.getByText('Remove from Jump back in', { exact: true }).click()
  assert.equal(await owner.locator('[data-recent]').count(), 0)
  assert.equal(await shown.locator('[data-recent]').count(), 1)

  const ownerMessages = owner
    .locator('[data-index-size] dt', { hasText: 'Messages' })
    .locator('+ dd')
  const shownMessages = shown
    .locator('[data-index-size] dt', { hasText: 'Messages' })
    .locator('+ dd')
  assert.equal(await ownerMessages.textContent(), '1')
  await owner.getByRole('button', { name: 'Clear index' }).click()
  await owner.getByText('Cleared', { exact: true }).waitFor()
  assert.equal(await ownerMessages.textContent(), '0')
  assert.equal(await shownMessages.textContent(), '1')
  await owner.getByRole('radio', { name: 'Off', exact: true }).click()
  assert.equal(await owner.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked'), 'true')
  assert.equal(
    await shown.getByRole('radio', { name: 'Loaded only' }).getAttribute('aria-checked'),
    'true'
  )

  // A second tab restores only the background account's persisted history.
  const otherTab = await page.context().newPage()
  await otherTab.route('**/*', route =>
    route.fulfill({ contentType: 'text/html', body: '<body></body>' })
  )
  await otherTab.goto('https://shown.test/')
  await otherTab.evaluate(() => {
    const key = 'rchat_api_history:reader'
    localStorage.setItem(key + '@owner.test', localStorage.getItem(key)!)
  })
  await clearHistory.click()
  assert(await clearHistory.isDisabled())
  await page.goto('https://shown.test/?results')
  await owner.getByRole('radio', { name: 'Loaded only', exact: true }).click()
  await page.keyboard.press('Control+k')
  const input = page.locator('[data-palette-input]')
  await input.fill('Hidden notebook')
  await page.getByRole('option', { name: /Search the server/ }).waitFor()
  assert.equal(await page.locator('[data-palette-item="thread_14"]').count(), 0)
  await input.fill('Willow')
  const dm = page.locator('[data-palette-item="dm_72"]')
  await dm.locator('[data-masked-word]').waitFor()
  assert.equal(await page.locator('[data-palette-owner]').count(), 0)
  assert.doesNotMatch((await dm.textContent()) ?? '', /Willow/)
  await dm.hover()
  await input.press('Alt+Enter')
  await dm.getByText('Willow', { exact: true }).waitFor()
  await input.press('Enter')
  assert.equal(await page.locator('body').getAttribute('data-selection'), 'owner/dm/72')
  assert.equal(await page.locator('body').getAttribute('data-foreground'), 'selected')
  await page.keyboard.press('Control+k')
  await input.fill('Rocket notebook')
  await page.locator('[data-palette-item^="message_"]').first().click()
  assert.equal(await page.locator('body').getAttribute('data-selection'), 'owner/message/37')
  await page.goto('https://shown.test/?results&grouped')
  const foreignRequests: string[] = []
  let foreignHost = 'shown.test'
  page.on('request', r => {
    const url = new URL(r.url())
    if (url.host === foreignHost && url.pathname.startsWith('/api/'))
      foreignRequests.push(url.pathname)
  })
  await owner.getByRole('button', { name: 'Command palette', exact: true }).click()
  await input.fill('>Switch to')
  for (const host of ['shown.test', 'owner.test']) {
    await page.getByRole('option', { name: 'Switch to Reader on ' + host }).waitFor()
    await page.getByRole('option', { name: 'Switch to Field on ' + host }).waitFor()
  }
  await input.fill('#Hidden notebook')
  const thread = page.locator('[data-palette-item="thread_14"]')
  await thread.waitFor()
  await page
    .getByRole('button', { name: 'Block thread author' })
    .evaluate(el => (el as HTMLButtonElement).click())
  await thread.waitFor({ state: 'detached' })
  assert.doesNotMatch(await page.getByRole('listbox').innerText(), /Hidden notebook/)
  await input.fill('Willow')
  const foreign = page
    .getByRole('group', { name: /reader · shown.test · Go to/ })
    .getByRole('option')
  await foreign.locator('[data-masked-word]').waitFor()
  assert.doesNotMatch((await foreign.textContent()) ?? '', /Willow/)
  await foreign.hover()
  await page.getByText('Alt+Enter Show masked text').waitFor()
  await input.press('Alt+Enter')
  await foreign.getByText('Willow', { exact: true }).waitFor()
  await input.press('Escape')
  foreignHost = 'owner.test'
  await shown.getByRole('button', { name: 'Command palette', exact: true }).click()
  await input.fill('Willow')
  const search = page.locator('[data-palette-item="search_server"]')
  await search.hover()
  await input.press('Alt+Enter')
  assert.doesNotMatch(await search.innerText(), /Willow/)
  assert.equal(await search.locator('[data-masked-word]').count(), 0)
  assert.equal(await page.locator('body').getAttribute('data-selection'), null)
  assert.deepEqual(foreignRequests, [])
  assert.deepEqual(errors, [])
  console.log(
    'Passed account palette settings, blocked threads, foreground selection, same-brand Switch rows and single/foreign filtered-word reveal'
  )
} finally {
  await browser.close()
}
