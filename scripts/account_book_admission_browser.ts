// Run with bun scripts/account_book_admission_browser.ts and Playwright Chromium installed.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const bundle = await Bun.build({
  entrypoints: [new URL('../apps/web/app/lib/store.ts', import.meta.url).pathname],
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
})
if (!bundle.success) throw new AggregateError(bundle.logs)
const js = await bundle.outputs[0].text()
const browser = await chromium.launch()
try {
  for (const initial of [48, 49, 1]) {
    const readOnly = initial === 1
    const context = await browser.newContext()
    await context.addInitScript(readOnly => {
      Object.defineProperty(navigator, 'locks', { value: undefined })
      if (readOnly) Object.defineProperty(window, 'indexedDB', { value: undefined })
    }, readOnly)
    const origin = 'https://admission.test'
    const attempts = new Set<string>()
    const replies = Promise.withResolvers<void>()
    const revoked = Promise.withResolvers<string>()
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      assert.equal(url.origin, origin)
      if (url.pathname === '/bundle.js')
        return route.fulfill({ contentType: 'text/javascript', body: js })
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<script type="module">
        import { getHomeSession } from './bundle.js'
        const account = getHomeSession()
        account.conn.ws.start = () => {}
        window.login = async username => {
          await account.store.getState().login({username, password: 'fixture'})
          const {me, token, error} = account.store.getState()
          return {user: me?.username ?? null, active: !!token, error}
        }
      </script>`,
        })
      if (url.pathname.endsWith('/auth/login')) {
        const { username } = route.request().postDataJSON()
        attempts.add(username)
        if (attempts.size === 2) replies.resolve()
        await replies.promise
        return route.fulfill({
          json: {
            token: 'fixture-' + username,
            user: {
              username,
              display_name: null,
              avatar_kind: 'identicon',
              avatar_color: null,
              servers: [],
              dms: [],
            },
          },
        })
      }
      if (url.pathname.endsWith('/auth/logout')) {
        revoked.resolve(route.request().headers().authorization)
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ json: [] })
    })
    const pages = await Promise.all([context.newPage(), context.newPage()])
    await pages[0].goto(origin)
    await pages[0].evaluate(initial => {
      const accounts = Array.from({ length: initial }, (_, i) => ({
        username: 'saved' + i,
        display: null,
        avatar: null,
        connect: true,
        added: i,
        identities: [],
      }))
      localStorage.setItem(
        'rchat_book',
        JSON.stringify({
          v: 1,
          instances: [
            {
              origin: location.origin,
              id: location.origin,
              name: 'Fixture',
              guest: false,
              accounts,
            },
          ],
        })
      )
    }, initial)
    await Promise.all(pages.map(p => p.goto(origin)))
    const names = [readOnly ? 'saved0' : 'alice', 'bob']
    const results = await Promise.all(
      pages.map((page, i) =>
        page.evaluate(async username => {
          const login = (
            window as unknown as {
              login: (
                name: string
              ) => Promise<{ user: string | null; active: boolean; error: string | null }>
            }
          ).login
          return login(username)
        }, names[i])
      )
    )
    const saved = await pages[0].evaluate(
      names => ({
        names: JSON.parse(localStorage.getItem('rchat_book')!).instances[0].accounts.map(
          (a: { username: string }) => a.username
        ) as string[],
        qualified: names.map(u => localStorage.getItem('rchat_token:' + u) === 'fixture-' + u),
      }),
      names
    )
    assert.equal(saved.names.length, readOnly ? initial : 50)
    assert.equal(results.filter(r => r.active).length, readOnly ? 1 : 50 - initial)
    for (let i = 0; i < initial; i++) assert(saved.names.includes('saved' + i))
    for (const [i, result] of results.entries()) {
      assert.equal(saved.names.includes(names[i]), result.active)
      assert.equal(saved.qualified[i], result.active)
      if (result.active) assert.equal(result.user, names[i])
      else {
        assert.match(result.error ?? '', readOnly ? /cannot safely add/ : /50/)
        assert.equal(result.user, null)
        assert.equal(await revoked.promise, 'Bearer fixture-' + names[i])
      }
    }
    await context.close()
    console.log(
      readOnly
        ? 'PASS saved account remains available and new admission is denied without browser coordination'
        : 'PASS simultaneous Chromium logins with Web Locks disabled and ' +
            (50 - initial) +
            ' slots'
    )
  }
} finally {
  await browser.close()
}
