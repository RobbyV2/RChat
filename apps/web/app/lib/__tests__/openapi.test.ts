import { describe, expect, test } from 'bun:test'
import {
  EMPTY_HISTORY,
  HISTORY_MAX,
  REDACTED,
  buildRequest,
  emptyValues,
  fillPath,
  hideSecrets,
  historyValue,
  needsConfirm,
  parseHistory,
  parseOpenApi,
  planSend,
  prettyBody,
  pushHistory,
  requestPath,
  requestUrl,
  restoreValues,
  toCurl,
  validate,
  type Field,
  type Operation,
  type Values,
} from '../openapi'

const doc = {
  openapi: '3.1.0',
  paths: {
    '/api/servers/{name}/channels': {
      post: {
        operationId: 'create_channel',
        summary: 'Create a channel',
        tags: ['Channels'],
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
        },
      },
    },
    '/api/search': {
      get: {
        operationId: 'search',
        summary: 'Search',
        parameters: [
          { name: 'q', in: 'query', schema: { type: ['string', 'null'] } },
          { name: 'servers', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          {
            name: 'kind',
            in: 'query',
            schema: { oneOf: [{ $ref: '#/components/schemas/Kind' }, { type: 'null' }] },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
      },
    },
    '/api/messages/{id}': {
      delete: {
        operationId: 'delete_message',
        summary: 'Delete a message',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      },
    },
    '/api/media': {
      post: {
        operationId: 'upload',
        summary: 'Upload',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'string' } } } },
      },
    },
    '/api/servers/{name}/kick': {
      post: { operationId: 'kick', summary: 'Kick', parameters: [] },
    },
    '/.well-known/rchat': { get: { operationId: 'well_known', summary: 'Instance' } },
  },
  components: {
    schemas: {
      Kind: { type: 'string', enum: ['text', 'voice'] },
      Create: {
        allOf: [
          {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 5, description: 'Name' },
              kind: {
                oneOf: [
                  { $ref: '#/components/schemas/Kind', description: 'Kind here' },
                  { type: 'null' },
                ],
              },
            },
          },
          {
            type: 'object',
            properties: {
              poll: { $ref: '#/components/schemas/Poll' },
              tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
              raw: {},
              self: { $ref: '#/components/schemas/Loop' },
            },
          },
        ],
      },
      Poll: {
        type: 'object',
        required: ['question'],
        properties: {
          question: { type: 'string' },
          scale: { type: ['integer', 'null'], minimum: 5, maximum: 10 },
          anonymous: { type: 'boolean' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        },
      },
      Loop: { type: 'object', properties: { next: { $ref: '#/components/schemas/Loop' } } },
    },
  },
}

const ops = parseOpenApi(doc)
const op = (id: string) => ops.find(o => o.id === id) as Operation
const field = (f: Field | null | undefined, name: string) =>
  f?.fields?.find(x => x.name === name) as Field

describe('reading the document', () => {
  test('only /api/ operations, with their methods; everything but GET asks first', () => {
    expect(ops.map(o => `${o.method} ${o.path}`).sort()).toEqual([
      'DELETE /api/messages/{id}',
      'GET /api/search',
      'POST /api/media',
      'POST /api/servers/{name}/channels',
      'POST /api/servers/{name}/kick',
    ])
    for (const o of ops) expect(o.confirm).toBe(o.method !== 'GET')
    expect(op('upload').multipart).toBe(true)
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(needsConfirm(m)).toBe(true)
    expect(needsConfirm('GET')).toBe(false)
  })

  test('templates that could leave /api/ are not offered', () => {
    const bad = parseOpenApi({
      paths: Object.fromEntries(
        ['/api/../admin', '/api/%2e%2e/x', '/api/\\evil.com', '/api//x', '/api/ok'].map(p => [
          p,
          { get: { operationId: p } },
        ])
      ),
    })
    expect(bad.map(o => o.path)).toEqual(['/api/ok'])
  })

  test('parameters: types, enums behind refs, nullable, arrays and limits; no Authorization', () => {
    const c = op('create_channel')
    expect(c.params.map(p => p.name)).toEqual(['name'])
    const s = op('search')
    const [q, servers, kind, limit] = s.params
    expect([q.kind, q.nullable, q.in]).toEqual(['string', true, 'query'])
    expect([servers.kind, servers.items?.kind]).toEqual(['array', 'string'])
    expect([kind.kind, kind.options, kind.nullable]).toEqual(['enum', ['text', 'voice'], true])
    expect([limit.kind, limit.minimum, limit.maximum]).toEqual(['integer', 1, 50])
  })

  test('bodies: allOf merged, nested objects and arrays, unknown shapes as JSON, loops cut', () => {
    const body = op('create_channel').body
    expect(body?.kind).toBe('object')
    expect(body?.required).toBe(true)
    expect(body?.fields?.map(f => f.name)).toEqual(['name', 'kind', 'poll', 'tags', 'raw', 'self'])
    const name = field(body, 'name')
    expect([name.required, name.minLength, name.maxLength, name.description]).toEqual([
      true,
      1,
      5,
      'Name',
    ])
    const kind = field(body, 'kind')
    expect([kind.kind, kind.nullable, kind.description]).toEqual(['enum', true, 'Kind here'])
    const poll = field(body, 'poll')
    expect(poll.kind).toBe('object')
    const scale = field(poll, 'scale')
    expect([scale.kind, scale.nullable, scale.minimum]).toEqual(['integer', true, 5])
    const text = field(poll, 'options').items?.fields?.[0]
    expect([text?.name, text?.required]).toEqual(['text', true])
    expect(field(body, 'raw').kind).toBe('json')
    let loop: Field | undefined = field(body, 'self')
    let depth = 0
    while (loop?.kind === 'object') {
      loop = field(loop, 'next')
      depth += 1
    }
    expect(depth < 10).toBe(true)
  })
})

