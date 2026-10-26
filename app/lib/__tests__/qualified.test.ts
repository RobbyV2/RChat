import { describe, expect, test } from 'bun:test'
import {
  displayQualified,
  formatQualified,
  hostOf,
  isHomeHost,
  isHost,
  normalizeHost,
  parseQualified,
  qualify,
  sameQualified,
  withInstance,
} from '../qualified'

const HOME = 'chat.example.com'

describe('qualified ids', () => {
  test('parse splits at the last @ and normalizes the host', () => {
    expect(parseQualified('alice@Chat.Example.com')).toEqual({
      name: 'alice',
      host: 'chat.example.com',
    })
    expect(parseQualified('a@b@other.example:8443')).toEqual({
      name: 'a@b',
      host: 'other.example:8443',
    })
    expect(parseQualified('bob@[::1]:3000')).toEqual({ name: 'bob', host: '[::1]:3000' })
    expect(parseQualified('alice@chat.example.com.')).toEqual({
      name: 'alice',
      host: 'chat.example.com',
    })
  })

  test('bare and malformed ids stay local', () => {
    expect(parseQualified('alice')).toEqual({ name: 'alice', host: null })
    expect(parseQualified('@host.example')).toEqual({ name: '@host.example', host: null })
    expect(parseQualified('alice@')).toEqual({ name: 'alice@', host: null })
    expect(parseQualified('mail me@not a host')).toEqual({ name: 'mail me@not a host', host: null })
    expect(parseQualified('x@-bad-.example')).toEqual({ name: 'x@-bad-.example', host: null })
  })

  test('format round trips through parse, even for names containing @', () => {
    for (const name of ['alice', 'a@b', 'Ünïcode name', 'x@y@z']) {
      const id = formatQualified(name, 'Other.Example:4000')
      expect(parseQualified(id)).toEqual({ name, host: 'other.example:4000' })
    }
  })

  test('compare is case-insensitive on names and treats bare ids as home', () => {
    expect(sameQualified('Alice', `alice@${HOME}`, HOME)).toBe(true)
    expect(sameQualified('alice@CHAT.example.com', 'ALICE', HOME)).toBe(true)
    expect(sameQualified('alice', 'alice@other.example', HOME)).toBe(false)
    expect(sameQualified('alice@a.example', 'bob@a.example', HOME)).toBe(false)
    expect(qualify('rchat', HOME)).toEqual({ name: 'rchat', host: HOME })
  })

  test('display shows the host only off the home instance', () => {
    expect(displayQualified(`alice@${HOME}`, HOME)).toBe('alice')
    expect(displayQualified('alice', HOME)).toBe('alice')
    expect(displayQualified('alice@other.example', HOME)).toBe('alice@other.example')
    expect(withInstance('Lobby', null, HOME)).toBe('Lobby')
    expect(withInstance('Lobby', 'CHAT.example.com', HOME)).toBe('Lobby')
    expect(withInstance('Lobby', 'other.example', HOME)).toBe('Lobby (on other.example)')
    expect(isHomeHost(undefined, HOME)).toBe(true)
    expect(isHomeHost('other.example', HOME)).toBe(false)
  })

  test('host helpers', () => {
    expect(hostOf('https://Chat.Example.com:443/invite/x/')).toBe('chat.example.com')
    expect(hostOf('http://127.0.0.1:3810/')).toBe('127.0.0.1:3810')
    expect(hostOf('ftp://x.example')).toBeNull()
    expect(hostOf('not a url')).toBeNull()
    expect(normalizeHost(' A.Example. ')).toBe('a.example')
    expect(isHost('a.example:99999')).toBe(false)
    expect(isHost('localhost:3000')).toBe(true)
  })

  test('IDN, case, ports and trailing dots normalize like the URL parser', () => {
    expect(parseQualified('bob@bücher.de')).toEqual({ name: 'bob', host: 'xn--bcher-kva.de' })
    expect(parseQualified('bob@BÜCHER.de:8443')).toEqual({
      name: 'bob',
      host: 'xn--bcher-kva.de:8443',
    })
    expect(normalizeHost('Bücher.DE')).toBe('xn--bcher-kva.de')
    expect(normalizeHost('CHAT.Example.COM')).toBe('chat.example.com')
    expect(normalizeHost('[::1]:3000')).toBe('[::1]:3000')
    expect(normalizeHost('[0:0::1]')).toBe('[::1]')
    expect(normalizeHost('chat.example.:443')).toBe('chat.example:443')
    expect(isHost('a.example:65535')).toBe(true)
    expect(isHost('a.example:65536')).toBe(false)
    expect(isHost('[::1]:65536')).toBe(false)
    expect(isHost('a b.example')).toBe(false)
    expect(isHost('a.example/x')).toBe(false)
    expect(isHost('user@a.example')).toBe(false)
    expect(isHost('')).toBe(false)
  })

  test('the last @ splits, and only a real host counts as one', () => {
    expect(parseQualified('old@name@chat.example.com')).toEqual({
      name: 'old@name',
      host: 'chat.example.com',
    })
    expect(parseQualified('old@name')).toEqual({ name: 'old', host: 'name' })
    expect(parseQualified('old@na me')).toEqual({ name: 'old@na me', host: null })
    expect(parseQualified('a@b@')).toEqual({ name: 'a@b@', host: null })
    expect(parseQualified('a@b@:80')).toEqual({ name: 'a@b@:80', host: null })
    expect(displayQualified(`old@name@${HOME}`, HOME)).toBe('old@name')
  })
})
