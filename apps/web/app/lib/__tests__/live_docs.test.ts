import { describe, expect, test } from 'bun:test'
import type { Book } from '../client/book'
import { REDACTED } from '../openapi'
import { Secret } from '../secret'
import {
  confirmText,
  curlFor,
  effectOf,
  fillPath,
  isWrite,
  liveAccounts,
  liveState,
  parseBody,
  parseRunAs,
  pickAccount,
  placeholders,
  redactSecrets,
  runAsValue,
  runLabel,
  showJson,
  stateText,
} from '../live_docs'

const book: Book = {
  v: 1,
  instances: [
    {
      origin: 'https://chat.example.com',
      id: 'a',
      name: 'Example chat',
      guest: false,
      accounts: [
        {
          username: 'alice',
          display: 'Alice',
          avatar: null,
          connect: true,
          added: 1,
          identities: [],
        },
        { username: 'bob', display: null, avatar: null, connect: true, added: 2, identities: [] },
      ],
    },
    { origin: 'http://localhost:3000', id: 'b', name: 'Home', guest: true, accounts: [] },
    {
      origin: 'https://other.example.org',
      id: 'c',
      name: 'Other',
      guest: false,
      accounts: [
        { username: 'alice', display: null, avatar: null, connect: true, added: 3, identities: [] },
      ],
    },
  ],
}

const tokens: Record<string, Secret> = {
  'https://chat.example.com alice': Secret.of('t1'),
  'https://other.example.org alice': Secret.of('t3'),
}
const accounts = liveAccounts(book, (origin, username) => tokens[`${origin} ${username}`] ?? null)

describe('accounts', () => {
  test('every instance account is listed with its instance, guests leave none', () => {
    expect(accounts.map(a => [a.key, a.host, a.instance])).toEqual([
      ['alice@https://chat.example.com', 'chat.example.com', 'Example chat'],
      ['bob@https://chat.example.com', 'chat.example.com', 'Example chat'],
      ['alice@https://other.example.org', 'other.example.org', 'Other'],
    ])
    expect(accounts[0].token).toBe(tokens['https://chat.example.com alice'])
    expect(accounts[1].token).toBeNull()
    expect(accounts[2].token).toBe(tokens['https://other.example.org alice'])
  })

  test('the state says what the page may do', () => {
    const [alice, bob] = accounts
    expect(liveState(alice, true)).toBe('ready')
    expect(liveState(alice, false)).toBe('off')
    expect(liveState(alice, undefined)).toBe('checking')
    expect(liveState(bob, true)).toBe('signed_out')
    expect(stateText(alice, 'off')).toBe('Trying requests is turned off on chat.example.com')
    expect(stateText(bob, 'signed_out')).toBe('Sign in to use it')
    expect(runLabel(alice)).toBe('Run as alice on chat.example.com')
  })

  test('the saved choice wins while it is listed, else the first ready account', () => {
    const ready = (a: { token: Secret | null }) => a.token !== null
    expect(pickAccount(accounts, 'alice@https://other.example.org', ready)?.key).toBe(
      'alice@https://other.example.org'
    )
    expect(pickAccount(accounts, 'gone@https://x.example', ready)?.key).toBe(
      'alice@https://chat.example.com'
    )
    expect(pickAccount([accounts[1]], null, ready)?.key).toBe('bob@https://chat.example.com')
    expect(pickAccount([], null, ready)).toBeNull()
  })

  test('the choice is stored versioned, and anything else reads as none', () => {
    expect(parseRunAs(runAsValue('alice@https://chat.example.com'))).toBe(
      'alice@https://chat.example.com'
    )
    for (const bad of [null, '', 'alice', '{"v":2,"key":"x"}', '{"v":1}', '[1]'])
      expect(parseRunAs(bad)).toBeNull()
  })
})

describe('requests', () => {
  test('writes ask with their effect, the account and the instance', () => {
    expect(isWrite('get')).toBe(false)
    expect(isWrite('POST')).toBe(true)
    expect(effectOf('Sends a message to {id}.', 'POST', '/dms/{id}/messages')).toBe(
      'Sends a message to {id}'
    )
    expect(effectOf(undefined, 'delete', '/blocks/{username}')).toBe(
      'Sends DELETE /blocks/{username}'
    )
    expect(confirmText('Sends a message to your notes', 'POST', '/x', accounts[0])).toBe(
      'Sends a message to your notes as alice on chat.example.com.'
    )
  })

  test('placeholders are filled once all have values, and encoded', () => {
    expect(placeholders('/servers/{name}/channels/{id}/x/{name}')).toEqual(['name', 'id'])
    expect(fillPath('/servers/{name}', {})).toBeNull()
    expect(fillPath('/servers/{name}', { name: '  ' })).toBeNull()
    expect(fillPath('/servers/{name}/x', { name: 'a b/c' })).toBe('/servers/a%20b%2Fc/x')
    expect(fillPath('/me', {})).toBe('/me')
  })

  test('copied requests carry a placeholder for the token', () => {
    expect(curlFor('https://chat.example.com/api/v1', 'get', '/me', null)).toBe(
      "curl -X GET 'https://chat.example.com/api/v1/me' \\\n  -H 'Authorization: Bearer <token>'"
    )
    const post = curlFor('https://c/api/v1', 'POST', '/dms/1/messages', `{"content":"it's"}`)
    expect(post).toContain("-H 'Content-Type: application/json'")
    expect(post).toContain(`-d '{"content":"it'\\''s"}'`)
  })

  test('bodies parse as JSON or say why not', () => {
    expect(parseBody('  ')).toEqual({ ok: true, value: undefined })
    expect(parseBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseBody('{a:1}')).toEqual({ ok: false, error: 'The body is not valid JSON.' })
  })
})

describe('answers', () => {
  test('secrets never show, in any mode', () => {
    const answer = {
      token: 'abc',
      user: { username: 'alice', password_temporary: null, has_password: true },
      keys: ['k1'],
      secret: '',
      list: [{ api_key: 'z', name: 'n' }],
    }
    expect(redactSecrets(answer)).toEqual({
      token: REDACTED,
      user: { username: 'alice', password_temporary: null, has_password: true },
      keys: REDACTED,
      secret: '',
      list: [{ api_key: REDACTED, name: 'n' }],
    })
  })

  test('streamer mode marks the personal strings and nothing else', () => {
    const value = { id: 7, username: 'alice', content: 'hi', count: 2, nested: { name: 'club' } }
    const off = showJson(value, false)
    expect(off).toEqual([{ text: JSON.stringify(value, null, 2), personal: false }])
    const on = showJson(value, true)
    expect(on.map(p => p.text).join('')).toBe(JSON.stringify(value, null, 2))
    expect(on.filter(p => p.personal).map(p => p.text)).toEqual(['"alice"', '"hi"', '"club"'])
    expect(showJson({ username: REDACTED }, true).some(p => p.personal)).toBe(false)
    expect(showJson([], true)).toEqual([{ text: '[]', personal: false }])
  })
})
