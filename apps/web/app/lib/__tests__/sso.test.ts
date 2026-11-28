import { unnamed } from '../names'
import assert from 'node:assert/strict'
import { test, expect } from 'bun:test'
import {
  challengeOf,
  newVerifier,
  parseReturn,
  parseIntent,
  parseLogoutFlag,
  SSO_LOGOUT_KEY,
  startUrl,
  showRegister,
  showPasswordForm,
  INTENT_TTL_MS,
} from '../sso'
test('S256 matches RFC 7636 and secrets are fresh', async () => {
  expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
  expect(newVerifier()).toHaveLength(43)
  expect(newVerifier()).not.toBe(newVerifier())
})
test('wire names and callback results', () => {
  expect(startUrl('https://c.example/api', 'okta', 'app', 'C', 'T')).toBe(
    'https://c.example/api/auth/oidc/okta/start?return=app&challenge=C&ticket=T'
  )
  expect(parseReturn('?code=ab')).toEqual({ code: 'ab' })
  expect(parseReturn('?error=denied')).toEqual({ error: 'denied' })
  expect(parseReturn('?error=other')).toEqual({ error: 'failed' })
  expect(parseReturn('')).toBeNull()
})
test('intent format, expiry and credential lifetime', () => {
  const now = Date.now(),
    intent = {
      v: 1,
      provider: 'local',
      purpose: 'login',
      origin: 'https://alpha.example',
      username: null,
      verifier: newVerifier(),
      back: '/',
      at: now,
    } as const
  expect(parseIntent(JSON.stringify(intent), now)).toEqual(intent)
  for (const raw of [
    'bad',
    JSON.stringify({ ...intent, v: 2 }),
    JSON.stringify({ ...intent, verifier: '' }),
    JSON.stringify({ ...intent, at: now - INTENT_TTL_MS }),
  ])
    expect(parseIntent(raw, now)).toBeNull()
})
test('password override and registration eligibility', () => {
  const policy = {
    password_login: false,
    registration: 'open' as const,
    providers: [{ id: 'id', name: 'Local' }],
    client_return: null,
    confirm_login: null,
  }
  expect(showPasswordForm(policy, '')).toBe(false)
  expect(showPasswordForm(policy, '?local=1')).toBe(true)
  expect(showPasswordForm(undefined, '')).toBe(true)
  expect(showPasswordForm({ ...policy, providers: [] }, '')).toBe(true)
  expect(showRegister(policy)).toBe(false)
  expect(showRegister({ ...policy, password_login: true })).toBe(true)
  expect(showRegister({ ...policy, password_login: true, registration: 'sso' })).toBe(false)
})

