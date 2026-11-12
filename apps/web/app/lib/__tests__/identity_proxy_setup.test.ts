import { describe, expect, test } from 'bun:test'
import {
  ACCOUNTS_MAX,
  ALL_HEADERS,
  BROWSER_PATHS,
  HOSTS_MAX,
  PRESETS,
  STRIP_PREFIXES,
  caddyPrefixes,
  checkUrl,
  cookieWarning,
  entryLabel,
  goKey,
  hostAllowed,
  hostError,
  matches,
  missingEnv,
  pickAccount,
  pickerEntries,
  presetHeaders,
  ruleSummary,
  snippet,
  spellings,
  strippedBy,
  testLine,
  traefikKeys,
  type ProxyKind,
  type Setup,
} from '../identity/proxy_setup'

const setup = {
  applicationId: 'application_7Qk',
  host: 'wiki.example.com',
  address: 'rchat:3000',
  upstream: 'wiki:8080',
  preset: 'rchat' as const,
}

const KINDS: ProxyKind[] = ['nginx', 'traefik', 'caddy']

const block = (conf: string, opening: RegExp) => {
  const start = conf.search(opening)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = conf.slice(start)
  return rest.slice(0, rest.search(/\n\s*\}\n/) + 1)
}

// A block with the blocks nested in it, by matching braces.
const nested = (conf: string, opening: RegExp) => {
  const start = conf.search(opening)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    depth += conf[i] === '{' ? 1 : conf[i] === '}' ? -1 : 0
    if (depth === 0) return conf.slice(start, i + 1)
  }
  return conf.slice(start)
}

// The Host each proxy puts on its check request, read from the config the way the proxy reads it.
const checkHost = (kind: ProxyKind, conf: string, s: Setup) => {
  const client = (host: string | undefined) =>
    host === undefined || ['$server_name', '$host', '$http_host', '{host}'].includes(host)
  if (kind === 'nginx') {
    const check = block(conf, /location = \/_rchat_check \{/)
    const host = check.match(/proxy_set_header Host (\S+);/)?.[1]
    return host === undefined
      ? check.match(/proxy_pass http:\/\/([^/;]+)/)?.[1]
      : client(host)
        ? s.host
        : host
  }
  if (kind === 'traefik') return conf.match(/address: "http:\/\/([^/"]+)/)?.[1]
  const check = block(conf, /forward_auth \S+ \{/)
  const host = check.match(/header_up Host (\S+)/)?.[1]
  return host === '{upstream_hostport}'
    ? check.match(/forward_auth (\S+) \{/)?.[1]
    : client(host)
      ? s.host
      : host
}

// The crate's rule (`forward::proxy_path`): a check whose Host names a protected host, whatever
// its case, ports or trailing dot, is refused.
const hostName = (host: string) =>
  (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0])
    .toLowerCase()
    .replace(/\.+$/, '')
const checkRefused = (host: string | undefined, protectedHosts: readonly string[]) =>
  host === undefined || protectedHosts.some(p => hostName(p) === hostName(host))

describe('hosts', () => {
  test('come from the operator list', () => {
    const list = ['wiki.example.com', '.example.org']
    expect(hostAllowed('wiki.example.com', list)).toBe(true)
    expect(hostAllowed('a.example.org', list)).toBe(true)
    expect(hostAllowed('example.org', list)).toBe(false)
    expect(hostAllowed('admin.example.com', list)).toBe(false)
    expect(hostAllowed('evil.com\\@wiki.example.com', list)).toBe(false)
    expect(HOSTS_MAX).toBe(20)
  })
  test('refusals and warnings in plain words', () => {
    expect(hostError('taken')).toBe('Another application uses this host.')
    expect(hostError('not_listed')).toBe("This host isn't in FORWARD_AUTH_HOSTS.")
    expect(cookieWarning('example.org')).toBe('This cookie reaches every host under example.org.')
    expect(missingEnv({ hosts: false, peers: false })).toBe(
      'Set FORWARD_AUTH_HOSTS and FORWARD_AUTH_CHECK_PEERS first.'
    )
    expect(missingEnv({ hosts: true, peers: false })).toBe('Set FORWARD_AUTH_CHECK_PEERS first.')
    expect(missingEnv({ hosts: false, peers: true })).toBe('Set FORWARD_AUTH_HOSTS first.')
    expect(missingEnv({ hosts: true, peers: true })).toBeNull()
  })
})

