// Run with bun scripts/account_components_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright-core'

const entry = fileURLToPath(
  new URL('../apps/web/app/lib/__tests__/browser/account_components.tsx', import.meta.url)
)
const bundle = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build component fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const touch = viewport.width < 400
      const page = await browser.newPage({ viewport, colorScheme, hasTouch: touch })
      const activate = async (control: Locator) => {
        if (touch) return control.tap()
        await control.focus()
        await page.keyboard.press('Enter')
      }
      page.setDefaultTimeout(5000)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const pending = Promise.withResolvers<void>()
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<body><script type="module" src="/bundle.js"></script></body>',
          })
        if (url.pathname === '/bundle.js')
          return route.fulfill({ contentType: 'application/javascript', body: js })
        if (url.pathname.endsWith('/admin/servers'))
          return route.fulfill({ json: { items: [], next: null } })
        if (!url.pathname.endsWith('/admin/config')) return route.abort()
        if (url.host === 'owner.test') await pending.promise
        return route.fulfill({
          json: {
            controls: [
              {
                key: 'default_servers',
                env: url.host,
                value: 'lobby',
                config: null,
                pinned: false,
              },
            ],
            limits: [],
          },
        })
      })
      await page.goto('https://shown.test')
      const shown = page.getByRole('region', { name: 'Shown' })
      const owner = page.getByRole('region', { name: 'Owner' })
      await shown.getByText('shown.test', { exact: true }).waitFor()
      assert.equal(await owner.locator('output').innerText(), 'Loading')
      assert.equal(
        await shown.getByRole('link', { name: 'Open message' }).getAttribute('target'),
        '_blank'
      )
      await activate(owner.getByRole('link', { name: 'Open message' }))
      assert.equal(
        await page.locator('body').getAttribute('data-opened'),
        JSON.stringify(['owner.test', 7])
      )
      const reveal = (pane: Locator) => pane.getByRole('button', { name: 'Reveal preview' })
      const dialog = page.getByRole('dialog', { name: 'Open sensitive channel?' })
      const content = (pane: Locator) => pane.getByText('Private source preview', { exact: true })
      const singer = (pane: Locator) => pane.getByText('singer', { exact: true })
      const memberAttribute = 'data-members-' + (await owner.getAttribute('data-account'))
      await activate(reveal(shown))
      if (colorScheme === 'light') {
        const remember = dialog.getByRole('checkbox', { name: 'Remember on this device' })
        if (touch) await remember.tap()
        else await remember.press('Space')
      }
      await activate(dialog.getByRole('button', { name: 'Open', exact: true }))
      await content(shown).waitFor()
      await singer(shown).first().waitFor()
      pending.resolve()
      await owner.getByText('owner.test', { exact: true }).waitFor()
      assert.equal(await shown.locator('output').innerText(), 'shown.test')
      assert.equal(await content(owner).count(), 0)
      assert.equal(await singer(owner).count(), 0)
      assert.equal(await page.locator('body').getAttribute(memberAttribute), null)
      await activate(reveal(owner))
      await activate(dialog.getByRole('button', { name: 'Cancel' }))
      assert.equal(await content(owner).count(), 0)
      await activate(reveal(owner))
      await activate(dialog.getByRole('button', { name: 'Open', exact: true }))
      await content(owner).waitFor()
      await singer(owner).first().waitFor()
      await page.locator(`body[${memberAttribute}="singer"]`).waitFor()

      const button = (name: string) => owner.getByRole('button', { name, exact: true })
      const submit = async () => {
        const field = owner.getByRole('textbox', { name: 'Add a default server' })
        await field.fill('studio')
        if (touch) await button('Add').tap()
        else await field.press('Enter')
        await page.locator('body[data-lookup="pending"]').waitFor()
      }
      const saved = () => page.locator('body').getAttribute('data-saved')
      await submit()
      await activate(button('Toggle admin form'))
      await activate(button('Toggle admin form'))
      await activate(button('Finish lookup'))
      assert.equal(await saved(), null)
      await submit()
      await activate(button('End owner lifetime'))
      await activate(button('Finish lookup'))
      assert.equal(await saved(), null)
      await submit()
      await activate(button('Refresh config'))
      await activate(button('Finish lookup'))
      const expectedSave = JSON.stringify([['owner.test', ['lobby', 'garden', 'studio']]])
      assert.equal(await saved(), expectedSave)
      await submit()
      await activate(button('Clear config'))
      await activate(button('Finish lookup'))
      assert.equal(await saved(), expectedSave)
      await activate(page.getByRole('button', { name: 'Close owner' }))
      await owner.waitFor({ state: 'detached' })
      assert.equal(await shown.locator('output').innerText(), 'shown.test')
      assert.deepEqual(errors, [])
      await page.close()
    }
  }
} finally {
  await browser.close()
}
