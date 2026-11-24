import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const build = await Bun.build({
  entrypoints: ['apps/web/app/lib/__tests__/browser/share_picker.tsx'],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!build.success) throw new AggregateError(build.logs)
const script = await build.outputs[0].text()
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = [],
    discoveries: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let release = Promise.withResolvers<void>()
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<body><script type="module" src="/bundle.js"></script></body>',
      })
    if (url.pathname === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript', body: script })
    if (url.host === 'shown.test' && url.pathname.startsWith('/wasm/')) return route.abort()
    discoveries.push(url.host + url.pathname)
    if (url.pathname === '/api/me') await release.promise
    await route.fulfill({ json: {} })
  })
  const inspect = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          inspectShare: () => { shown: string; pending: (string | null)[]; peerFiles: number[] }
        }
      ).inspectShare()
    )
  const dialog = page.getByRole('dialog', { name: 'Share to RChat' })
  const owner = dialog.getByRole('combobox', { name: 'As', exact: true })
  const destination = dialog.getByRole('combobox', { name: 'Destination', exact: true })
  const drop = async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['fixture'], 'example.txt'))
      document.body.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      )
    })
    await dialog.waitFor()
  }
  const cold = (local: string | null) => JSON.stringify(['https://cold.test', 'reader', local])
  const shown = JSON.stringify(['https://shown.test', 'reader', null])
  for (const cancel of [true, false]) {
    await page.goto('https://shown.test/')
    await page.waitForFunction(() => document.body.dataset.ready === 'true')
    await drop()
    assert.equal(await owner.inputValue(), shown)
    assert.equal(await owner.locator('option').count(), 7)
    assert.deepEqual(discoveries, [])
    assert.doesNotMatch((await dialog.textContent()) ?? '', /Hidden|reader|\.test/i)
    assert.deepEqual(
      await owner
        .locator('optgroup')
        .evaluateAll(groups => groups.map(g => g.getAttribute('label'))),
      ['Instance 1', 'Instance 2', 'Instance 3']
    )
    const requested = page.waitForRequest('https://cold.test/api/me')
    await owner.selectOption(cold('main'))
    await requested
    if (cancel) await dialog.getByRole('button', { name: 'Cancel' }).click()
    else await owner.selectOption(shown)
    const completed = page.waitForResponse('https://cold.test/api/me')
    release.resolve()
    await completed
    if (cancel) await drop()
    await destination.waitFor()
    assert.equal(await owner.inputValue(), shown)
    assert.equal((await inspect()).shown, 'shown.test')
    assert.deepEqual((await inspect()).pending, [null, null, null])
    assert.deepEqual(discoveries.splice(0), ['cold.test/api/me'])
    release = Promise.withResolvers<void>()
  }
  // Cold restore also succeeds when the same selection stays current.
  await page.goto('https://shown.test/')
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await drop()
  const requested = page.waitForRequest('https://cold.test/api/me')
  await owner.selectOption(cold('main'))
  await requested
  release.resolve()
  await destination.waitFor()
  assert.deepEqual(discoveries.splice(0), ['cold.test/api/me'])
  assert.deepEqual(await destination.locator('option').allTextContents(), [
    'Choose a conversation or channel',
    'Peer contact 1',
    'Peer channel 1',
  ])
  await destination.selectOption({ label: 'Peer contact 1' })
  await dialog.getByRole('button', { name: 'Open draft' }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await destination.locator('option', { hasText: 'Peer contact' }).count(), 0)
  assert.deepEqual((await inspect()).peerFiles, [0, 0, 0])
  await owner.selectOption(cold(null))
  await destination.selectOption({ label: 'Direct message 1' })
  await dialog.getByRole('button', { name: 'Open draft' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual((await inspect()).pending, [null, 'example.txt', null])
  assert.equal((await inspect()).shown, 'cold.test')
  assert.deepEqual(discoveries, [])
  assert.deepEqual(errors, [])
  console.log(
    'Passed cold owner selection, cancel and reselection, masked destinations, colliding DM IDs, and late full peer room.'
  )
} finally {
  await browser.close()
}
