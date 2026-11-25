// Run by the ignored oidc::tests::client_login_chromium test with the local Rust fake IdP.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { chromium } from 'playwright-core'
const [clientOrigin, instance, username] = process.argv.slice(2)
const mobile = process.env.RCHAT_SSO_MOBILE === '1'
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  await page.goto(clientOrigin + '/login/')
  const address = page.getByLabel('Instance address', { exact: true })
  await address.fill(instance)
  await address.press('Enter')
  await page.getByRole('button', { name: 'I trust this app' }).click()
  // The local fake provider's subsequent sign-ins claim “river”. A password
  // account with that name forces the real exchange through its username picker.
  const local = 'river'
  const password = randomBytes(16).toString('hex')
  const registration = await globalThis.fetch(instance + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: local, password, avatar_kind: 'identicon' }),
  })
  assert.equal(registration.ok, true, 'register fixture account')
  await page.getByLabel('Username', { exact: true }).fill(local)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.locator('[data-add-instance-step] form button[type=submit]').click()
  const tile = page.locator('[data-switcher-tile]:visible')
  async function openNavigation() {
    if (!mobile) return
    const menu = page
      .getByRole('button', {
        name: /Open navigation|Open menu|Open sidebar|Show navigation|^Menu$/i,
      })
      .filter({ visible: true })
      .first()
    await tile.or(menu).first().waitFor()
    if (!(await tile.isVisible())) await menu.click()
  }
  async function openSwitcher() {
    await openNavigation()
    await tile.click()
  }

  await openSwitcher()
  await page.getByRole('button', { name: /Add an account on/ }).click()
  let exchanges = 0
  context.on('request', r => {
    if (new globalThis.URL(r.url()).pathname.endsWith('/auth/oidc/exchange')) exchanges++
  })
  for (const approve of [false, true]) {
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Continue with Fixture provider' }).click()
    const popup = await opened
    await popup
      .getByRole('heading', {
        name:
          'Sign in to ' +
          new globalThis.URL(instance).host +
          ' for the app at ' +
          clientOrigin +
          '?',
      })
      .waitFor()
    const allow = popup.getByRole('button', { name: 'Allow' })
    await allow.waitFor()
    assert.equal(exchanges, 0)
    const close = popup.waitForEvent('close')
    await popup.getByRole('button', { name: approve ? 'Allow' : 'Cancel' }).click()
    await close
    if (!approve) {
      await page.getByText('Sign-in was cancelled.').waitFor()
      assert.equal(exchanges, 0)
      const pinned = await context.newPage()
      const pinnedPath = '/@' + local + '@' + new globalThis.URL(instance).host + '/'
      await pinned.goto(clientOrigin + '/login/?next=' + encodeURIComponent(pinnedPath))
      for (const label of ['Continue with Fixture provider', 'Restart sign-in as ' + local]) {
        const opened = pinned.waitForEvent('popup')
        await pinned.getByRole('button', { name: label }).click()
        const prompt = await opened
        await prompt.getByRole('button', { name: 'Allow' }).click()
        await pinned
          .getByText(
            'This provider account is not linked to ' +
              local +
              ' on ' +
              new globalThis.URL(instance).host +
              '. Restart sign-in with the provider account linked to that username.'
          )
          .waitFor()
        assert.equal(await pinned.getByRole('heading', { name: 'Pick a username' }).count(), 0)
      }
      await pinned.close()
      exchanges = 0
    }
  }
  await page.getByRole('heading', { name: 'Pick a username' }).waitFor()
  const picker = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Pick a username' }) })
  await picker.getByLabel('Username').fill(username)
  await picker.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.waitForFunction(
    user => globalThis.localStorage.getItem('rchat_book')?.includes('"username":"' + user + '"'),
    username
  )
  assert.equal(exchanges, 2)
  assert.equal(new globalThis.URL(page.url()).origin, clientOrigin)
  await openSwitcher()
  const row = page.locator(
    '[data-account-row=' + JSON.stringify(JSON.stringify([instance, username, null])) + ']'
  )
  const sibling = page.locator(
    '[data-account-row=' + JSON.stringify(JSON.stringify([instance, local, null])) + ']'
  )
  await sibling.click()
  await page.waitForFunction(user => globalThis.history.state?.acct?.startsWith(user + '@'), local)
  await openSwitcher()
  await row.click()
  await page.waitForFunction(
    user => globalThis.history.state?.acct?.startsWith(user + '@'),
    username
  )
  await openSwitcher()
  await sibling.click()
  await openNavigation()
  await page.getByTitle('Settings', { exact: true }).filter({ visible: true }).first().click()
  await page.locator('[data-settings-section=profile]').click()
  await page.locator('[data-settings-logout]').click()
  await page.waitForURL(u => u.pathname === '/login/')
  const standalone = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Continue with Fixture provider' }).click()
  const prompt = await standalone
  const me = page.waitForResponse(r => r.url().endsWith('/auth/oidc/exchange') && r.ok())
  await prompt.getByRole('button', { name: 'Allow' }).click()
  const response = await (await me).json()
  assert.equal(response.user.username, username)
  await page.waitForURL(
    u => u.pathname === '/@' + username + '@' + new globalThis.URL(instance).host + '/'
  )
  await openNavigation()
  await tile.waitFor()
  globalThis.console.log(
    'PASS cross-origin static client with real OIDC endpoints and a local fake provider: exact-origin consent, cancel, approve, pinned mismatch and restart, username selection, switching two accounts, and standalone sign-in to the existing sibling'
  )
} finally {
  await browser.close()
}