describe('headers', () => {
  test('every spelling, mixed ones too, is stripped by its normalized name', () => {
    for (const h of ALL_HEADERS)
      for (const v of spellings(h)) {
        expect(strippedBy(v)).toBe(true)
        expect(strippedBy(v.toUpperCase())).toBe(true)
        expect(traefikKeys()).toContain(goKey(v))
      }
    for (const h of [
      'X-RChat_User',
      'X_RChat-User',
      'X-Auth_Request-User',
      'x_aUTH-request_GROUPS',
    ])
      expect(strippedBy(h)).toBe(true)
    expect(strippedBy('X-Forwarded-For')).toBe(false)
    expect(STRIP_PREFIXES.length).toBe(4)
    expect(ALL_HEADERS).toHaveLength(20)
    expect(spellings('X-Auth-Request-User').length).toBe(8)
    expect(spellings('a-'.repeat(40))).toEqual([])
    expect(caddyPrefixes()).toContain('X_auth-Request_')
    expect(caddyPrefixes().length).toBe(18)
    expect(traefikKeys().length).toBe(100)
  })
  test('each preset sets only listed headers, never an email', () => {
    expect(PRESETS.map(p => p.id)).toEqual(['rchat', 'authelia', 'authentik', 'oauth2-proxy'])
    for (const p of PRESETS) {
      const headers = presetHeaders(p.id)
      expect(headers.length).toBeGreaterThan(2)
      for (const h of headers) {
        expect(ALL_HEADERS).toContain(h)
        expect(h.toLowerCase()).not.toContain('email')
      }
    }
    expect(presetHeaders('rchat')).toEqual([
      'X-RChat-User',
      'X-RChat-Name',
      'X-RChat-Subject',
      'X-RChat-Groups',
      'X-RChat-Avatar',
      'X-RChat-Assertion',
    ])
  })
})

