import { createHash, randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

export function formAction(html: string): string | null {
  const forms = html.match(/<form\b[^>]*>/gi) ?? []
  const form = forms.find(tag => /\sid=["']kc-form-login["']/i.test(tag)) ?? forms[0]
  const action = form?.match(/\saction\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
  return action ? (action[1] ?? action[2]).replaceAll('&amp;', '&') : null
}

export function locationParam(location: string, name: string): string | null {
  return new URL(location).searchParams.get(name)
}

type SavedCookie = {
  name: string
  value: string
  origin: string
  path: string
  expiresAt: number
}

export class CookieJar {
  private readonly cookies = new Map<string, SavedCookie>()

  take(res: Response, from = res.url) {
    const source = new URL(from)
    for (const raw of res.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(raw)
      if (cookie.secure && source.protocol !== 'https:') {
        // Browsers allow Secure cookies on the localhost development issuer.
        if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) continue
      }
      const path = /;\s*path=\//i.test(raw)
        ? cookie.path
        : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/'
      const key = JSON.stringify([source.origin, path, cookie.name])
      const expiresAt =
        cookie.maxAge != null
          ? Date.now() + cookie.maxAge * 1000
          : (cookie.expires?.getTime() ?? Infinity)
      if (expiresAt <= Date.now()) this.cookies.delete(key)
      else
        this.cookies.set(key, {
          name: cookie.name,
          value: cookie.value,
          origin: source.origin,
          path,
          expiresAt,
        })
    }
  }

  header(url: string) {
    const { origin, pathname } = new URL(url)
    return [...this.cookies.values()]
      .filter(
        cookie =>
          cookie.origin === origin &&
          cookie.expiresAt > Date.now() &&
          (pathname === cookie.path ||
            pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/'))
      )
      .sort((left, right) => right.path.length - left.path.length)
      .map(cookie => cookie.name + '=' + cookie.value)
      .join('; ')
  }
}

function requireStatus(response: Response, expected: number) {
  if (response.status !== expected)
    throw Error(`Expected HTTP ${expected}, received ${response.status}`)
}

function requireOrigin(address: string, origin: string, base?: string) {
  const url = new URL(address, base)
  if (url.origin !== origin || url.username || url.password)
    throw Error('Unexpected redirect origin')
  return url.href
}

function redirect(response: Response, origin: string) {
  const location = response.headers.get('location')
  if (response.status < 300 || response.status >= 400 || !location)
    throw Error('Expected a redirect')
  return requireOrigin(location, origin, response.url)
}

async function run() {
  const { values } = parseArgs({
    options: {
      api: { type: 'string', default: 'http://localhost:3000/api' },
      keycloak: { type: 'string', default: 'http://localhost:18080' },
      user: { type: 'string', default: 'alice' },
      password: { type: 'string' },
    },
  })
  const api = values.api!.replace(/\/$/, '')
  const kc = values.keycloak!.replace(/\/$/, '')
  const appOrigin = new URL(api).origin
  const idpOrigin = new URL(kc).origin
  const user = values.user!
  const password = values.password ?? process.env.RCHAT_TEST_PASSWORD
  const adminUser = process.env.KC_BOOTSTRAP_ADMIN_USERNAME ?? 'admin'
  const adminPassword = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD
  if (!password || !adminPassword)
    throw Error('Provide the fixture password and KC_BOOTSTRAP_ADMIN_PASSWORD')
  const request = (url: string, init?: RequestInit) =>
    fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const start = await request(api + '/auth/oidc/keycloak/start?return=web&challenge=' + challenge)
  const authorize = redirect(start, idpOrigin)
  const page = await request(authorize)
  requireStatus(page, 200)
  const jar = new CookieJar()
  jar.take(page)
  const rawAction = formAction(await page.text())
  if (!rawAction) throw Error('Keycloak login form is missing')
  const action = requireOrigin(rawAction, idpOrigin, authorize)
  console.log('PASS Keycloak login form')
  const loggedIn = await request(action, {
    method: 'POST',
    headers: { cookie: jar.header(action) },
    body: new URLSearchParams({ username: user, password }),
  })
  const callback = await request(redirect(loggedIn, appOrigin))
  const code = locationParam(redirect(callback, appOrigin), 'code')
  if (!code) throw Error('RChat callback did not return a code')
  console.log('PASS RChat provider callback')
  const exchanged = await request(api + '/auth/oidc/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  })
  requireStatus(exchanged, 200)
  const session = await exchanged.json()
  if (session.kind !== 'session' || !session.token)
    throw Error('Expected an authenticated fixture account')
  const me = () => request(api + '/me', { headers: { authorization: 'Bearer ' + session.token } })
  const profile = await me()
  requireStatus(profile, 200)
  if ((await profile.json()).username !== session.user.username)
    throw Error('Unexpected RChat account')
  console.log('PASS authenticated RChat profile')

  const admin = await request(kc + '/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUser,
      password: adminPassword,
    }),
  })
  requireStatus(admin, 200)
  const token = (await admin.json()).access_token
  if (!token) throw Error('Keycloak admin authentication failed')
  const users = kc + '/admin/realms/rchat/users'
  const headers = { authorization: 'Bearer ' + token }
  const lookup = await request(
    users + '?' + new URLSearchParams({ username: user, exact: 'true' }),
    { headers }
  )
  requireStatus(lookup, 200)
  const matches = await lookup.json()
  if (matches.length !== 1 || matches[0].username !== user || !matches[0].id)
    throw Error('Expected exactly one matching Keycloak fixture user')
  const ended = await request(users + '/' + encodeURIComponent(matches[0].id) + '/logout', {
    method: 'POST',
    headers,
  })
  requireStatus(ended, 204)
  console.log('PASS Keycloak logout')
  const deadline = Date.now() + 10_000
  do {
    const current = await me()
    if (current.status === 401) {
      console.log('PASS RChat bearer revoked')
      return
    }
    requireStatus(current, 200)
    await Bun.sleep(100)
  } while (Date.now() < deadline)
  throw Error('RChat bearer stayed active after Keycloak logout')
}

if (import.meta.main) {
  run().catch(error => {
    console.error('FAIL', error instanceof Error ? error.message : 'Sign-in check failed')
    process.exitCode = 1
  })
}
