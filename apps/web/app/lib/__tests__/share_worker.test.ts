import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8')
const origin = 'https://rchat.test'
const endpoint = origin + '/share-target/'
const MiB = 1024 * 1024

function worker() {
  const handlers = new Map()
  let now = 100
  runInNewContext(source, {
    self: {
      location: new URL(origin),
      addEventListener: (kind: string, handle: unknown) => handlers.set(kind, handle),
    },
    URL,
    Response,
    TextEncoder,
    TransformStream,
    crypto,
    Date: { now: () => now },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  async function post(request: Request) {
    let response!: Promise<Response>
    let lifetime!: Promise<void>
    handlers.get('fetch')({
      request,
      respondWith: (r: Promise<Response>) => {
        response = r
      },
      waitUntil: (wait: Promise<void>) => {
        lifetime = wait
      },
    })
    const res = await response
    const location = res.headers.get('Location')
    return {
      res,
      lifetime,
      ticket: location && new URL(location).searchParams.get('receive-share'),
    }
  }
  function claim(ticket: string | null, url = origin) {
    let payload: { text: string; files: File[] } | null = null
    handlers.get('message')({
      data: { kind: 'receive-share', ticket },
      source: { url },
      ports: [
        {
          postMessage: (value: typeof payload) => {
            payload = value
          },
        },
      ],
    })
    return payload as { text: string; files: File[] } | null
  }
  return {
    post,
    claim,
    expire: () => {
      now += 120000
    },
  }
}

function form(text: string, ...sizes: number[]) {
  const data = new FormData()
  data.set('text', text)
  for (const size of sizes) data.append('files', new Blob([new Uint8Array(size)]), 'sample.txt')
  return new Request(endpoint, { method: 'POST', body: data })
}

test('actual bytes bound the parser even without an accurate length header', async () => {
  for (const declared of [undefined, '8']) {
    const block = new Uint8Array(64 * 1024)
    let pulls = 0,
      cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        if (++pulls > 160) controller.close()
        else controller.enqueue(block)
      },
      cancel() {
        cancelled = true
      },
    })
    const headers = new Headers({ 'Content-Type': 'multipart/form-data; boundary=sample' })
    if (declared) headers.set('Content-Length', declared)
    const { res, lifetime } = await worker().post(
      new Request(endpoint, { method: 'POST', headers, body, duplex: 'half' } as RequestInit)
    )
    expect(res.status).toBe(413)
    expect(await res.text()).toContain('8 MiB')
    await lifetime
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(160)
  }
})

test('admission rejects a large declared length and bounds simultaneous parsers', async () => {
  const { post, claim } = worker()
  const oversized = form('small')
  oversized.headers.set('Content-Length', String(9 * MiB))
  expect((await post(oversized)).res.status).toBe(413)
  const gate = Promise.withResolvers<void>()
  function slowPost(text: string) {
    const original = form(text)
    const body = original.body!.pipeThrough(
      new TransformStream({
        async transform(chunk, controller) {
          await gate.promise
          controller.enqueue(chunk)
        },
      })
    )
    return post(
      new Request(endpoint, {
        method: 'POST',
        headers: original.headers,
        body,
        duplex: 'half',
      } as RequestInit)
    )
  }
  const first = slowPost('first'),
    second = slowPost('second')
  expect((await post(form('third'))).res.status).toBe(429)
  gate.resolve()
  expect(claim((await first).ticket)?.text).toBe('first')
  expect(claim((await second).ticket)?.text).toBe('second')
  expect((await post(form('third'))).res.status).toBe(303)
})

test('file count, combined file bytes and UTF-8 text have independent limits', async () => {
  const { post, claim } = worker()
  for (const request of [
    form('', ...Array(9).fill(1)),
    form('', 8 * MiB, 1),
    form('é'.repeat(32769)),
  ]) {
    expect((await post(request)).res.status).toBe(413)
  }
  const combined = new FormData()
  combined.set('text', 'A'.repeat(65536))
  combined.set('url', 'B')
  expect((await post(new Request(endpoint, { method: 'POST', body: combined }))).res.status).toBe(
    413
  )
  expect((await post(form(''))).res.status).toBe(400)
  const { ticket } = await post(form('é'.repeat(32768), 8 * MiB, ...Array(7).fill(0)))
  expect(claim(ticket)?.files.map(f => f.size)).toEqual([8 * MiB, ...Array(7).fill(0)])
})

test('separate launches consume once, with expiry, ticket count and aggregate capacity', async () => {
  const { post, claim, expire } = worker()
  const a = await post(form('first', 8 * MiB))
  const b = await post(form('second', 8 * MiB))
  expect(a.ticket).not.toBe(b.ticket)
  expect((await post(form('', MiB))).res.status).toBe(429)
  expect(claim(b.ticket, 'https://elsewhere.test')).toBeNull()
  expect(claim(b.ticket)?.text).toBe('second')
  expect(claim(b.ticket)).toBeNull()
  await b.lifetime
  const c = await post(form('third', MiB))
  expect(c.res.status).toBe(303)
  for (let i = 0; i < 6; i++) expect((await post(form('small'))).res.status).toBe(303)
  expect((await post(form('next'))).res.status).toBe(429)
  expire()
  expect(claim(a.ticket)).toBeNull()
  await Promise.all([a.lifetime, c.lifetime])
  expect((await post(form('next'))).res.status).toBe(303)
})