describe('validation and requests', () => {
  const values = (o: Operation, over: (v: Values) => void) => {
    const v = structuredClone(emptyValues(o))
    over(v)
    return v
  }

  test('required, lengths, numbers, enums, JSON and array limits', () => {
    const c = op('create_channel')
    const empty = buildRequest(c, emptyValues(c), false)
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.errors['param.name']).toBe('Required')
      expect(empty.errors['body.name']).toBe('Required')
      expect(empty.errors['body.poll.question']).toBeUndefined()
    }
    const bad = buildRequest(
      c,
      values(c, v => {
        v.params.name = 'space'
        v.body = {
          ...(v.body as object),
          name: 'toolong',
          kind: 'video',
          tags: ['a', 'b', 'c'],
          raw: '{nope',
          poll: { question: '', scale: '3', anonymous: 'maybe', options: [{ text: '' }] },
        }
      }),
      false
    )
    expect(bad.ok).toBe(false)
    if (!bad.ok)
      expect(
        Object.fromEntries(Object.entries(bad.errors).filter(([k]) => k.startsWith('body.')))
      ).toEqual({
        'body.name': 'At most 5 characters',
        'body.kind': 'Pick one of the options',
        'body.tags': 'At most 2 items',
        'body.raw': 'Not valid JSON',
        'body.poll.question': 'Required',
        'body.poll.scale': 'At least 5',
        'body.poll.anonymous': 'Pick true or false',
        'body.poll.options.0.text': 'Required',
      })
    const integer = op('search').params[3]
    expect(validate(integer, '1.5')).toEqual({ limit: 'Use a whole number' })
    expect(validate(integer, '51')).toEqual({ limit: 'At most 50' })
    expect(validate(integer, '')).toEqual({})
  })

  test('a valid form builds typed JSON, leaves unset fields out and sanitizes text', () => {
    const c = op('create_channel')
    const r = buildRequest(
      c,
      values(c, v => {
        v.params.name = 'my server/..'
        v.body = {
          ...(v.body as object),
          name: 'ab\u0000c',
          kind: null,
          raw: '{"x":[1]}',
          poll: { question: 'Q?', scale: '7', anonymous: 'false', options: [{ text: 'yes' }] },
        }
      }),
      false
    )
    expect(r.ok).toBe(false)
    const ok = buildRequest(
      c,
      values(c, v => {
        v.params.name = 'my server'
        v.body = {
          ...(v.body as object),
          name: 'ab\u0000c',
          kind: null,
          raw: '{"x":[1]}',
          poll: { question: 'Q?', scale: '7', anonymous: 'false', options: [{ text: 'yes' }] },
        }
      }),
      false
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.request.path).toBe('/api/servers/my%20server/channels')
      expect(ok.request.body).toEqual({
        name: 'abc',
        kind: null,
        raw: { x: [1] },
        poll: { question: 'Q?', scale: 7, anonymous: false, options: [{ text: 'yes' }] },
      })
    }
  })

  test('query arrays repeat, path dots are refused, guests only GET, uploads refused', () => {
    const s = op('search')
    const r = buildRequest(
      s,
      values(s, v => {
        v.params.q = 'hi there'
        v.params.servers = ['a', 'b']
        v.params.limit = '5'
      }),
      true
    )
    expect(r.ok && r.request.query).toBe('q=hi+there&servers=a&servers=b&limit=5')
    const d = op('delete_message')
    const guest = buildRequest(
      d,
      values(d, v => void (v.params.id = '4')),
      true
    )
    expect(!guest.ok && guest.errors._).toBe('Guests can only send GET requests.')
    const dots = buildRequest(
      op('create_channel'),
      values(op('create_channel'), v => {
        v.params.name = '..'
        v.body = { ...(v.body as object), name: 'x' }
      }),
      false
    )
    expect(!dots.ok && dots.errors['param.name']).toBe('Not a valid value')
    const up = buildRequest(op('upload'), emptyValues(op('upload')), false)
    expect(!up.ok && up.errors._).toBe('File uploads are not supported here.')
  })

  test('every request but GET asks before sending', () => {
    const c = op('create_channel')
    expect(
      planSend(
        c,
        values(c, v => {
          v.params.name = 'space'
          v.body = { ...(v.body as object), name: 'x' }
        }),
        false
      ).kind
    ).toBe('confirm')
    const d = op('delete_message')
    expect(planSend(d, emptyValues(d), false).kind).toBe('errors')
    expect(
      planSend(
        d,
        values(d, v => void (v.params.id = '9')),
        false
      ).kind
    ).toBe('confirm')
    const k = op('kick')
    expect(planSend(k, emptyValues(k), false).kind).toBe('confirm')
    const s = op('search')
    expect(planSend(s, emptyValues(s), false).kind).toBe('send')
  })

  test('documented paths of either prefix go under the base this client calls', () => {
    expect(requestUrl('/api/v1', { path: '/api/v1/me', query: 'a=1' })).toBe('/api/v1/me?a=1')
    expect(requestUrl('/api/v1', { path: '/api/me', query: '' })).toBe('/api/v1/me')
    expect(requestUrl('https://old.example/api', { path: '/api/me', query: '' })).toBe(
      'https://old.example/api/me'
    )
    expect(requestPath({ path: '/api/v1/servers/a%20b', query: 'x=1' })).toBe('/servers/a%20b?x=1')
    expect(requestPath({ path: '/api/v1//evil.example/x', query: '' })).toBeNull()
    expect(requestUrl('/api/v1', { path: '/api/v1/../admin', query: '' })).toBeNull()
  })

  test('only API paths of this instance get a URL', () => {
    expect(requestUrl('/api', { path: '/api/me', query: 'a=1' })).toBe('/api/me?a=1')
    expect(requestUrl('https://h.example/api/', { path: '/api/me', query: '' })).toBe(
      'https://h.example/api/me'
    )
    expect(requestUrl('/api', { path: '/.well-known/rchat', query: '' })).toBeNull()
    expect(requestUrl('/api', { path: '/api//evil.example/x', query: '' })).toBeNull()
    for (const path of ['/api/../admin', '/api/%2e%2e/x', '/api/%2E%2e/x', '/api/\\evil.com'])
      expect(requestUrl('/api', { path, query: '' })).toBeNull()
    expect(requestUrl('/api', { path: '/api/servers/a%252e', query: '' })).toBe(
      '/api/servers/a%252e'
    )
  })

  test('curl and shown paths leave secrets out unless asked', () => {
    const hook = parseOpenApi({
      paths: {
        '/api/webhooks/{id}/{token}': {
          post: {
            operationId: 'run_hook',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'api_key', in: 'query', schema: { type: 'string' } },
              { name: 'q', in: 'query', schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                      auth: {
                        type: 'object',
                        properties: { password: { type: 'string' }, code: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })[0]
    const v: Values = {
      params: { id: '7', token: 's3cr3t', api_key: 'k3y', q: 'plain' },
      body: { content: 'hello', auth: { password: 'hunter2', code: '123456' } },
    }
    const built = buildRequest(hook, v, false)
    if (!built.ok) throw new Error('not built')
    expect(built.request.path).toBe('/api/webhooks/7/s3cr3t')
    expect(fillPath(hook, v)).toBe('/api/webhooks/7/{token}')
    const hidden = hideSecrets(hook, v, built.request)
    const url = requestUrl('https://h/api', hidden)
    expect(url).toBe('https://h/api/webhooks/7/{token}?api_key=%5Bredacted%5D&q=plain')
    const curl = toCurl(url!, hidden, null)
    for (const secret of ['s3cr3t', 'k3y', 'hunter2', '123456'])
      expect(curl.includes(secret)).toBe(false)
    expect(curl).toContain('hello')
    const full = toCurl(requestUrl('https://h/api', built.request)!, built.request, 'tok')
    for (const secret of ['s3cr3t', 'k3y', 'hunter2', '123456', 'tok'])
      expect(full).toContain(secret)
  })

  test('curl hides the token unless asked', () => {
    const d = op('delete_message')
    const r = buildRequest(
      d,
      values(d, v => void (v.params.id = '9')),
      false
    )
    if (!r.ok) throw new Error('not built')
    const hidden = toCurl('https://h/api/messages/9', r.request, null)
    expect(hidden).toContain('Bearer $RCHAT_TOKEN')
    expect(hidden).toContain("curl -X DELETE 'https://h/api/messages/9'")
    const shown = toCurl('https://h/api/messages/9', { ...r.request, body: { a: "it's" } }, 'tok')
    expect(shown).toContain("'Authorization: Bearer tok'")
    expect(shown).toContain(`--data-raw '{"a":"it'\\''s"}'`)
  })
})

describe('history', () => {
  const entry = (n: number) => ({
    op: 'create_channel',
    method: 'POST' as const,
    path: '/api/webhooks/{id}/{token}',
    status: 200,
    at: n,
    values: {
      params: { token: 'abc', id: '1' },
      body: { password: 'hunter2', nested: { secret: 's', name: 'ok' }, words: ['a'] },
    },
  })

  test('secret path values never reach the stored history; old filled paths are dropped', () => {
    const h = pushHistory(EMPTY_HISTORY, {
      op: 'run_hook',
      method: 'POST',
      path: '/api/webhooks/{id}/{token}',
      status: 204,
      at: 1,
      values: { params: { id: '7', token: 's3cr3t' }, body: '' },
    })
    const raw = historyValue(h)
    expect(raw.includes('s3cr3t')).toBe(false)
    expect(parseHistory(raw).items[0].path).toBe('/api/webhooks/{id}/{token}')
    const legacy = JSON.stringify({
      v: 1,
      items: [
        {
          op: 'run_hook',
          method: 'POST',
          path: '/api/webhooks/7/s3cr3t',
          status: 204,
          at: 1,
          values: { params: { id: '7', token: '[redacted]' }, body: '' },
        },
      ],
    })
    const cleaned = parseHistory(legacy)
    expect(cleaned.items).toHaveLength(1)
    expect(historyValue(cleaned).includes('s3cr3t')).toBe(false)
  })

  test('secrets are redacted, the list is capped and bad data is dropped', () => {
    let h = EMPTY_HISTORY
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = pushHistory(h, entry(i))
    expect(h.items).toHaveLength(HISTORY_MAX)
    const raw = historyValue(h)
    expect(raw.includes('hunter2') || raw.includes('abc') || raw.includes('"s"')).toBe(false)
    expect(h.items[0].values.params.token).toBe(REDACTED)
    expect(h.items[0].values.body).toEqual({
      password: REDACTED,
      nested: { secret: REDACTED, name: 'ok' },
      words: REDACTED,
    })
    expect(parseHistory(raw)).toEqual(h)
    for (const bad of [null, '', '{', '[]', '{"v":3,"items":[]}'])
      expect(parseHistory(bad)).toEqual(EMPTY_HISTORY)
    const mixed = JSON.stringify({
      v: 1,
      items: [
        { op: 'x', method: 'GET', path: 'https://evil/api', values: { params: {}, body: '' } },
        4,
      ],
    })
    expect(parseHistory(mixed).items).toEqual([])
  })

  test('saved values go back into the form; redacted secrets come back empty', () => {
    const c = op('create_channel')
    const saved = pushHistory(EMPTY_HISTORY, {
      ...entry(1),
      values: { params: { name: 'space' }, body: { name: 'x', poll: { question: 'Q' } } },
    }).items[0]
    const back = restoreValues(c, saved.values)
    expect(back.params.name).toBe('space')
    expect((back.body as Record<string, unknown>).name).toBe('x')
    expect(((back.body as Record<string, unknown>).poll as Record<string, unknown>).question).toBe(
      'Q'
    )
    const restored = restoreValues(c, { params: { name: REDACTED }, body: '' })
    expect(restored.params.name).toBe('')
  })
})

describe('responses', () => {
  test('JSON is pretty printed and long bodies are cut', () => {
    expect(prettyBody('{"a":1}', 'application/json')).toEqual({
      text: '{\n  "a": 1\n}',
      json: true,
      cut: false,
    })
    expect(prettyBody('plain', 'text/plain')).toEqual({ text: 'plain', json: false, cut: false })
    const long = prettyBody('x'.repeat(100), 'text/plain', 10)
    expect([long.text.length, long.cut]).toEqual([10, true])
  })
})