describe('the snippets', () => {
  test('the check names its application on the internal address', () => {
    expect(checkUrl('rchat:3000', 'nginx', 'application_7Qk')).toBe(
      'http://rchat:3000/_rchat/proxy/auth/nginx?application=application_7Qk'
    )
    for (const kind of ['nginx', 'traefik', 'caddy'] as const)
      expect(snippet(kind, setup)).toContain(
        `/_rchat/proxy/auth/${kind}?application=application_7Qk`
      )
  })
  test('every proxy calls the check on an address that names no protected host', () => {
    const setups: Setup[] = [
      setup,
      { ...setup, host: 'WIKI.example.com.', address: '10.0.0.5:3000' },
      { ...setup, host: 'wiki.example.com:8443', address: '[fd00::5]:3000', preset: 'authentik' },
    ]
    for (const kind of KINDS)
      for (const s of setups) {
        const conf = snippet(kind, s)
        const host = checkHost(kind, conf, s)
        expect(host).toBe(s.address)
        expect(checkRefused(host, [s.host])).toBe(false)
      }
    const caddy = snippet('caddy', setup)
    expect(block(caddy, /forward_auth rchat:3000 \{/)).toContain(
      '\t\t\t\theader_up Host {upstream_hostport}\n'
    )
    const passesClientHost = caddy.replace('\t\t\t\theader_up Host {upstream_hostport}\n', '')
    expect(checkRefused(checkHost('caddy', passesClientHost, setup), [setup.host])).toBe(true)
    const nginxClientHost = snippet('nginx', setup).replace(
      '    proxy_pass_request_body off;\n',
      '    proxy_pass_request_body off;\n    proxy_set_header Host $host;\n'
    )
    expect(checkRefused(checkHost('nginx', nginxClientHost, setup), [setup.host])).toBe(true)
    for (const spelling of ['wiki.example.com:443:443', 'WIKI.EXAMPLE.COM.', '[::1]'])
      expect(checkRefused(spelling, ['wiki.example.com', '[::1]:3000'])).toBe(true)
  })
  test('only the five browser pages are routed on the protected host', () => {
    expect([...BROWSER_PATHS]).toEqual([
      'start',
      'callback',
      'sign_out',
      'denied',
      'needs_two_factor',
    ])
    const pages = 'start|callback|sign_out|denied|needs_two_factor'
    expect(snippet('nginx', setup)).toContain(`location ~ ^/_rchat/proxy/(${pages})$ {`)
    expect(snippet('traefik', setup)).toContain(
      'rule: "Host(`wiki.example.com`) && PathRegexp(`^/_rchat/proxy/(' + pages + ')$`)"'
    )
    expect(snippet('caddy', setup)).toContain(
      '@rchat path /_rchat/proxy/start /_rchat/proxy/callback /_rchat/proxy/sign_out /_rchat/proxy/denied /_rchat/proxy/needs_two_factor'
    )
    for (const kind of ['nginx', 'traefik', 'caddy'] as const)
      expect(/proxy\/auth[^\n]*\n[^\n]*Host\(/.test(snippet(kind, setup))).toBe(false)
  })
  test('nginx keeps both header defaults, takes the host from its own setting and has a default server', () => {
    const conf = snippet('nginx', setup)
    expect(conf).toContain('underscores_in_headers off;')
    expect(conf).toContain('ignore_invalid_headers on;')
    expect(conf).toContain('server_name wiki.example.com;')
    expect(conf).toContain('proxy_set_header X-Original-URL $scheme://$server_name$request_uri;')
    expect(conf).toContain('listen 443 ssl default_server;')
    expect(conf).toContain('return 421;')
    expect(conf).toContain(
      'return 302 /_rchat/proxy/start?application=application_7Qk&rd=$scheme://$server_name$request_uri;'
    )
    expect(conf).toContain('proxy_pass http://wiki:8080;')
    for (const h of presetHeaders('rchat')) expect(conf).toContain(`proxy_set_header ${h} $rchat_`)
    for (const h of ALL_HEADERS.filter(h => !presetHeaders('rchat').includes(h)))
      expect(conf).toContain(`proxy_set_header ${h} "";`)
    expect(conf).not.toContain('$http_host')
    expect(conf).not.toContain('$host;')
  })
  test('Traefik removes every spelling of every header by exact name', () => {
    const conf = snippet('traefik', setup)
    for (const key of traefikKeys()) expect(conf).toContain(`          ${key}: ""\n`)
    expect(conf.match(/: ""\n/g)).toHaveLength(100)
    expect(conf).toContain('trustForwardHeader: false')
    expect(conf).toContain(
      'authResponseHeaders: ["X-RChat-User", "X-RChat-Name", "X-RChat-Subject", "X-RChat-Groups", "X-RChat-Avatar", "X-RChat-Assertion"]'
    )
    expect(conf).toContain('middlewares: ["rchat-strip", "rchat-auth"]')
  })
  test('Caddy removes every spelling of each prefix', () => {
    const conf = snippet('caddy', setup)
    for (const prefix of caddyPrefixes())
      expect(conf).toContain(`\t\t\trequest_header -${prefix}*\n`)
    expect(conf.match(/request_header -/g)).toHaveLength(18)
    expect(conf).toContain(
      '\t\t\t\tcopy_headers X-RChat-User X-RChat-Name X-RChat-Subject X-RChat-Groups X-RChat-Avatar X-RChat-Assertion\n'
    )
    expect(conf.startsWith('wiki.example.com {\n')).toBe(true)
    expect(conf).toContain('reverse_proxy wiki:8080')
  })
  test('Caddy strips the headers before the check copies its own, in a route that keeps that order', () => {
    for (const p of PRESETS) {
      const conf = snippet('caddy', { ...setup, preset: p.id })
      const route = nested(conf, /\t\troute \{\n/)
      const lines = route.split('\n').map(l => l.trim())
      const strips = lines.flatMap((l, i) => (l.startsWith('request_header -') ? [i] : []))
      const check = lines.findIndex(l => l.startsWith('forward_auth '))
      const upstream = lines.indexOf('reverse_proxy wiki:8080')
      expect(strips).toHaveLength(18)
      expect(Math.max(...strips)).toBeLessThan(check)
      expect(check).toBeLessThan(upstream)
      expect(conf.match(/request_header -|forward_auth |reverse_proxy wiki/g)).toHaveLength(20)
    }
  })
  test('another preset copies its own headers and no snippet names a header outside the list or an email', () => {
    const authelia = { ...setup, preset: 'authelia' as const }
    expect(snippet('caddy', authelia)).toContain(
      'copy_headers Remote-User Remote-Name Remote-Groups\n'
    )
    expect(snippet('traefik', authelia)).toContain(
      'authResponseHeaders: ["Remote-User", "Remote-Name", "Remote-Groups"]'
    )
    expect(snippet('nginx', authelia)).toContain('proxy_set_header X-RChat-User "";')
    for (const kind of ['nginx', 'traefik', 'caddy'] as const)
      for (const p of PRESETS) {
        const conf = snippet(kind, { ...setup, preset: p.id })
        const set = [
          ...conf.matchAll(/(?:proxy_set_header|copy_headers|authResponseHeaders:) ([^\n;]+)/g),
        ]
          .flatMap(m => m[1].split(/[\s",[\]]+/))
          .filter(w => /^(X-|Remote-)/i.test(w))
          .filter(w => !/^X-(Forwarded|Original)-/.test(w))
        expect(set.length).toBeGreaterThan(2)
        for (const h of set) expect(ALL_HEADERS).toContain(h)
        expect(
          /copy_headers[^\n]*[Ee]mail|authResponseHeaders[^\n]*[Ee]mail|\$rchat_[a-z_]*email/.test(
            conf
          )
        ).toBe(false)
      }
  })
  test('what a test of the check would give', () => {
    expect(testLine(200)).toBe('A proxy would get: allowed (200)')
    expect(testLine(302)).toBe('A proxy would get: sign in (302)')
    expect(testLine(401)).toBe('A proxy would get: sign in (401)')
    expect(testLine(403)).toBe('A proxy would get: not allowed (403)')
    expect(testLine(500)).toBe('A proxy would get: an error (500)')
  })
})

describe('listed accounts are uids the site admin picked', () => {
  const accounts = [
    { uid: 7, username: 'alice', deleted: false },
    { uid: 8, username: 'dana', deleted: true },
    { uid: 12, username: 'dana', deleted: false },
  ]
  test('only existing accounts can be listed; matching is by uid only', () => {
    expect(pickAccount(accounts, 'Alice')).toEqual({ uid: 7 })
    expect(pickAccount(accounts, 'nobody')).toBe('No account with that name')
    expect(pickAccount(accounts, 'dana')).toEqual({ uid: 12 })
    const entries = [{ uid: 7 }, { uid: 8 }]
    expect(ruleSummary(entries)).toBe('2 people listed')
    expect(ruleSummary([{ uid: 7 }])).toBe('1 person listed')
    expect(matches(entries, 7)).toBe(true)
    expect(matches(entries, 12)).toBe(false)
    expect(entryLabel({ uid: 8 }, accounts)).toBe('Deleted account')
    expect(entryLabel({ uid: 99 }, accounts)).toBe('Deleted account')
  })
  test('the picker shows each entry once, deleted ones marked, up to 500', () => {
    expect(pickerEntries([{ uid: 7 }, { uid: 8 }, { uid: 7 }], accounts)).toEqual([
      { uid: 7, label: 'alice', deleted: false },
      { uid: 8, label: 'Deleted account', deleted: true },
    ])
    expect(ACCOUNTS_MAX).toBe(500)
    const many = Array.from({ length: 600 }, (_, uid) => ({ uid }))
    expect(pickerEntries(many, [])).toHaveLength(500)
  })
})
