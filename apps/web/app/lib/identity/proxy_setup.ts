export type ProxyKind = 'nginx' | 'traefik' | 'caddy'
export type Preset = 'rchat' | 'authelia' | 'authentik' | 'oauth2-proxy'

export const HOSTS_MAX = 20
export const ACCOUNTS_MAX = 500

export const ALL_HEADERS = [
  'X-RChat-User',
  'X-RChat-Name',
  'X-RChat-Subject',
  'X-RChat-Groups',
  'X-RChat-Avatar',
  'X-RChat-Assertion',
  'Remote-User',
  'Remote-Name',
  'Remote-Groups',
  'Remote-Email',
  'X-authentik-username',
  'X-authentik-name',
  'X-authentik-uid',
  'X-authentik-groups',
  'X-authentik-email',
  'X-authentik-meta-app',
  'X-Auth-Request-User',
  'X-Auth-Request-Preferred-Username',
  'X-Auth-Request-Groups',
  'X-Auth-Request-Email',
]

export const PRESETS: readonly { id: Preset; label: string; headers: readonly string[] }[] = [
  {
    id: 'rchat',
    label: 'X-RChat-*',
    headers: [
      'X-RChat-User',
      'X-RChat-Name',
      'X-RChat-Subject',
      'X-RChat-Groups',
      'X-RChat-Avatar',
      'X-RChat-Assertion',
    ],
  },
  { id: 'authelia', label: 'Authelia', headers: ['Remote-User', 'Remote-Name', 'Remote-Groups'] },
  {
    id: 'authentik',
    label: 'authentik',
    headers: [
      'X-authentik-username',
      'X-authentik-name',
      'X-authentik-uid',
      'X-authentik-groups',
      'X-authentik-meta-app',
    ],
  },
  {
    id: 'oauth2-proxy',
    label: 'oauth2-proxy',
    headers: ['X-Auth-Request-User', 'X-Auth-Request-Preferred-Username', 'X-Auth-Request-Groups'],
  },
]

export const presetHeaders = (preset: Preset) => [
  ...(PRESETS.find(p => p.id === preset)?.headers ?? []),
]

export const STRIP_PREFIXES = ['x-rchat-', 'remote-', 'x-authentik-', 'x-auth-request-']
export const BROWSER_PATHS = [
  'start',
  'callback',
  'sign_out',
  'denied',
  'needs_two_factor',
] as const
const MAX_SEPARATORS = 16

export const normalize = (name: string) => name.toLowerCase().replaceAll('_', '-')
export const strippedBy = (name: string) => STRIP_PREFIXES.some(p => normalize(name).startsWith(p))

export const spellings = (name: string): string[] => {
  const parts = name.split(/[-_]/)
  if (parts.length - 1 > MAX_SEPARATORS) return []
  const out: string[] = []
  for (let mask = 0; mask < 1 << (parts.length - 1); mask++)
    out.push(
      parts.reduce((a, p, i) => (i === 0 ? p : a + ((mask >> (i - 1)) & 1 ? '_' : '-') + p), '')
    )
  return out
}

export const goKey = (name: string) =>
  name.toLowerCase().replace(/(^|-)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

export const caddyPrefixes = () => [
  ...new Set(
    STRIP_PREFIXES.flatMap(p =>
      spellings(p.slice(0, -1)).flatMap(s => [goKey(`${s}-`), goKey(`${s}_`)])
    )
  ),
]

export const traefikKeys = () => [...new Set(ALL_HEADERS.flatMap(h => spellings(h).map(goKey)))]

export const hostAllowed = (host: string, operatorList: readonly string[]) => {
  const h = host.toLowerCase()
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(h) || h.startsWith('.') || h.includes('..')) return false
  const name = h.replace(/:\d+$/, '')
  return operatorList.some(e =>
    e.startsWith('.') ? name.endsWith(e) && name.length > e.length : name === e.replace(/:\d+$/, '')
  )
}

export const hostError = (why: 'taken' | 'not_listed') =>
  why === 'taken' ? 'Another application uses this host.' : "This host isn't in FORWARD_AUTH_HOSTS."

export const cookieWarning = (domain: string) => `This cookie reaches every host under ${domain}.`

export const missingEnv = (set: { hosts: boolean; peers: boolean }) => {
  const missing = [
    ...(set.hosts ? [] : ['FORWARD_AUTH_HOSTS']),
    ...(set.peers ? [] : ['FORWARD_AUTH_CHECK_PEERS']),
  ]
  return missing.length ? `Set ${missing.join(' and ')} first.` : null
}

export const checkUrl = (address: string, kind: ProxyKind, applicationId: string) =>
  `http://${address}/_rchat/proxy/auth/${kind}?application=${applicationId}`

export type Setup = {
  applicationId: string
  host: string
  address: string
  upstream: string
  preset: Preset
}

