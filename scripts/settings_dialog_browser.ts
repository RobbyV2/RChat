// Run with bun scripts/settings_dialog_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { chromium, type Browser, type Page } from 'playwright-core'

const local = (path: string) => fileURLToPath(new URL('../' + path, import.meta.url))
const bundle = await Bun.build({
  entrypoints: [local('apps/web/app/lib/__tests__/browser/settings_dialogs.tsx')],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build settings fixture')
const js = await bundle.outputs[0].text()
const stylePath = local('apps/web/app/globals.css')
const { css } = await postcss([tailwind({ base: local('apps/web') })]).process(
  await Bun.file(stylePath).text(),
  { from: stylePath }
)

type Scheme = 'dark' | 'light'
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

const open = async (
  browser: Browser,
  hash: string,
  { viewport = DESKTOP, scheme = 'dark' as Scheme, anim = false } = {}
) => {
  const page = await browser.newPage({
    viewport,
    colorScheme: scheme,
    hasTouch: viewport.width < 500,
  })
  const errors: Error[] = []
  page.on('pageerror', error => errors.push(error))
  page.setDefaultTimeout(5000)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/bundle.js')
      return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: js })
    if (url.pathname !== '/') return route.fulfill({ status: 404, json: { error: 'Not found' } })
    await route.fulfill({
      contentType: 'text/html',
      body: `<html data-theme="${scheme}"><meta name="viewport" content="width=device-width"><style>${css}</style><body><script type="module" src="/bundle.js"></script></body></html>`,
    })
  })
  await page.goto(`https://settings.test/${anim ? '?anim' : ''}#${hash}`)
  await page.locator('main > *').first().waitFor({ state: 'attached' })
  return { page, errors }
}

const dialogs = (page: Page) => page.locator('[role="dialog"]').count()

// Elements that stick out past the sides of the screen.
const sticksOut = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] *')]
      .filter(e => (e as HTMLElement).offsetParent !== null)
      .filter(e => {
        const r = e.getBoundingClientRect()
        return r.right > innerWidth + 0.5 || r.left < -0.5
      })
      .map(e => e.outerHTML.slice(0, 80))
  )

const flashes = (page: Page, row: string) =>
  page.waitForFunction(id => document.getElementById(id)?.hasAttribute('data-flash'), row)

