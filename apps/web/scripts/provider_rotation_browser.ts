// Run from the repository root with bun apps/web/scripts/provider_rotation_browser.ts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const js = execFileSync(
  process.execPath,
  [
    'build',
    'apps/web/app/lib/__tests__/browser/account_overlays.tsx',
    '--target=browser',
    '--define',
    'process.env.NODE_ENV="production"',
    '--define',
    'process.env={}',
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
)
const origin = 'https://shown.test'
const browser = await chromium.launch()
try {
  for (const order of [
    'socket-first',
    'callback-first',
    'older-server',
    'wrong-account-retry',
    'downgraded-endpoint',
  ]) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const starts: URL[] = []
    let ordinaryExchanges = 0
    await context.addInitScript(() => {
      const original = window.fetch
      window.fetch = (input, init) => {
        if (String(input).endsWith('/api/instance') && init?.cache === 'no-store')
          sessionStorage.setItem(
            'freshReads',
            String(Number(sessionStorage.getItem('freshReads')) + 1)
          )
        return original(input, init)
      }
    })
    let writes = 0
    const verifier = 'A'.repeat(43)
    let exchanges = 0
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (path === '/' || path === '/sso/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<script type="module" src="/bundle.js"></script>',
        })
      if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (path === '/api/instance')
        return route.fulfill({
          json: {
            id: 'fixture',
            name: 'Shown',
            api_versions: ['v1'],
            host: url.host,
            public_url: origin,
            api_url: origin + '/api',
            ws_url: 'wss://shown.test/api/ws',
            auth: {
              ...(order === 'older-server' ? {} : { confirm_login: true }),
              password_login: true,
              registration: 'open',
              providers: [{ id: 'work', name: 'Work' }],
            },
          },
        })
      if (path.endsWith('/settings')) return route.fulfill({ json: { backup_phrase: true } })
      if (path.endsWith('/me/sso'))
        return route.fulfill({ json: [{ provider: 'work', name: 'Work' }] })
      if (path.endsWith('/me/sso/ticket')) return route.fulfill({ json: { ticket: 'ticket' } })
      if (path.endsWith('/start')) {
        starts.push(url)
        return route.fulfill({ contentType: 'text/html', body: 'Provider sign-in' })
      }
      if (path.endsWith('/auth/oidc/exchange')) {
        ordinaryExchanges++
        return route.fulfill({ status: 500, json: { error: 'Unexpected ordinary exchange' } })
      }
      if (path.endsWith('/auth/oidc/exchange/confirmation')) {
        const body = route.request().postDataJSON()
        assert.equal(body.confirm_as, 'reader')
        assert.equal(body.username, undefined)
        exchanges++
        if (order === 'downgraded-endpoint')
          return route.fulfill({ status: 404, body: 'Not found' })
        if (body.code === 'wrong') {
          assert.equal(body.verifier, verifier)
          return route.fulfill({
            status: 403,
            json: { error: 'Account does not match linked sign-in' },
          })
        }
        assert.notEqual(body.verifier, verifier)
        return route.fulfill({
          json: {
            kind: 'session',
            token: 'admitted',
            end_session: false,
            user: {
              username: 'reader',
              display_name: 'Reader',
              avatar_kind: 'identicon',
              avatar_color: null,
              banner_color: null,
              bio: null,
              is_site_admin: false,
              appear_offline: false,
              password_kind: 'text',
              has_password: false,
              servers: [],
              dms: [],
            },
            confirmation: {
              provider: 'work',
              code: 'new-proof',
              expires_at: Math.floor(Date.now() / 1000) + 60,
            },
          },
        })
      }
      if (path.endsWith('/me/recovery')) {
        if (route.request().method() === 'GET') return route.fulfill({ json: { set: false } })
        if (order === 'wrong-account-retry') {
          assert.deepEqual(route.request().postDataJSON().reauth.idp, {
            provider: 'work',
            code: 'new-proof',
          })
          assert.equal(route.request().headers().authorization, 'Bearer admitted')
          writes++
          return route.fulfill({ json: { ok: true } })
        }
        assert.deepEqual(route.request().postDataJSON().reauth.idp, {
          provider: 'work',
          code: 'old',
        })
        writes++
      }
      return route.fulfill({ status: 401, json: { error: 'Unauthorized' } })
    })
    if (order === 'wrong-account-retry' || order === 'downgraded-endpoint') {
      await page.addInitScript(verifier => {
        if (location.search === '?code=wrong')
          sessionStorage.setItem(
            'rchat_sso',
            JSON.stringify({
              v: 1,
              purpose: 'login',
              origin: location.origin,
              username: 'reader',
              provider: 'work',
              back: '/',
              confirm: true,
              verifier,
              at: Date.now(),
            })
          )
      }, verifier)
      await page.goto(origin + '/sso/?code=wrong')
      if (order === 'downgraded-endpoint') {
        await page
          .getByRole('alert')
          .filter({ hasText: 'Confirmation sign-in is unavailable' })
          .waitFor()
        await page.getByRole('link', { name: 'Back to sign in' }).waitFor()
        assert.equal(await page.evaluate(() => sessionStorage.getItem('rchat_sso')), null)
        assert.equal(await page.evaluate(() => sessionStorage.getItem('freshReads')), '1')
        assert.equal(exchanges, 1)
        assert.equal(ordinaryExchanges, 0)
        await context.close()
        console.log('Passed', order)
        continue
      }
      await page.getByRole('button', { name: 'Restart sign-in as reader' }).click()
      await page.waitForURL(url => url.searchParams.get('confirm') === '1')
      assert.equal(starts[0].pathname, '/api/auth/oidc/work/start')
      await page.goto(origin + '/sso/?code=fresh')
      await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
      assert.equal(writes, 0)
      await page.getByRole('button', { name: 'Set or reset backup phrase' }).click()
      await page.getByRole('button', { name: 'I saved the words' }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm with recent Work sign-in' }).click()
      await page.getByText('Backup phrase saved', { exact: true }).waitFor()
      assert.equal(writes, 1)
      assert.equal(exchanges, 2)
      assert.equal(ordinaryExchanges, 0)
      assert.equal(await page.evaluate(() => sessionStorage.getItem('freshReads')), '3')
      await context.close()
      console.log('Passed', order)
      continue
    }
    await page.goto(origin + '/?first-password&rotation')
    await page.getByRole('button', { name: 'Set or reset backup phrase' }).click()
    await page.getByRole('button', { name: 'I saved the words' }).click()
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Sign in with Work' }).click()
    const popup = await opened
    await popup.waitForLoadState()
    assert.equal(starts[0].searchParams.get('ticket'), 'ticket')
    if (order !== 'callback-first')
      await page
        .getByRole('button', { name: 'Check session', includeHidden: true })
        .evaluate(el => (el as HTMLButtonElement).click())
    else
      await popup.evaluate(() =>
        window.opener.postMessage(
          {
            type: 'rchat-sso-return',
            challenge: new URL(location.href).searchParams.get('challenge'),
            search: '?code=old',
          },
          location.origin
        )
      )
    const resume = page.getByRole('button', { name: 'Sign in again to confirm with Work' })
    if (order === 'older-server') {
      const ordinary = page.getByRole('button', { name: 'Continue with Work' })
      await ordinary.waitFor()
      assert.equal(await resume.count(), 0)
      await ordinary.click()
      await page.waitForURL(url => url.pathname.endsWith('/start'))
      assert.equal(starts[1].searchParams.has('confirm'), false)
      await context.close()
      console.log('Passed', order)
      continue
    }
    await resume.waitFor()
    assert.equal(writes, order === 'callback-first' ? 1 : 0)
    assert.equal(await page.getByRole('dialog', { name: 'Set backup phrase' }).count(), 0)
    await resume.click()
    await page.waitForURL(url => url.searchParams.get('confirm') === '1')
    assert.equal(await page.evaluate(() => sessionStorage.getItem('freshReads')), '1')
    assert.equal(starts[1].searchParams.has('ticket'), false)
    assert.notEqual(
      starts[0].searchParams.get('challenge'),
      starts[1].searchParams.get('challenge')
    )
    await context.close()
    console.log('Passed', order)
  }
} finally {
  await browser.close()
}
