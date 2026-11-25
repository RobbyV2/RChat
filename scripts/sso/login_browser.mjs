/* global localStorage, sessionStorage, URL, fetch, console */
// Callback for the two-instance Chromium fixture. The provider and exchange stay on loopback.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export async function check({ actors, origins, newContext, dms }) {
  const context = await newContext()
  const authenticated = actors.get('Alpha/alice').page
  const login = await authenticated.evaluate(async () => {
    const token = localStorage.getItem('rchat_token:alice') ?? localStorage.getItem('rchat_token')
    const result = await fetch('/api/v1/me', { headers: { Authorization: 'Bearer ' + token } })
    if (!result.ok) throw Error('Fixture session unavailable')
    return { token, user: await result.json(), kind: 'session', end_session: false }
  })
  const origin = origins.Alpha,
    provider = { id: 'fixture', name: 'Fixture identity provider' }
  let challenge = '',
    exchanges = 0
  try {
    await context.route(
      url => url.origin === origin && /^\/api(?:\/v1)?\/instance\/?$/.test(url.pathname),
      async r => {
        const upstream = await r.fetch()
        await r.fulfill({
          json: {
            ...(await upstream.json()),
            auth: { providers: [provider], password_login: false, registration: 'sso' },
          },
        })
      }
    )
    await context.route(origin + '/api/auth/oidc/fixture/start?**', async r => {
      const url = new URL(r.request().url())
      assert.equal(url.searchParams.get('return'), 'web')
      challenge = url.searchParams.get('challenge')
      await r.fulfill({ status: 302, headers: { location: origin + '/sso/?code=abc123' } })
    })
    await context.route(origin + '/api/auth/oidc/exchange', async r => {
      const body = r.request().postDataJSON()
      assert.equal(body.code, 'abc123')
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge)
      exchanges++
      await r.fulfill({
        json: body.username
          ? login
          : { kind: 'pick_username', reason: 'taken', suggestion: 'fixture-alice' },
      })
    })
    const page = await context.newPage()
    await page.goto(origin + '/login/?local=1')
    await page.getByRole('button', { name: 'Continue with ' + provider.name }).waitFor()
    assert(await page.getByLabel('Password', { exact: true }).isVisible())
    await page.goto(origin + '/login/?next=' + encodeURIComponent('/dm/' + dms.Alpha[0].id + '/'))
    const button = page.getByRole('button', { name: 'Continue with ' + provider.name })
    await button.waitFor()
    assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Create account' }).count(), 0)
    await button.click()
    await page.getByRole('heading', { name: 'Pick a username' }).waitFor()
    assert.equal(await page.getByLabel('Username').inputValue(), 'fixture-alice')
    await page.getByLabel('Username').fill('alice')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByText(dms.Alpha[0].marker, { exact: true }).first().waitFor()
    assert.equal(exchanges, 2)
    assert.equal(await page.evaluate(() => sessionStorage.getItem('rchat_sso')), null)
    await page.goto(origin + '/sso/?code=unrequested')
    await page.getByText('That sign-in expired. Try again.').waitFor()
    assert.equal(exchanges, 2)
    console.log(
      'PASS hosted provider, local password override, S256 exchange and username retry, authenticated DM return, consumed session intent and unsolicited callback'
    )
  } finally {
    await context.close()
  }
}