const PAGES = BROWSER_PATHS.join('|')
const variable = (header: string) => `$rchat_${header.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
const upstreamHeader = (header: string) =>
  `$upstream_http_${header.toLowerCase().replaceAll('-', '_')}`

const nginx = (s: Setup) => {
  const set = presetHeaders(s.preset)
  const cleared = ALL_HEADERS.filter(h => !set.includes(h))
  return [
    'server {',
    '  listen 443 ssl default_server;',
    '  ssl_reject_handshake on;',
    '  return 421;',
    '}',
    '',
    'server {',
    '  listen 443 ssl;',
    `  server_name ${s.host};`,
    '  underscores_in_headers off;',
    '  ignore_invalid_headers on;',
    '',
    `  location ~ ^/_rchat/proxy/(${PAGES})$ {`,
    `    proxy_pass http://${s.address};`,
    '    proxy_set_header Host $server_name;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '  }',
    '',
    '  location = /_rchat_check {',
    '    internal;',
    `    proxy_pass ${checkUrl(s.address, 'nginx', s.applicationId)};`,
    '    proxy_pass_request_body off;',
    '    proxy_set_header Content-Length "";',
    '    proxy_set_header X-Original-URL $scheme://$server_name$request_uri;',
    '    proxy_set_header X-Original-Method $request_method;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header Cookie $http_cookie;',
    '  }',
    '',
    '  location / {',
    '    auth_request /_rchat_check;',
    '    error_page 401 = @rchat_sign_in;',
    '    error_page 403 = /_rchat/proxy/denied;',
    ...set.map(h => `    auth_request_set ${variable(h)} ${upstreamHeader(h)};`),
    ...set.map(h => `    proxy_set_header ${h} ${variable(h)};`),
    ...cleared.map(h => `    proxy_set_header ${h} "";`),
    `    proxy_pass http://${s.upstream};`,
    '  }',
    '',
    '  location @rchat_sign_in {',
    `    return 302 /_rchat/proxy/start?application=${s.applicationId}&rd=$scheme://$server_name$request_uri;`,
    '  }',
    '}',
    '',
  ].join('\n')
}

const traefik = (s: Setup) =>
  [
    'http:',
    '  middlewares:',
    '    rchat-strip:',
    '      headers:',
    '        customRequestHeaders:',
    ...traefikKeys().map(key => `          ${key}: ""`),
    '    rchat-auth:',
    '      forwardAuth:',
    `        address: "${checkUrl(s.address, 'traefik', s.applicationId)}"`,
    '        trustForwardHeader: false',
    `        authResponseHeaders: [${presetHeaders(s.preset)
      .map(h => `"${h}"`)
      .join(', ')}]`,
    '  routers:',
    '    protected-rchat:',
    `      rule: "Host(\`${s.host}\`) && PathRegexp(\`^/_rchat/proxy/(${PAGES})$\`)"`,
    '      service: rchat',
    '    protected:',
    `      rule: "Host(\`${s.host}\`)"`,
    '      middlewares: ["rchat-strip", "rchat-auth"]',
    '      service: protected',
    '',
  ].join('\n')

const caddy = (s: Setup) =>
  [
    `${s.host} {`,
    `\t@rchat path ${BROWSER_PATHS.map(p => `/_rchat/proxy/${p}`).join(' ')}`,
    '\thandle @rchat {',
    `\t\treverse_proxy ${s.address} {`,
    '\t\t\theader_up Host {host}',
    '\t\t}',
    '\t}',
    '\thandle {',
    '\t\troute {',
    ...caddyPrefixes().map(prefix => `\t\t\trequest_header -${prefix}*`),
    `\t\t\tforward_auth ${s.address} {`,
    `\t\t\t\turi /_rchat/proxy/auth/caddy?application=${s.applicationId}`,
    '\t\t\t\theader_up Host {upstream_hostport}',
    `\t\t\t\tcopy_headers ${presetHeaders(s.preset).join(' ')}`,
    '\t\t\t}',
    `\t\t\treverse_proxy ${s.upstream}`,
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n')

export const snippet = (kind: ProxyKind, s: Setup) =>
  kind === 'nginx' ? nginx(s) : kind === 'traefik' ? traefik(s) : caddy(s)

export const testLine = (status: number) => {
  const what =
    status === 200
      ? 'allowed'
      : status === 302 || status === 401
        ? 'sign in'
        : status === 403
          ? 'not allowed'
          : 'an error'
  return `A proxy would get: ${what} (${status})`
}

export type RuleEntry = { uid: number }
export type Account = { uid: number; username: string; deleted: boolean }

export const NO_ACCOUNT = 'No account with that name'
const DELETED_ACCOUNT = 'Deleted account'

export const pickAccount = (accounts: readonly Account[], name: string): RuleEntry | string => {
  const a = accounts.find(x => !x.deleted && x.username === name.toLowerCase())
  return a ? { uid: a.uid } : NO_ACCOUNT
}

export const matches = (entries: readonly RuleEntry[], uid: number) =>
  entries.some(e => e.uid === uid)

export const entryLabel = (e: RuleEntry, accounts: readonly Account[]) => {
  const a = accounts.find(x => x.uid === e.uid)
  return !a || a.deleted ? DELETED_ACCOUNT : a.username
}

export const ruleSummary = (entries: readonly RuleEntry[]) =>
  `${entries.length} ${entries.length === 1 ? 'person' : 'people'} listed`

export const pickerEntries = (entries: readonly RuleEntry[], accounts: readonly Account[]) =>
  [...new Set(entries.map(e => e.uid))].slice(0, ACCOUNTS_MAX).map(uid => {
    const label = entryLabel({ uid }, accounts)
    return { uid, label, deleted: label === DELETED_ACCOUNT }
  })
