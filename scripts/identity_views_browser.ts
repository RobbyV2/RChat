// Run with bun scripts/identity_views_browser.ts and Playwright Chromium installed.
import { encodeConfig } from '../apps/web/app/lib/config_transfer'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import type { Page } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/identity_views.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build identity fixture')
const js = await bundle.outputs[0].text()
const rail = 'A'.repeat(43)
const config = await encodeConfig({
  v: 1,
  layout: {
    servers: [],
    dmOrder: [],
    dmPinned: [],
    selfPin: 'auto',
    p2p: [rail],
  },
})
async function identityExports(page: Page) {
  await page.goto('https://shown.test/?exports')
  const button = (name: string) => page.getByRole('button', { name, exact: true })
  const option = page.getByLabel('Include P2P identity and history')
  const code = page.getByLabel('Config string', { exact: true })
  const result = async () => {
    await button('Show config string').click()
    await page.waitForFunction(
      () => !!document.querySelector<HTMLTextAreaElement>('[aria-label="Config string"]')?.value
    )
    await button('Copy config string').click()
    assert.equal(await page.locator('body').getAttribute('data-copied'), await code.inputValue())
    return JSON.parse(
      inflateRawSync(Buffer.from((await code.inputValue()).slice(4), 'base64url')).toString()
    )
  }
  async function create(files = false) {
    await option.check()
    const pass = page.getByLabel('Passphrase', { exact: true })
    assert.equal(await pass.inputValue(), '')
    await pass.fill('a long fixture passphrase')
    await page.getByLabel('Passphrase again').fill('a long fixture passphrase')
    if (files) await page.getByLabel('Include downloaded attachments').check()
    await button('Create export').click()
  }
  const finish = () => button('Finish export').click()
  const events = () =>
    page.evaluate(() => JSON.parse(document.body.dataset.exportEvents!) as string[])
  await create()
  await finish()
  assert.equal((await result()).p2p.ct, 'work')
  await button('View main').click()
  assert.equal((await result()).p2p, undefined)
  assert.equal(await option.isChecked(), false)
  await create()
  await button('View work').click()
  await finish()
  await page.waitForFunction(() => document.body.dataset.exportEvents?.includes('returned:main'))
  assert.equal((await result()).p2p, undefined)
  await create(true)
  await finish()
  await button('Download file').click()
  await button('Replace work').click()
  await button('Finish picker').click()
  assert.equal((await result()).p2p, undefined)
  assert.equal(await option.isChecked(), false)
  await create(true)
  await finish()
  await button('Download file').click()
  await button('Finish picker').click()
  await page.waitForFunction(() => document.body.dataset.exportEvents?.includes('saved'))
  assert.deepEqual(
    (await events()).filter(e => e.startsWith('files:')),
    ['files:replacement:replacement']
  )
}

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
      await page.goto('https://shown.test')
      const selected = page.getByRole('region', { name: 'Selected identity' })
      const main = page.getByRole('region', { name: 'Main identity' })
      const contact = selected.getByRole('button').first()
      await contact.waitFor()
      assert.match(await selected.innerText(), /Work contact/)
      assert.match(await main.innerText(), /Personal contact/)
      if (viewport.width < 500) {
        const box = await contact.boundingBox()
        assert.ok(box)
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        })
        await page.getByText('Rename', { exact: true }).waitFor()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await cdp.detach()
      } else await contact.click({ button: 'right' })
      await page.getByText('Rename', { exact: true }).click()
      assert.equal(await selected.locator('output').innerText(), 'rename')
      assert.equal(await main.locator('output').innerText(), 'closed')
      await page.getByLabel('Config string to import').fill(config)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()
      await page.getByRole('button', { name: 'Apply', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Show main' }).click()
      await page.getByRole('button', { name: 'Apply', exact: true }).click()
      await page.getByText('Config applied', { exact: true }).waitFor()
      assert.equal(await page.getByLabel('Work rail').innerText(), JSON.stringify([rail]))
      assert.equal(await page.getByLabel('Main rail').innerText(), '[]')
      await page.getByRole('button', { name: 'Show work' }).click()
      await page.getByLabel('Config string to import').fill(config)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()
      await page.getByLabel('What will change').getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Remove work' }).click()
      await page.getByRole('button', { name: 'Apply', exact: true }).click()
      await page.getByText('The selected P2P identity is no longer available').waitFor()
      assert.equal(await page.getByLabel('Main rail').innerText(), '[]')
      await contact.waitFor({ state: 'detached' })
      assert.equal(await selected.locator('output').innerText(), 'closed')
      await page.getByRole('button', { name: 'Show main' }).click()
      assert.match(await selected.innerText(), /Personal contact/)
      await page.goto('https://shown.test/?calls')
      const cancel = page.getByRole('button', { name: 'Cancel call' })
      await cancel.waitFor()
      await page.getByRole('button', { name: 'Show work call view' }).click()
      await cancel.waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Show main call view' }).click()
      await cancel.waitFor()
      for (const kind of ['contact', 'voice']) {
        for (const bg of [false, true]) {
          await page.goto('https://shown.test/?dock=' + kind + (bg ? '&background' : ''))
          const voice = kind === 'voice'
          await page
            .getByTitle(voice ? 'Go to voice channel' : 'Go to call')
            .first()
            .click()
          if (bg) {
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
          } else {
            await page
              .locator(voice ? '[data-p2p-voice-pane] .stage' : '[data-p2p-stage] .stage')
              .waitFor()
            assert.equal(await page.getByRole('dialog').count(), 0)
          }
        }
      }
      await identityExports(page)
      await page.goto('https://shown.test/?enroll')
      await page
        .getByRole('heading', { name: 'Keep your P2P identity in an app you trust' })
        .waitFor()
      assert.equal(await page.getByLabel('Identity name').count(), 0)
      await page.getByRole('button', { name: 'I trust this app' }).click()
      assert.equal(
        await page.getByLabel('Attach to account').locator('option:checked').innerText(),
        'sam@owner.test'
      )
      await page.getByLabel('Identity name').fill('Work')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Create without a recovery phrase' }).click()
      await page.waitForFunction(() => document.body.dataset.finished === 'yes')
      const peers = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('rchat_book')!).instances.find(
            (i: { id: string }) => i.id === 'owner'
          ).accounts[0].identities
      )
      assert.equal(peers.length, 2)
      assert.ok(
        peers.some((i: { local: string; name: string }) => i.local !== 'main' && i.name === 'Work')
      )
      assert.deepEqual(errors, [])
      await page.close()
    }
} finally {
  await browser.close()
}
