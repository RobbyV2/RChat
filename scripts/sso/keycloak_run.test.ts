import { expect, test } from 'bun:test'
import { CookieJar, formAction, locationParam } from './keycloak_run'

test('the login form action preserves the provider query', () => {
  const action = 'http://localhost:18080/realms/rchat/login-actions/authenticate?session_code=a'
  expect(formAction(`<form id="kc-form-login" action="${action}&amp;execution=b">`)).toBe(
    action + '&execution=b'
  )
  expect(formAction('<form action="/other"><form id="kc-form-login" action=\'/login\'>')).toBe(
    '/login'
  )
  expect(formAction('<main>Unavailable</main>')).toBeNull()
  expect(locationParam('http://x/sso?code=ab&z=1', 'code')).toBe('ab')
  expect(locationParam('http://x/sso?error=expired', 'code')).toBeNull()
})

test('login cookies follow their origin, path, expiry and secure flag', () => {
  const jar = new CookieJar()
  const source = 'https://idp.test/realms/rchat/auth'
  const set = (value: string) =>
    jar.take(new Response(null, { headers: { 'set-cookie': value } }), source)
  set('login=one; Path=/realms/rchat; Secure; HttpOnly')
  set('state=two; Path=/')
  expect(jar.header(source)).toBe('login=one; state=two')
  expect(jar.header('https://idp.test/realms/rchat2')).toBe('state=two')
  expect(jar.header('https://chat.test/realms/rchat/auth')).toBe('')
  expect(jar.header('http://idp.test/realms/rchat/auth')).not.toContain('login=one')
  set('login=; Max-Age=0; Path=/realms/rchat')
  expect(jar.header(source)).toBe('state=two')
})
