import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

type Location = { kind: string; path: string; body: string }
type Route = { upstream: string | null; limit: string | null }

// The locations of the edge server block (`listen 80`), in file order.
const locations = (conf: string): Location[] => {
  const start = conf.indexOf('listen 80;')
  const block = conf.slice(start, conf.indexOf('\n    server {', start))
  return [...block.matchAll(/location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{([^}]*)\}/g)].map(m => ({
    kind: m[1] ?? '',
    path: m[2],
    body: m[3],
  }))
}

// nginx's choice: an exact match, else the longest prefix, which wins outright with ^~; else the
// first matching regex in file order; else that longest prefix.
const pick = (locs: Location[], path: string): Location | null => {
  const exact = locs.find(l => l.kind === '=' && l.path === path)
  if (exact) return exact
  const prefix = locs
    .filter(l => (l.kind === '' || l.kind === '^~') && path.startsWith(l.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (prefix?.kind === '^~') return prefix
  const regex = locs.find(
    l =>
      (l.kind === '~' || l.kind === '~*') &&
      new RegExp(l.path, l.kind === '~*' ? 'i' : '').test(path)
  )
  return regex ?? prefix ?? null
}

const route = (loc: Location | null): Route => ({
  upstream: loc?.body.match(/proxy_pass http:\/\/(\w+)/)?.[1] ?? null,
  limit: loc?.body.match(/limit_req zone=(\w+)/)?.[1] ?? null,
})

// One request path each location answers, without the API prefix.
const sample = (loc: Location) => {
  const path = loc.path
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace('(/v1)?', '')
    .replace('.+', 'x')
  const whole = loc.kind === '=' || loc.path.endsWith('$')
  return whole ? path : `${path}${path.endsWith('/') ? 'x' : '/x'}`
}

const API_PATHS = [
  '/ws',
  '/media',
  '/media/abc',
  '/auth/login',
  '/auth/register',
  '/me/password',
  '/me',
  '/servers',
  '/servers/club/guest_access',
  '/servers/club/join',
  '/servers/club/members',
  '/invites/club',
  '/search',
  '/server_search',
  '/webhooks/1/token',
  '/health',
]

describe('deploy routing of both API prefixes', () => {
  const nginx = locations(read('deploy/nginx.conf'))

  test('nginx sends /api/v1/<x> to the same upstream and limit as /api/<x>', () => {
    const tails = new Set(API_PATHS)
    for (const loc of nginx) {
      const tail = sample(loc).match(/^\/api(?:\/v1)?(\/.*)$/)?.[1]
      if (tail) tails.add(tail)
    }
    for (const tail of tails) {
      const latest = route(pick(nginx, `/api${tail}`))
      expect({ tail, route: route(pick(nginx, `/api/v1${tail}`)) }).toEqual({ tail, route: latest })
      expect({ tail, upstream: latest.upstream }).not.toEqual({ tail, upstream: null })
    }
  })

  test('nginx keeps each role and limit', () => {
    const at = (path: string) => route(pick(nginx, path))
    for (const prefix of ['/api', '/api/v1']) {
      expect(at(`${prefix}/ws`)).toEqual({ upstream: 'gateway', limit: null })
      expect(at(`${prefix}/media`)).toEqual({ upstream: 'media', limit: 'strict' })
      expect(at(`${prefix}/media/abc`)).toEqual({ upstream: 'media', limit: null })
      expect(at(`${prefix}/auth/login`)).toEqual({ upstream: 'api', limit: 'strict' })
      expect(at(`${prefix}/me/password`)).toEqual({ upstream: 'api', limit: 'strict' })
      expect(at(`${prefix}/servers/a/guest_access`)).toEqual({ upstream: 'api', limit: 'strict' })
      expect(at(`${prefix}/servers/a/join`)).toEqual({ upstream: 'api', limit: 'joins' })
      expect(at(`${prefix}/invites/a`)).toEqual({ upstream: 'api', limit: 'invites' })
      expect(at(`${prefix}/search`)).toEqual({ upstream: 'search', limit: null })
      expect(at(`${prefix}/server_search`)).toEqual({ upstream: 'search', limit: null })
      expect(at(`${prefix}/me`)).toEqual({ upstream: 'api', limit: null })
    }
    expect(at('/')).toEqual({ upstream: 'web', limit: null })
  })

  test('every Kubernetes ingress path under /api has an /api/v1 twin with the same backend', () => {
    type Path = { path: string; pathType: string; backend: unknown }
    type Ingress = {
      kind: string
      metadata: { name: string }
      spec: { rules: { http: { paths: Path[] } }[] }
    }
    const docs = Bun.YAML.parse(read('deploy/k8s/ingress.yaml')) as Ingress[]
    let twins = 0
    for (const doc of docs.filter(d => d.kind === 'Ingress')) {
      const paths = doc.spec.rules.flatMap(r => r.http.paths)
      for (const p of paths.filter(
        p => p.path.startsWith('/api/') && !p.path.startsWith('/api/v1/')
      )) {
        const twin = paths.find(q => q.path === p.path.replace('/api/', '/api/v1/'))
        expect({
          ingress: doc.metadata.name,
          path: p.path,
          twin: twin && { ...twin, path: p.path },
        }).toEqual({
          ingress: doc.metadata.name,
          path: p.path,
          twin: p,
        })
        twins++
      }
      for (const p of paths.filter(p => p.path.startsWith('/api/v1/')))
        expect(paths.some(q => q.path === p.path.replace('/api/v1/', '/api/'))).toBe(true)
    }
    expect(twins).toBeGreaterThanOrEqual(10)
    const catchAll = docs[0].spec.rules[0].http.paths.find(p => p.path === '/api')
    expect(catchAll?.pathType).toBe('Prefix')
  })
})