import { deliverReturn, SSO_KEY, beginPopup, readIntent } from '../sso'
import { deepLinkTarget } from '../deep_links'
import { setAuthBrowser } from '../platform'
import { testAccount } from './test_account'
test('shell returns retain the issuing authority, popup delivery only consumes its own pending purpose', async () => {
  const origin = 'https://alpha.example'
  expect(deepLinkTarget('rchat://alpha.example/sso?code=ab', origin)).toEqual({
    kind: 'home',
    path: '/sso?code=ab',
  })
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const storage = new Map<string, string>()
  const location = new URL(origin + '/settings')
  const fixture = Object.assign(new EventTarget(), {
    location,
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
  })
  Object.defineProperty(globalThis, 'window', { value: fixture, configurable: true })
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true })
  const acct = testAccount('alice', origin)
  try {
    const ready = Promise.withResolvers<void>()
    setAuthBrowser({
      returnTo: 'app',
      navigate: () => {},
      popup: () => {
        ready.resolve()
        return true
      },
    })
    let open = true
    const dismissed = beginPopup(acct, 'local', 'reauth', 'ticket', () => open)
    open = false
    expect(await dismissed.catch(e => e)).toBe('expired')
    expect(readIntent()).toBeNull()
    const pending = beginPopup(acct, 'local', 'reauth', 'ticket')
    await ready.promise
    const issuer = acct.conn.origin
    expect(deliverReturn('?code=ab', 'https://unrelated.example')).toBe(false)
    expect(deliverReturn('?code=ab', issuer)).toBe(true)
    expect((await pending).code).toBe('ab')
    expect(storage.size).toBe(0)
    const login = {
      v: 1,
      provider: 'local',
      purpose: 'login',
      origin,
      username: null,
      back: '/',
      verifier: newVerifier(),
      at: Date.now(),
    }
    storage.set(SSO_KEY, JSON.stringify(login))
    expect(deliverReturn('?error=denied', origin)).toBe(false)
    expect(readIntent()?.error).toBeUndefined()
    storage.set(SSO_KEY, JSON.stringify({ ...login, purpose: 'link' }))
    expect(deliverReturn('?error=denied', origin)).toBe(true)
    expect(readIntent()?.error).toBe('denied')
    setAuthBrowser({ returnTo: 'web', navigate: () => {}, popup: () => false })
    expect(await beginPopup(acct, 'local', 'link', 'ticket').catch(e => e)).toBe('popup')
    expect(readIntent()).toBeNull()
  } finally {
    setAuthBrowser()
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

import { me } from './fixtures'
test('a mismatched pinned user is never entered, and a late exchange cannot reactivate a retired owner', async () => {
  const acct = testAccount('alice', 'https://pinned.test')
  acct.credentialTarget = 'alice'
  const result = {
    kind: 'session' as const,
    user: me('jules'),
    token: 'fixture-jules',
    end_session: false,
  }
  const revoked: string[] = []
  acct.api.logout = async token => {
    if (token) revoked.push(plain(token)!)
    return { ok: true }
  }
  acct.api.ssoExchange = async () => result
  const input = { code: 'aa', verifier: newVerifier() }
  await assert.rejects(
    acct.store.getState().ssoExchange(input, () => true),
    /saved username/
  )
  expect(acct.store.getState().token).toBeNull()
  const held = Promise.withResolvers<typeof result>()
  acct.api.ssoExchange = () => held.promise
  const pending = acct.store.getState().ssoExchange(input, () => true)
  acct.lifetime.endSession()
  held.resolve(result)
  await assert.rejects(pending, /expired/)
  expect(acct.store.getState().token).toBeNull()
  expect(revoked).toEqual(['fixture-jules', 'fixture-jules'])
})

test('cancelling an issued login while book admission waits revokes only its token', async () => {
  const { client } = await import('../client/client')
  const actor = testAccount('alice', 'https://pending-provider.test')
  const neighbor = testAccount('alice', 'https://other-provider.test')
  const original = client.updateBook
  const book = client.book.getState()
  const revoked: string[] = []
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let current = true
  try {
    actor.store.setState({
      token: Secret.of('kept-on-issuer'),
      loadInstance: async () => true,
      loadSettings: async () => {},
    })
    neighbor.store.setState({ token: Secret.of('kept-elsewhere') })
    actor.api.ssoExchange = async () => ({
      kind: 'session',
      user: me('alice'),
      token: 'abandoned',
      end_session: false,
    })
    actor.api.logout = async token => {
      revoked.push(plain(token)!)
      return { ok: true }
    }
    client.updateBook = async apply => {
      entered.resolve()
      await proceed.promise
      return apply(book)
    }
    const login = actor.store
      .getState()
      .ssoExchange({ code: 'fixture', verifier: newVerifier() }, () => current)
    await entered.promise
    current = false
    actor.store.setState({ token: Secret.of('newer-on-issuer') })
    proceed.resolve()
    await assert.rejects(login, /expired/)
    expect(revoked).toEqual(['abandoned'])
    expect(plain(actor.store.getState().token)).toBe('newer-on-issuer')
    expect(plain(neighbor.store.getState().token)).toBe('kept-elsewhere')
    expect(client.book.getState()).toBe(book)
  } finally {
    client.updateBook = original
    proceed.resolve()
  }
})

test('a native login survives a fresh window, expires by issuer/account, and an older cancel leaves its successor intact', async () => {
  const { beginLogin, clearIntent } = await import('../sso')
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const entries = new Map<string, string>()
  const storage = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
  })
  const freshWindow = () =>
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: storage(new Map()),
        location: new URL('https://fixture-shell.test/'),
      },
    })
  const owner = testAccount('alice', 'https://native-a.example')
  const other = testAccount('bob', 'https://native-b.example')
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage(entries),
    })
    freshWindow()
    setAuthBrowser({ returnTo: 'app', navigate: () => {}, popup: () => false })
    await beginLogin(owner, 'fixture', '/dm/3/', 'alice')
    const first = readIntent()!
    freshWindow()
    expect(readIntent()).toEqual(first)
    await beginLogin(other, 'fixture', '/dm/4/', 'bob')
    const next = readIntent()!
    clearIntent(first)
    expect(next.origin).toBe(other.conn.origin)
    expect(next.username).toBe('bob')
    expect(readIntent()).toEqual(next)
    expect([...entries.values()].some(v => v.includes(first.verifier))).toBe(false)
    setAuthBrowser({ returnTo: 'web', navigate: () => {}, popup: () => false })
    expect(readIntent()).toBeNull()
    setAuthBrowser({ returnTo: 'app', navigate: () => {}, popup: () => false })
    const slot = [...entries.keys()].find(k => entries.get(k)?.includes(next.verifier))!
    entries.set(slot, JSON.stringify({ ...next, at: Date.now() - INTENT_TTL_MS }))
    expect(readIntent()).toBeNull()
    expect(entries.size).toBe(0)
  } finally {
    setAuthBrowser()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('logout preference is versioned and belongs to the admitted credential', async () => {
  for (const raw of [null, 'bad', '{"v":2,"on":true}', '{"v":1,"on":"true"}'])
    expect(parseLogoutFlag(raw)).toBe(false)
  const { confirmCredential, forgetCredential } = await import('../client/credentials')
  const { accountStorage } = await import('../client/keys')
  const actor = testAccount('alice', 'https://logout.example')
  const conn = actor.conn
  const flag = (name: string) =>
    parseLogoutFlag(localStorage.getItem(accountStorage(conn).key(SSO_LOGOUT_KEY + ':' + name)))
  confirmCredential(conn, me('alice'), Secret.of('old'), false, true)
  confirmCredential(conn, me('bob'), Secret.of('neighbor'), false, true)
  confirmCredential(conn, me('alice'), Secret.of('old'), true)
  expect(flag('alice')).toBe(true)
  confirmCredential(conn, me('alice'), Secret.of('new'), false, true)
  forgetCredential(conn, 'alice', Secret.of('old'))
  expect(flag('alice')).toBe(true)
  confirmCredential(conn, me('alice'), Secret.of('password'), false)
  expect(flag('alice')).toBe(false)
  expect(flag('bob')).toBe(true)
  forgetCredential(conn, 'bob', Secret.of('neighbor'))
  expect(flag('bob')).toBe(false)
})

test('only the originating foreground session follows its logout response', async () => {
  const { client } = await import('../client/client')
  const { confirmCredential } = await import('../client/credentials')
  const { drain } = await import('./fixtures')
  const original = client.shown
  const owner = testAccount('alice', 'https://endsession.example')
  const neighbor = testAccount('bob', owner.conn.origin)
  const visited: string[] = []
  const url = 'https://idp.example/end_session'
  setAuthBrowser({
    returnTo: 'web',
    navigate: dest => {
      visited.push(dest)
    },
    popup: () => false,
  })
  try {
    for (const mode of ['background', 'switched', 'replaced', 'foreground']) {
      client.shown = () => (mode === 'background' ? neighbor : owner)
      const token = 'fixture-' + mode
      confirmCredential(owner.conn, me('alice'), Secret.of(token), false, true)
      owner.store.setState({ me: me('alice'), token: Secret.of(token) })
      const response = Promise.withResolvers<{ ok: boolean; end_session_url: string }>()
      owner.api.logout = received => {
        expect(plain(received)).toBe(token)
        return response.promise
      }
      const done = owner.store.getState().logout()
      expect(owner.store.getState().token).toBeNull()
      if (mode === 'switched') client.shown = () => neighbor
      if (mode === 'replaced') owner.lifetime.endSession()
      response.resolve({ ok: true, end_session_url: url })
      await done
      await drain()
      expect(visited).toEqual(mode === 'foreground' ? [url] : [])
    }
  } finally {
    client.shown = original
    setAuthBrowser()
  }
})

import { canUnlink, linkable } from '../sso'
import type { LinkedProvider } from '../types'
test('protect the last sign-in and list remaining providers in configuration order', () => {
  // Links from an older server, which leaves `can_unlink` out.
  const links = [{ provider: 'a', name: 'A', linked_at: 0 }] as LinkedProvider[]
  expect(canUnlink({ has_password: false }, links, 'a')).toBe(false)
  expect(canUnlink({ has_password: true }, links, 'a')).toBe(true)
  expect(canUnlink({ has_password: false }, [...links, { ...links[0], provider: 'b' }], 'a')).toBe(
    true
  )
  const providers = ['z', 'a', 'b'].map(id => ({ id, name: id }))
  expect(
    linkable(
      {
        password_login: true,
        registration: 'open',
        providers,
        client_return: null,
        confirm_login: null,
      },
      links
    ).map(p => p.id)
  ).toEqual(['z', 'b'])
})

import { ssoActions } from '../sso_actions'
import { paletteCtx } from '../actions/ctx'
test('sign-in commands target their account and require a member and configured provider', () => {
  const owner = testAccount('alice')
  const state = owner.store.getState()
  const instance = {
    ...state.instance!,
    auth: {
      registration: 'open' as const,
      password_login: true,
      providers: [{ id: 'work', name: 'Work' }],
      client_return: null,
      confirm_login: null,
    },
  }
  owner.store.setState({
    instance,
    me: { ...state.me!, has_password: false },
    signInChoices: {
      mark: owner.lifetime.sessionMark(),
      username: 'alice',
      links: [{ provider: 'kc', name: 'Keycloak', linked_at: 0, can_unlink: false }],
    },
  })
  for (const action of ssoActions) {
    const ctx = paletteCtx(owner.store.getState(), owner)
    expect(action.available(ctx)).toBe(true)
    expect(action.available({ ...ctx, s: { ...ctx.s, guest: true } })).toBe(false)
    expect(action.available({ ...ctx, s: { ...ctx.s, instance: null } })).toBe(false)
    expect(action.available({ ...ctx, s: { ...ctx.s, me: null } })).toBe(false)
    expect(
      action.available({
        ...ctx,
        s: {
          ...ctx.s,
          me: { ...ctx.s.me!, password_temporary: { expires_at: null, change: 'required' } },
        },
      })
    ).toBe(false)
    const step = action.args![0]
    if (step.kind !== 'choice') throw Error('expected provider picker')
    if (action.danger) {
      expect(step.choices(ctx, '')).toEqual([])
      owner.store.setState({
        signInChoices: {
          ...ctx.s.signInChoices!,
          links: [
            { provider: 'work', name: 'Work', linked_at: 0, can_unlink: false },
            { provider: 'kc', name: 'Keycloak', linked_at: 0, can_unlink: true },
          ],
        },
      })
      expect(step.choices(paletteCtx(owner.store.getState(), owner), '')).toEqual([
        { value: 'kc', label: unnamed('Keycloak') },
      ])
    }
    const fresh = paletteCtx(owner.store.getState(), owner)
    const pick = step.choices(fresh, '')[0]
    expect(pick.value).toBe(action.danger ? 'kc' : 'work')
    action.run(fresh, { provider: pick.value })
    expect(owner.store.getState().activeDialog).toEqual({
      kind: 'settings',
      section: 'profile',
      sso: { type: action.danger ? 'unlink' : 'link', p: { id: pick.value, name: pick.label } },
    })
  }
})

import { registerAppActions } from '../actions'
import { ctxFor } from '../actions/ctx'
import { menuItems } from '../actions/menu'
import { Secret } from '../secret'
import { plain } from './helpers/secret'
test('a linked sign-in row menu unlinks it only while another sign-in stays', async () => {
  registerAppActions()
  const owner = testAccount('alice')
  let asked = 0
  const rows = (allowed: boolean) =>
    menuItems(
      ctxFor(
        owner.store.getState(),
        { kind: 'sign_in', name: 'Work', allowed, unlink: () => asked++ },
        'menu',
        owner
      )
    )
  const [row] = rows(true)
  expect(rows(true)).toHaveLength(1)
  expect(row).toMatchObject({ label: unnamed('Unlink Work'), danger: true, disabled: false })
  row.action!()
  await Promise.resolve()
  expect(asked).toBe(1)
  expect(rows(false)).toMatchObject([
    { label: unnamed('Unlink Work'), danger: true, disabled: true },
  ])
  owner.store.setState({ me: null, guest: true })
  expect(rows(true)).toEqual([])
})

test('an interrupted foreground confirmation pins a new login and discards the old operation', async () => {
  const { client } = await import('../client/client')
  const { watchProviderConfirmation, confirmationHint } = await import('../provider_confirmation')
  const account = testAccount('alice', 'https://rotation.example')
  const neighbor = testAccount('bob', account.conn.origin)
  const original = client.shown
  try {
    client.shown = () => account
    account.store.setState({
      token: Secret.of('old'),
      instance: { auth: { confirm_login: true } } as import('../types').InstanceInfo,
    })
    let discarded = false
    const stop = watchProviderConfirmation(
      account,
      'work',
      () => true,
      () => {
        discarded = true
      }
    )
    account.store.getState().expireSession()
    expect(discarded).toBe(true)
    expect(account.store.getState().token).toBeNull()
    expect(confirmationHint(account)?.username).toBe('alice')
    expect(confirmationHint(account)?.provider).toBe('work')
    expect(confirmationHint(neighbor)).toBeUndefined()
    stop()
    client.show(neighbor, 'none')
    expect(confirmationHint(account)).toBeUndefined()
    expect(startUrl('/api', 'work', 'web', 'new', undefined, true)).toEndWith(
      'challenge=new&confirm=1'
    )
  } finally {
    client.shown = original
  }
})

test('recent provider proof belongs to the admitted actor, token and session and is consumed once', async () => {
  const { client } = await import('../client/client')
  const { acceptRecentConfirmation, recentConfirmation, takeRecentConfirmation } =
    await import('../provider_confirmation')
  const account = testAccount('alice')
  const original = client.shown
  const proof = {
    provider: 'work',
    code: 'confirmation',
    expires_at: Math.floor(Date.now() / 1000) + 60,
  }
  try {
    client.shown = () => account
    account.store.setState({ token: Secret.of('new') })
    acceptRecentConfirmation(account, 'bob', 'new', 'work', proof)
    acceptRecentConfirmation(account, 'alice', 'old', 'work', proof)
    acceptRecentConfirmation(account, 'alice', 'new', 'work', { ...proof, expires_at: 1 })
    expect(recentConfirmation(account, 'work')).toBeUndefined()
    acceptRecentConfirmation(account, 'alice', 'new', 'work', proof)
    expect(recentConfirmation(account, 'other')).toBeUndefined()
    expect(takeRecentConfirmation(account, 'work')).toEqual(proof)
    expect(() => takeRecentConfirmation(account, 'work')).toThrow()
    acceptRecentConfirmation(account, 'alice', 'new', 'work', proof)
    account.lifetime.endSession()
    expect(recentConfirmation(account, 'work')).toBeUndefined()
  } finally {
    client.shown = original
  }
})

for (const sibling of [false, true])
  test(
    'delayed confirmation exchange preserves a newer login on the ' +
      (sibling ? 'sibling' : 'owner'),
    async () => {
      const origin = 'https://' + (sibling ? 'sibling' : 'owner') + '.late.example'
      const owner = testAccount('alice', origin)
      const target = sibling ? testAccount('alice', origin) : owner
      const response = (token: string) => ({
        kind: 'session' as const,
        user: me('alice'),
        token,
        end_session: false,
      })
      const entered = Promise.withResolvers<void>()
      const reply = Promise.withResolvers<ReturnType<typeof response>>()
      const revoked: string[] = []
      try {
        for (const a of [owner, target]) {
          a.socketAllowed = false
          a.credentialTarget = 'alice'
          a.store.setState({
            me: null,
            token: null,
            instance: { auth: { confirm_login: true } } as import('../types').InstanceInfo,
            loadInstance: async () => true,
            loadSettings: async () => {},
          })
        }
        owner.api.ssoExchange = () => {
          entered.resolve()
          return reply.promise
        }
        owner.api.logout = async token => {
          revoked.push(plain(token)!)
          return { ok: true }
        }
        const pending = owner.store
          .getState()
          .ssoExchange({ code: 'old', verifier: newVerifier(), confirm_as: 'alice' }, () => true)
        await entered.promise
        await target.store.getState().enterSsoSession(response('newer'), () => true)
        reply.resolve(response('late'))
        await assert.rejects(pending, /expired/)
        expect(plain(target.store.getState().token)).toBe('newer')
        expect(target.store.getState().activeDialog).toBeNull()
        expect(target.store.getState().providerConfirmation).toBeUndefined()
        expect(revoked).toEqual(['late'])
      } finally {
        reply.resolve(response('late'))
        if (sibling) target.store.dispose()
      }
    }
  )
