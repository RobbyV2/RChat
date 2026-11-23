// Run with bun scripts/account_overlays_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { chromium } from 'playwright-core'

const local = (path: string) => fileURLToPath(new URL('../' + path, import.meta.url))
const bundle = await Bun.build({
  entrypoints: [local('apps/web/app/lib/__tests__/browser/account_overlays.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build overlay fixture')
const js = await bundle.outputs[0].text()
const stylePath = local('apps/web/app/globals.css')
const { css } = await postcss([tailwind({ base: local('apps/web') })]).process(
  await Bun.file(stylePath).text(),
  { from: stylePath }
)
const example = local('apps/web/public/app-examples/field-notes.json')
const browser = await chromium.launch()
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const colorScheme of ['dark', 'light'] as const) {
      const page = await browser.newPage({ viewport, colorScheme, hasTouch: viewport.width < 500 })
      const errors: Error[] = []
      page.on('pageerror', error => errors.push(error))
      page.setDefaultTimeout(5000)
      let blob: string | null = null
      const calls: (string | undefined)[][] = []
      const link = { id: 'AbC123xyz789', expires_at: Math.floor(Date.now() / 1000) + 3600 }
      await page.route('**/*', async route => {
        const req = route.request()
        const url = new URL(req.url())
        if (url.pathname.includes('/config_shares')) {
          calls.push([url.host, req.headers().authorization, req.method(), url.pathname])
          let result
          if (req.method() === 'POST') {
            blob = req.postDataJSON().blob
            result = link
          } else if (req.method() === 'DELETE') {
            blob = null
            result = { ok: true }
          } else if (url.pathname.endsWith(link.id)) result = { ...link, blob }
          else result = blob ? [link] : []
          return route.fulfill({ json: result })
        }
        if (url.pathname === '/bundle.js')
          return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: js })
        if (url.pathname !== '/') return route.abort()
        await route.fulfill({
          contentType: 'text/html',
          body: `<html data-theme="${colorScheme}"><meta name="viewport" content="width=device-width"><style>${css}</style><body><script type="module" src="/bundle.js"></script></body></html>`,
        })
      })
      await page.goto('https://shown.test/')
      const button = (name: string) => page.getByRole('button', { name, exact: true })
      await button('P2P settings').click()
      const opener = button('Turn on P2P')
      await opener.click()
      const dialog = page.getByRole('dialog', { name: 'Turn on peer-to-peer' })
      assert(
        await dialog.evaluate(el => el.matches(':modal') && el.contains(document.activeElement))
      )
      await dialog.getByLabel('P2P display name').fill('Reader')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert(await opener.evaluate(el => el === document.activeElement))
      await opener.click()
      await button('Cancel').click()
      await button('Close settings').click()

      await button('Owner settings').click()
      await button('Create link').click()
      const share = 'https://owner.test/config/' + link.id + '/'
      await page.getByLabel('Config link', { exact: true }).waitFor()
      assert.equal(await page.getByLabel('Config link', { exact: true }).inputValue(), share)
      assert.equal(await page.locator('[data-qr]').getAttribute('data-qr'), share)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page
        .getByRole('listitem')
        .filter({ hasText: link.id })
        .getByRole('button', { name: 'Copy link' })
        .click()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), share)
      await page.getByLabel('Config string to import').fill(share)
      await button('Preview').click()
      await page.getByRole('list', { name: 'What will change' }).waitFor()
      await button('Revoke link').click()
      await button('Revoke link').waitFor({ state: 'detached' })
      assert.deepEqual(
        calls,
        [
          ['GET', ''],
          ['POST', ''],
          ['GET', ''],
          ['GET', '/' + link.id],
          ['DELETE', '/' + link.id],
          ['GET', ''],
        ].map(([method, suffix]) => [
          'owner.test',
          'Bearer owner-token',
          method,
          '/api/config_shares' + suffix,
        ])
      )
      await button('Close settings').click()

      const owner = page.getByRole('region', { name: 'Owner account rail and overlays' })
      const shown = page.getByRole('region', { name: 'Shown account overlays' })
      const tile = owner.getByTitle('Garden', { exact: true })
      if (viewport.width < 500) {
        await tile.scrollIntoViewIfNeeded()
        const box = await tile.boundingBox()
        assert(box)
        const touch = await page.context().newCDPSession(page)
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        })
        await page.waitForFunction(() => document.querySelector('[data-lifted]') !== null)
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await touch.detach()
      } else {
        await tile.click({ button: 'right' })
      }
      const previews = owner.getByRole('menuitem', { name: 'App previews', exact: true })
      await previews.waitFor()
      assert.equal(await shown.getByRole('menu').count(), 0)
      if (viewport.width < 500) await previews.tap()
      else await previews.click()
      await owner.getByRole('dialog', { name: 'App previews' }).waitFor()
      assert.equal(await shown.getByRole('dialog', { name: 'App previews' }).count(), 0)
      await page.getByLabel('Choose app definition').setInputFiles(example)
      const consent = page.getByRole('dialog', { name: 'Open this app?' })
      await consent.getByRole('button', { name: 'Open', exact: true }).click()
      await page.getByRole('region', { name: 'App: Field notes' }).waitFor()
      await button('Close').click()
      await page.getByRole('dialog', { name: 'App previews' }).waitFor({ state: 'detached' })
      await button('Ring owner').click()
      const ring = page.getByRole('alertdialog', { name: 'Incoming call' })
      assert.match(await ring.innerText(), /reader@owner.test/)
      await ring.getByRole('button', { name: 'Decline' }).click()
      await ring.waitFor({ state: 'detached' })
      await button('Ring owner').click()
      await ring.getByRole('button', { name: 'Accept' }).click()
      await page
        .getByRole('dialog', { name: 'Switch call?' })
        .getByRole('button', { name: 'Switch', exact: true })
        .click()

      const relayOpener = button('Prompt both relays')
      await relayOpener.click()
      const relay = page.getByRole('dialog', { name: 'Unknown relay' })
      const ownerRelay = relay.filter({ hasText: 'relay.owner.test' })
      assert(
        await ownerRelay
          .getByRole('button', { name: 'Deny' })
          .evaluate(el => el === document.activeElement)
      )
      await page.keyboard.press('Escape')
      await ownerRelay.waitFor({ state: 'detached' })
      await relay.getByRole('button', { name: 'Allow once' }).click()
      assert(await relayOpener.evaluate(el => el === document.activeElement))
      assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.events!)), [
        'owner.test call_decline',
        'owner DM 3 none',
        'left shown call',
        'owner.test capture',
        'owner.test call_accept',
        'owner.test deny',
        'shown.test once',
      ])
      const dm = page.getByRole('region', { name: 'Other DM' })
      const handoff = page.getByRole('dialog', { name: 'Switch call?' })
      const contact = page.getByRole('region', { name: 'Online contact' })
      await contact.getByRole('button', { name: 'Call, direct (P2P)', exact: true }).click()
      await handoff.getByRole('button', { name: 'Cancel' }).click()
      await dm.getByRole('button', { name: 'Call', exact: true }).click()
      await handoff.getByRole('button', { name: 'Cancel' }).click()

      const options = dm.getByRole('button', { name: 'Call options', exact: true })
      if (viewport.width < 500) await options.tap()
      else if (colorScheme === 'dark') await options.click()
      else await options.press('Enter')
      const route = owner.getByRole('menuitemradio', { name: 'Through server' })
      if (viewport.width < 500) await route.tap()
      else if (colorScheme === 'dark') await route.click()
      else await route.press('Enter')
      await handoff.getByRole('button', { name: 'Switch', exact: true }).click()
      assert.deepEqual(
        await page.evaluate(() => JSON.parse(document.body.dataset.events!).slice(-3)),
        ['owner.test call_leave', 'owner.test capture', 'owner.test call_start']
      )
      assert.deepEqual(errors, [])
      await page.close()
      console.log(`Passed ${viewport.width}x${viewport.height} ${colorScheme}`)
    }
  }
} finally {
  await browser.close()
}