const browser = await chromium.launch()
try {
  // Every dialog fits both screens in both themes.
  for (const viewport of [DESKTOP, PHONE])
    for (const scheme of ['dark', 'light'] as const)
      for (const hash of ['settings/general', 'server', 'p2p/channels']) {
        const { page, errors } = await open(browser, hash, { viewport, scheme })
        const box = await page.locator('[role="dialog"]').boundingBox()
        assert(box)
        if (viewport === PHONE) {
          assert.deepEqual([box.x, box.width], [0, PHONE.width])
          assert.equal(Math.round(box.y + box.height), PHONE.height)
        } else assert.equal(box.width, 1120)
        assert.deepEqual(await sticksOut(page), [])
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth),
          viewport.width
        )
        assert.deepEqual(errors, [])
        await page.close()
      }

  {
    // A part of a section scrolls to its row and flashes it, again on every click.
    const { page, errors } = await open(browser, 'settings/general')
    await page.locator('[data-settings-part="user_streamer"]').click()
    await flashes(page, 'row-user_streamer')
    assert(await page.locator('#row-user_streamer').isVisible())
    await page.waitForFunction(
      () => !document.getElementById('row-user_streamer')?.hasAttribute('data-flash')
    )
    await page.locator('#row-user_status').scrollIntoViewIfNeeded()
    await page.locator('[data-settings-part="user_streamer"]').click()
    await flashes(page, 'row-user_streamer')
    // A search hit does the same when picked twice.
    for (let i = 0; i < 2; i++) {
      await page.getByRole('searchbox', { name: 'Search settings' }).fill('light theme')
      await page.keyboard.press('Enter')
      await flashes(page, 'row-user_theme')
      await page.waitForFunction(
        () => !document.getElementById('row-user_theme')?.hasAttribute('data-flash')
      )
    }
    // Without motion the flash has no fade.
    const fades = await page
      .locator('#row-user_theme')
      .evaluate(e => getComputedStyle(e).transitionDuration)
    assert.equal(fades, '0s')
    // Tab stays inside, Esc clears the search, then closes.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab')
      assert(
        await page.evaluate(() =>
          document.querySelector('[role="dialog"]')!.contains(document.activeElement)
        )
      )
    }
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('zzz')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('searchbox', { name: 'Search settings' }).inputValue(), '')
    await page.keyboard.press('Escape')
    assert.equal(await dialogs(page), 0)
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // With motion the flash fades.
    const { page } = await open(browser, 'settings/general', { anim: true })
    const fades = await page
      .locator('#row-user_theme')
      .evaluate(e => getComputedStyle(e).transitionDuration)
    assert.equal(fades, '0.5s')
    await page.close()
  }

  {
    // Focus goes back to the opener after a deep link that focused a field.
    const { page, errors } = await open(browser, 'focus')
    await page.locator('[data-opener]').focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('About me').waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA')
    await page.keyboard.press('Escape')
    assert.equal(await dialogs(page), 0)
    assert(await page.locator('[data-opener]').evaluate(e => e === document.activeElement))
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // A dialog inside a blurred large dialog places itself against the screen, not the backdrop.
    const { page, errors } = await open(browser, 'nested', { anim: true })
    await page.getByRole('button', { name: 'Open inner' }).click()
    const backdrop = page.getByRole('dialog', { name: 'Inner' }).locator('xpath=..')
    const box = await backdrop.boundingBox()
    assert(box)
    assert.deepEqual([box.y, box.y + box.height], [32, DESKTOP.height])
    const blurred = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter(e => getComputedStyle(e).backdropFilter !== 'none')
        .map(e => e.childElementCount)
    )
    assert.deepEqual(blurred, [0])
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // Hosted server settings: every section opens, Esc and the backdrop close them.
    const { page, errors } = await open(browser, 'server')
    const sections = await page
      .locator('[data-settings-section]')
      .evaluateAll(list => list.map(e => e.getAttribute('data-settings-section')))
    assert.equal(sections[0], 'invites')
    assert(sections.includes('delete'))
    for (const id of sections) {
      await page.locator(`[data-settings-section="${id}"]`).click()
      await page.locator(`[data-settings-section="${id}"][aria-current="page"]`).waitFor()
    }
    await page.keyboard.press('Escape')
    assert.equal(await dialogs(page), 0)
    await page.evaluate(() =>
      (
        window as never as {
          fixture: { shown: { store: { getState: () => { openDialog: (d: object) => void } } } }
        }
      ).fixture.shown.store
        .getState()
        .openDialog({ kind: 'server_settings', server: 'garden' })
    )
    await page.getByRole('dialog', { name: 'Server Settings' }).waitFor()
    await page.mouse.click(20, 400)
    assert.equal(await dialogs(page), 0)
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // A dialog that takes the place of Server Settings gets the focus, and its back action opens
    // Server Settings at the section it came from.
    const { page, errors } = await open(browser, 'server')
    for (const [section, button, dialog] of [
      ['integrations', 'Webhooks', 'Webhooks'],
      ['audit', 'Open audit log', 'Audit Log'],
    ] as const) {
      await page.locator(`[data-settings-section="${section}"]`).click()
      await page.getByRole('button', { name: button, exact: true }).focus()
      await page.keyboard.press('Enter')
      const opened = page.getByRole('dialog', { name: dialog })
      await opened.waitFor()
      assert(await opened.evaluate(e => e.contains(document.activeElement)))
      await page.keyboard.press('Escape')
      await page.locator(`[data-settings-section="${section}"][aria-current="page"]`).waitFor()
    }
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // Switching sections keeps unsaved edits; the sections left stay hidden.
    const { page, errors } = await open(browser, 'server')
    await page.locator('[data-settings-section="overview"]').click()
    const save = page.getByRole('button', { name: 'Save colors' })
    assert(await save.isDisabled())
    await page
      .getByRole('button', { name: /^Banner color: / })
      .first()
      .click()
    assert(await save.isEnabled())
    await page.locator('[data-settings-section="roles"]').click()
    assert(!(await save.isVisible()))
    assert.equal(await page.locator('[data-section-body]:visible').count(), 1)
    await page.locator('[data-settings-section="overview"]').click()
    assert(await save.isEnabled())
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // The same for an unsaved About me in user Settings and a server name in P2P settings.
    const user = await open(browser, 'settings/profile')
    await user.page.getByLabel('About me').fill('Draft about me')
    await user.page.locator('[data-settings-section="general"]').click()
    assert(!(await user.page.getByLabel('About me').isVisible()))
    await user.page.locator('[data-settings-section="profile"]').click()
    assert.equal(await user.page.getByLabel('About me').inputValue(), 'Draft about me')
    assert.deepEqual(user.errors, [])
    await user.page.close()
    const p2p = await open(browser, 'p2p/overview')
    await p2p.page.getByLabel('Server name').fill('Draft name')
    await p2p.page.locator('[data-settings-section="roles"]').click()
    await p2p.page.locator('[data-settings-section="overview"]').click()
    assert.equal(await p2p.page.getByLabel('Server name').inputValue(), 'Draft name')
    assert.deepEqual(p2p.errors, [])
    await p2p.page.close()
  }

  {
    // P2P server settings: a deep-linked tab opens its section; Esc and the backdrop close them.
    const { page, errors } = await open(browser, 'p2p/channels')
    await page.locator('[data-settings-section="channels"][aria-current="page"]').waitFor()
    assert.equal(await page.locator('h1').textContent(), 'Channels')
    await page.keyboard.press('Escape')
    assert.equal(await dialogs(page), 0)
    await page.evaluate(() =>
      (window as never as { fixture: { openP2p: () => void } }).fixture.openP2p()
    )
    await page.getByRole('dialog', { name: 'Server settings' }).waitFor()
    await page.mouse.click(20, 400)
    assert.equal(await dialogs(page), 0)
    assert.deepEqual(errors, [])
    await page.close()
  }

  {
    // Phones: the list of sections, a section with Back, and close from the section.
    for (const hash of ['server', 'p2p']) {
      const { page, errors } = await open(browser, hash, { viewport: PHONE })
      await page.locator('[data-screen="list"]').waitFor()
      await page.locator('[data-settings-section]').nth(1).tap()
      await page.locator('[data-screen="section"]').waitFor()
      await page.getByRole('button', { name: 'Back' }).tap()
      await page.locator('[data-screen="list"]').waitFor()
      await page.locator('[data-settings-section]').first().tap()
      await page.getByRole('button', { name: 'Close' }).tap()
      assert.equal(await dialogs(page), 0)
      assert.deepEqual(errors, [])
      await page.close()
    }
    // The list marks no entry current until one opens, and Back focuses the entry just left.
    const { page, errors } = await open(browser, 'server', { viewport: PHONE })
    await page.locator('[data-screen="list"]').waitFor()
    assert.equal(await page.locator('[aria-current="page"]').count(), 0)
    await page.locator('[data-settings-section="bans"]').tap()
    assert.equal(
      await page.locator('[data-settings-section="bans"][aria-current="page"]').count(),
      1
    )
    await page.getByRole('button', { name: 'Back' }).tap()
    await page.locator('[data-screen="list"]').waitFor()
    assert.equal(await page.locator('[aria-current="page"]').count(), 0)
    assert(
      await page
        .locator('[data-settings-section="bans"]')
        .evaluate(e => e === document.activeElement)
    )
    assert.deepEqual(errors, [])
    await page.close()
    // With one section only, it opens at once and has no Back.
    const single = await open(browser, 'server/member', { viewport: PHONE })
    await single.page.locator('[data-screen="section"]').waitFor()
    assert.equal(await single.page.locator('h1').textContent(), 'Invites')
    assert.equal(await single.page.getByRole('button', { name: 'Back' }).count(), 0)
    await single.page.getByRole('button', { name: 'Close' }).tap()
    assert.equal(await dialogs(single.page), 0)
    assert.deepEqual(single.errors, [])
    await single.page.close()
  }
  console.log('PASS settings dialogs')
} finally {
  await browser.close()
}
