// Run with bun scripts/sso/first_password_settings_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const bundle = await Bun.build({
  entrypoints: ['apps/web/app/lib/__tests__/browser/account_overlays.tsx'],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs, 'Cannot build Settings fixture')
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  for (const delayInitial of [false, true]) {
    const page = await browser.newPage()
    const errors: Error[] = []
    page.on('pageerror', e => errors.push(e))
    page.setDefaultTimeout(5000)
    const host = delayInitial ? 'owner.test' : 'shown.test'
    let passwordSet = false
    const initial = Promise.withResolvers<void>()
    const initialDone = Promise.withResolvers<void>()
    let reads = 0
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<body><script type="module" src="/bundle.js"></script></body>',
        })
      if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (new URL(route.request().url()).host !== host) return route.abort()
      if (path === '/api/instance')
        return route.fulfill({
          json: {
            id: 'fixture',
            name: 'Shown',
            api_versions: ['v1'],
            host,
            public_url: `https://${host}`,
            api_url: `https://${host}/api`,
            ws_url: `wss://${host}/api/ws`,
            auth: {
              registration: 'open',
              password_login: true,
              providers: [
                { id: 'work', name: 'Work' },
                { id: 'alt', name: 'Alternate' },
              ],
            },
          },
        })
      if (path === '/api/v1/settings')
        return route.fulfill({ json: { password_login: true, backup_phrase: true } })
      if (path.endsWith('/me/sso')) {
        const first = ++reads === 1
        const eligible = passwordSet
        if (first && delayInitial) await initial.promise
        await route.fulfill({
          json: [{ provider: 'work', name: 'Work', linked_at: 1, can_unlink: eligible }],
        })
        if (first) initialDone.resolve()
        return
      }
      if (path.endsWith('/me/sso/ticket')) return route.fulfill({ json: { ticket: 'fixture' } })
      if (path.endsWith('/auth/oidc/exchange'))
        return route.fulfill({
          status: 409,
          json: { error: 'That sign-in belongs to another account' },
        })
      if (path.endsWith('/me/recovery')) return route.fulfill({ json: { set: true } })
      if (path.endsWith('/auth/recovery/challenge'))
        return route.fulfill({ json: { username: 'reader', nonce: 'fixture' } })
      if (path.endsWith('/me/password')) {
        const body = route.request().postDataJSON()
        assert(body.reauth.phrase.sig)
        assert.equal(body.new.password, 'fixture password')
        passwordSet = true
        return route.fulfill({ json: { ok: true } })
      }
      return route.abort()
    })
    await page.goto('https://shown.test/?first-password' + (delayInitial ? '&sibling' : ''))
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const originalPanel = await settings.elementHandle()
    assert.equal(await page.locator('body').getAttribute('data-palette-link'), 'true')
    await settings.getByRole('button', { name: 'Set or reset backup phrase' }).waitFor()
    const unlink = settings.getByRole('button', { name: 'Unlink', exact: true })
    if (!delayInitial) {
      await settings.getByRole('button', { name: 'Link Alternate' }).waitFor()
      await unlink.waitFor()
      assert(await unlink.isDisabled())
    }
    await settings.getByLabel('New password', { exact: true }).fill('fixture password')
    await settings.getByLabel('Confirm new password').fill('fixture password')
    await settings.getByRole('button', { name: 'Set a password' }).click()
    const confirm = page.getByRole('dialog', { name: 'Set a password' })
    await confirm.getByRole('button', { name: 'Use backup phrase' }).click()
    const words = [...Array(11).fill('abandon'), 'about']
    for (const [i, word] of words.entries())
      await confirm.getByLabel('Word ' + (i + 1), { exact: true }).fill(word)
    await confirm.getByRole('button', { name: 'Confirm backup phrase' }).click()
    await settings.getByText('Password changed', { exact: true }).waitFor()
    await unlink.click({ trial: true })
    initial.resolve()
    await initialDone.promise
    await page.waitForLoadState('networkidle')
    assert.equal(reads, 2)
    assert(await originalPanel!.evaluate(el => el.isConnected))
    if (!delayInitial) {
      await page
        .context()
        .route('**/auth/oidc/alt/start?**', route =>
          route.fulfill({ contentType: 'text/html', body: '<button>Return to Settings</button>' })
        )
      const opener = settings.getByRole('button', { name: 'Link Alternate' })
      await opener.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Link Alternate' })
      await dialog.getByLabel('Current password').fill('fixture password')
      const pendingPopup = page.waitForEvent('popup')
      await dialog.getByRole('button', { name: 'Confirm password' }).focus()
      await page.keyboard.press('Enter')
      const popup = await pendingPopup
      await popup.bringToFront()
      await popup.getByRole('button').focus()
      await popup.evaluate(() => {
        window.opener.postMessage(
          {
            type: 'rchat-sso-return',
            challenge: new URL(location.href).searchParams.get('challenge'),
            search: '?code=conflict',
          },
          location.origin
        )
        window.close()
      })
      await dialog.getByText('That sign-in belongs to another account').waitFor()
      assert(await dialog.evaluate(el => el.contains(document.activeElement)))
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert(await settings.isVisible())
      assert(await opener.evaluate(el => el === document.activeElement))
    }
    await unlink.click()
    await page.getByRole('dialog', { name: 'Unlink Work?' }).waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}
