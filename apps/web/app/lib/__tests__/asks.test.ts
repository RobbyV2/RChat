import { describe, expect, test } from 'bun:test'
import type { Api } from '../api'
import {
  apiBaseOf,
  apiDescription,
  apiOriginOf,
  ask,
  asked,
  blobOf,
  guestMediaOf,
  guestRequest,
  known,
  mediaBlobOf,
  mediaIdOf,
  mediaUrlOf,
  previewUrlOf,
  sendTo,
  sendWritten,
  signedInTo,
  together,
} from '../asks'

const session = (api: Record<string, unknown>) => ({ api: api as unknown as Api })

describe('a named request', () => {
  test('is sent to the session it is handed to, with its arguments', async () => {
    const seen: unknown[][] = []
    const request = ask.listPasswords('club')
    const here = session({
      listPasswords: (...args: unknown[]) => {
        seen.push(args)
        return Promise.resolve({ passwords: [] })
      },
    })
    expect(seen).toEqual([])
    expect(await sendTo(here, request)).toEqual({ passwords: [] } as never)
    expect(seen).toEqual([['club']])
  })

  test('keeps the client as the receiver of the call', async () => {
    const here = session({
      prefix: 'v1',
      me(this: { prefix: string }) {
        return Promise.resolve(this.prefix)
      },
    })
    expect(await sendTo(here, ask.me())).toBe('v1' as never)
  })

  test('can change its answer, and say what a refusal stands for', async () => {
    const here = session({
      friendship: (name: string) =>
        name === 'gone'
          ? Promise.reject(new Error('missing'))
          : Promise.resolve({ status: 'friends' }),
    })
    const status = (name: string) =>
      asked(
        ask.friendship(name),
        r => r.status as string,
        () => 'none'
      )
    expect(await sendTo(here, status('ann'))).toBe('friends')
    expect(await sendTo(here, status('gone'))).toBe('none')
    expect(await sendTo(here, together([status('ann'), status('gone')]))).toEqual([
      'friends',
      'none',
    ])
  })

  test('an answer that is known is not asked for', async () => {
    expect(await sendTo(session({}), known(7))).toBe(7)
  })

  test('the addresses of a session come from its client', () => {
    const here = session({ base: '/api/v1', mediaUrl: (id: string) => `/api/v1/media/${id}` })
    expect(apiBaseOf(here)).toBe('/api/v1')
    expect(mediaUrlOf(here, 'm1')).toBe('/api/v1/media/m1')
  })

  test('media addresses, sign-in state and bytes come from its client', async () => {
    const asked: unknown[][] = []
    const here = session({
      origin: (page?: string) => `origin of ${page}`,
      previewUrl: (path: string) => `/api/v1${path}`,
      mediaId: (url: string) => (url.endsWith('/m1') ? 'm1' : null),
      signedIn: () => true,
      guestMedia: (server?: string) => server === 'den',
      authedBlob: async (...args: unknown[]) => (asked.push(['blob', ...args]), 'bytes'),
      mediaBlob: async (...args: unknown[]) => (asked.push(['media', ...args]), 'upload'),
    })
    expect(apiOriginOf(here, 'https://a.test/x')).toBe('origin of https://a.test/x')
    expect(previewUrlOf(here, '/messages/1/embeds/0/image?v=a')).toBe(
      '/api/v1/messages/1/embeds/0/image?v=a'
    )
    expect(mediaIdOf(here, 'https://a.test/api/v1/media/m1')).toBe('m1')
    expect(mediaIdOf(here, 'https://b.test/picture')).toBeNull()
    expect(signedInTo(here)).toBe(true)
    expect(guestMediaOf(here, 'den')).toBe(true)
    const stop = new AbortController().signal
    expect<unknown>(await blobOf(here, '/api/v1/media/m1', 'den', stop)).toBe('bytes')
    expect<unknown>(await mediaBlobOf(here, 'm1', undefined, stop)).toBe('upload')
    expect(asked).toEqual([
      ['blob', '/api/v1/media/m1', 'den', stop],
      ['media', 'm1', undefined, stop],
    ])
  })

  test('a guest request carries the headers it is given', async () => {
    const sent: unknown[][] = []
    const here = session({ req: async (...args: unknown[]) => (sent.push(args), 7) })
    expect(
      await guestRequest<number>(here, 'GET', '/channels/3/guest-messages', undefined, {
        'X-Guest-Session': 's',
      })
    ).toBe(7)
    expect(sent).toEqual([
      ['GET', '/channels/3/guest-messages', undefined, { 'X-Guest-Session': 's' }],
    ])
  })

  test('the console asks for the API description and sends a written request once', async () => {
    const sent: unknown[][] = []
    const here = session({
      req: async (...args: unknown[]) => (sent.push(['req', ...args]), { openapi: '3.1.0' }),
      send: async (...args: unknown[]) => (sent.push(['send', ...args]), new Response('ok')),
    })
    expect(await apiDescription(here)).toEqual({ openapi: '3.1.0' })
    const answer = await sendWritten(here, {
      method: 'POST',
      path: '/servers',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(await answer.text()).toBe('ok')
    expect(sent).toEqual([
      ['req', 'GET', '/openapi.json'],
      [
        'send',
        'POST',
        '/servers',
        '{}',
        { headers: { 'Content-Type': 'application/json' }, retry: false },
      ],
    ])
  })
})
