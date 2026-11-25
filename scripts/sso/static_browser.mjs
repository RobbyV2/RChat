/* global localStorage, sessionStorage, URL, fetch, console, process */
// Run with the two-instance fixture and SSO_STATIC_URL pointing at its static client export.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export async function check({ newContext, origins, staticOrigin, signIn, dms }) {
  const app = staticOrigin ?? process.env.SSO_STATIC_URL,
    origin = origins.Beta
  const discovery = await (await fetch(origin + '/api/instance')).json()
  discovery.auth = {
    password_login: false,
    registration: 'sso',
    providers: [{ id: 'fixture', name: 'Fixture provider' }],
  }
  const member = await signIn('Beta', 'alice')
  const login = await member.page.evaluate(async origin => {
    const token = localStorage.getItem('rchat_token:alice@' + new URL(origin).host)
    const me = await fetch(origin + '/api/v1/me', { headers: { Authorization: 'Bearer ' + token } })
    if (!me.ok) throw Error('Beta fixture login unavailable')
    return { kind: 'session', token, user: await me.json(), end_session: false }
  }, origin)
  await member.context.close()
  const dm = dms.Beta[0]
  for (const shell of [null, 'android', 'linux']) {
    const ctx = await newContext()
    let exchanges = 0
    try {
      await ctx.route(
        url => url.origin === app,
        r => r.continue()
      )
      await ctx.route(
        url => url.origin === origin,
        async r => {
          const u = new URL(r.request().url())
          const cors = {
            'access-control-allow-origin': app,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type, authorization',
          }
          if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors })
          if (
            u.pathname === '/api/instance' ||
            u.pathname === '/.well-known/rchat' ||
            u.pathname === '/api/v1/instance'
          )
            return r.fulfill({ json: discovery, headers: cors })
          if (u.pathname === '/api/auth/oidc/exchange') {
            const { code, verifier } = r.request().postDataJSON()
            assert.equal(code, 'abc123')
            assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge)
            return r.fulfill({
              headers: cors,
              json:
                shell === 'linux' && ++exchanges === 1
                  ? { kind: 'pick_username', reason: 'taken', suggestion: 'alice2' }
                  : login,
            })
          }
          const upstream = await r.fetch()
          await r.fulfill({ response: upstream, headers: { ...upstream.headers(), ...cors } })
        }
      )
      let challenge = ''
      if (shell)
        await ctx.addInitScript(os => {
          const w = globalThis.window
          const callbacks = new Map(),
            handlers = new Map()
          w.__RCHAT_DESKTOP__ = { os, version: 'fixture' }
          w.__TAURI_INTERNALS__ = {
            transformCallback(fn) {
              callbacks.set(callbacks.size + 1, fn)
              return callbacks.size
            },
            unregisterCallback() {},
            invoke: async (cmd, args = {}) => {
              if (cmd === 'plugin:event|listen') {
                handlers.set(args.event, callbacks.get(args.handler))
                return args.handler
              }
              if (cmd === 'open_external') {
                w.fixtureOpened = args.url
                return
              }
              if (cmd === 'take_deep_links') {
                const links = JSON.parse(sessionStorage.getItem('fixture-links') ?? '[]')
                sessionStorage.removeItem('fixture-links')
                return links
              }
              return null
            },
          }
          w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
          w.fixtureLink = link => {
            sessionStorage.setItem('fixture-links', JSON.stringify([link]))
            handlers.get('deep-link')?.({ event: 'deep-link', payload: 1 })
          }
        }, shell)
      let page = await ctx.newPage()
      await page.goto(app + '/login/')
      const address = page.getByLabel('Instance address', { exact: true })
      if (shell) {
        await address.waitFor()
        const host = new URL(origin).host
        const path = (shell === 'linux' ? '/@alice@' + host : '') + '/dm/' + dm.id + '/'
        await page.evaluate(link => globalThis.window.fixtureLink(link), 'rchat://' + host + path)
        await page.getByRole('button', { name: 'Open', exact: true }).click()
      } else {
        await address.fill(origin)
        await address.press('Enter')
      }
      const trust = page.getByRole('button', { name: 'I trust this app' })
      await trust.waitFor()
      assert.equal(
        await page.getByRole('button', { name: 'Continue with Fixture provider' }).count(),
        0
      )
      await trust.click()
      const host = new URL(origin).host
      if (!shell) {
        await page
          .getByText('Single sign-on for ' + host + ' works on ' + host + ' and in the RChat apps.')
          .waitFor()
        assert.equal(
          await page.getByRole('button', { name: 'Continue with Fixture provider' }).count(),
          0
        )
      } else {
        await page.getByRole('button', { name: 'Continue with Fixture provider' }).click()
        await page.waitForFunction(() => !!globalThis.window.fixtureOpened)
        const opened = new URL(await page.evaluate(() => globalThis.window.fixtureOpened))
        assert.equal(opened.origin, origin)
        assert.equal(opened.searchParams.get('return'), 'app')
        challenge = opened.searchParams.get('challenge')
        // The OS discarded the login WebView while the system browser was open.
        // This fresh document shares device storage but has no sessionStorage or opener.
        await page.close()
        page = await ctx.newPage()
        await page.goto(app + '/login/')
        await page.getByLabel('Instance address', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => sessionStorage.getItem('rchat_sso')), null)
        await page.evaluate(() =>
          globalThis.window.fixtureLink('rchat://other.test/sso?code=abc123')
        )
        assert.equal(new URL(page.url()).pathname, '/login/')
        await page.evaluate(
          host => globalThis.window.fixtureLink('rchat://' + host + '/sso?code=abc123'),
          host
        )
        if (shell === 'linux') {
          await page.getByRole('alert').filter({ hasText: 'not linked to alice' }).waitFor()
          assert.equal(await page.getByRole('heading', { name: 'Pick a username' }).count(), 0)
          await page.getByRole('button', { name: 'Restart sign-in as alice' }).click()
          await page.waitForFunction(() => !!globalThis.window.fixtureOpened)
          const retry = new URL(await page.evaluate(() => globalThis.window.fixtureOpened))
          assert.equal(retry.origin, origin)
          assert.notEqual(retry.searchParams.get('challenge'), challenge)
          challenge = retry.searchParams.get('challenge')
          await page.evaluate(
            host => globalThis.window.fixtureLink('rchat://' + host + '/sso?code=abc123'),
            host
          )
        }
        await page.waitForURL(url => url.pathname === '/@alice@' + host + '/dm/' + dm.id + '/')
        await page
          .getByText(dm.marker, { exact: true })
          .first()
          .waitFor()
          .catch(async error => {
            console.error(
              'Returned screen',
              await page.locator('h1,h2,[role=alert]').allTextContents()
            )
            throw error
          })
        assert.equal(
          await page.evaluate(() =>
            Object.keys(localStorage).some(k => k.startsWith('rchat_sso_app_login'))
          ),
          false
        )
        console.log(
          'PASS',
          shell,
          'fresh WebView accepted issuer callback and restored linked Beta DM'
        )
      }
    } finally {
      await ctx.close()
    }
  }
  console.log(
    'PASS static Welcome trust, third-party sign-in notice, shell system-browser start and host-bound return to the original conversation'
  )
}
