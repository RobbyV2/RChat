// Test a built client-only export against a disposable RChat API.
// Arguments are the static origin and API origin on loopback.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'

const [site, api] = process.argv.slice(2).map(s => new URL(s))
assert(
  site &&
    api &&
    site.hostname === '127.0.0.1' &&
    api.hostname === '127.0.0.1' &&
    site.origin !== api.origin
)
const username = 'static' + randomBytes(6).toString('hex')
const password = randomBytes(24).toString('hex')
const registered = await fetch(new URL('/api/v1/auth/register', api), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password, avatar_kind: 'identicon' }),
})
assert(registered.ok, 'fixture registration failed')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ serviceWorkers: 'block' })
  const localApi: string[] = []
  const requests: string[] = []
  page.on('request', req => {
    const url = new URL(req.url())
    if (
      url.origin === site.origin &&
      /^(?:\/api(?:\/|$)|\/\.well-known\/rchat$)/.test(url.pathname)
    )
      localApi.push(url.pathname)
    if (url.origin === api.origin) requests.push(url.pathname)
  })
  page.on('websocket', socket => {
    const url = new URL(socket.url())
    if (url.host === site.host) localApi.push(url.pathname)
    if (url.host === api.host) requests.push(url.pathname)
  })
  await page.goto(site.origin)
  await page.getByRole('heading', { name: 'Connect to an RChat instance' }).waitFor()
  assert.deepEqual(localApi, [])
  assert.deepEqual(requests, [])
  await page.evaluate(origin => {
    localStorage.setItem('rchat_book', JSON.stringify({ v: 1, instances: [] }))
    localStorage.setItem('rchat_home', origin)
  }, api.origin)
  await page.goto(site.origin)
  await page.getByRole('heading', { name: 'Connect to an RChat instance' }).waitFor()
  await page.waitForLoadState('networkidle')
  assert.deepEqual(localApi, [])
  assert.deepEqual(requests, [])
  await page.getByLabel('Instance address').fill(site.origin)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'This address serves the app' }).waitFor()
  assert.deepEqual(localApi, [])
  await page.getByLabel('Instance address').fill(api.origin)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const trust = page.locator('[data-add-instance-step=trust]')
  await trust.waitFor()
  assert((await trust.innerText()).includes(site.host))
  assert((await trust.innerText()).includes(api.host))
  await page.getByRole('button', { name: 'I trust this app' }).click()
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.locator('form button[type=submit]').click()
  const prefix = '/@' + username + '@' + api.host + '/'
  await page.waitForURL(url => url.pathname === prefix)
  // Unload the login document before observing requests from the restored one.
  await page.goto('about:blank')
  const restored = page.waitForRequest(
    r => r.method() === 'GET' && r.url() === api.origin + '/api/v1/me'
  )
  await page.goto(site.origin + prefix)
  const response = await (await restored).response()
  assert(response?.ok())
  assert.equal((await response.json()).username, username)
  await page.goto(site.origin)
  await page.waitForURL(url => url.pathname === prefix)
  const deep = prefix + 's/rchat/'
  await page.goto('about:blank')
  const resolved = page.waitForResponse(
    r =>
      new URL(r.url()).origin === api.origin &&
      /\/servers\/rchat$/.test(new URL(r.url()).pathname) &&
      r.ok()
  )
  await page.goto(site.origin + deep)
  await resolved
  await page.waitForURL(url => url.pathname.startsWith(deep) && /\/\d+\/?$/.test(url.pathname))
  assert.deepEqual(localApi, [])
  console.log(
    'PASS clean and stale-home Welcome with zero automatic requests to either host, named trust, authenticated remote login, restored account, deep channel link and zero static-origin API requests'
  )
} finally {
  await browser.close()
}
