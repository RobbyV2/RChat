import { describe, expect, test } from 'bun:test'
import type { Api } from '../api'
import { apiBaseOf, ask, asked, known, mediaUrlOf, sendTo, together } from '../asks'

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
})
