import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DELETION_DAYS,
  DELETION_P2P_OFFLINE,
  DELETION_TEXT,
  deletionDaysLeft,
  deletionNotice,
  runDeletion,
  type DeletionSteps,
} from '../account_deletion'
import { client } from '../client/client'
import { useStore } from '../store'
import { me } from './fixtures'
import { writeJson } from '../api/masks'

const DAY = 86_400

describe('the wait', () => {
  test('days left round up and never go below zero', () => {
    expect(deletionDaysLeft(14 * DAY, 0)).toBe(14)
    expect(deletionDaysLeft(14 * DAY, 1)).toBe(14)
    expect(deletionDaysLeft(14 * DAY, DAY)).toBe(13)
    expect(deletionDaysLeft(100, 99)).toBe(1)
    expect(deletionDaysLeft(100, 100)).toBe(0)
    expect(deletionDaysLeft(100, 5000)).toBe(0)
  })

  test('the notice counts days in plain words', () => {
    expect(deletionNotice(14 * DAY, 0)).toBe('This account is deleted in 14 days.')
    expect(deletionNotice(DAY, 10)).toBe('This account is deleted in 1 day.')
    expect(deletionNotice(10, 10)).toBe('This account is being deleted.')
  })

  test('the dialog says that messages are deleted and how to keep the account', () => {
    expect(DELETION_DAYS).toBe(14)
    expect(DELETION_TEXT).toContain('your messages and your direct messages are deleted')
    expect(DELETION_TEXT).toContain('after 14 days')
    expect(DELETION_TEXT).toContain('Sign in again before then to keep the account')
    expect(DELETION_TEXT).not.toContain('—')
  })
})

describe('the steps', () => {
  const steps = (log: string[], over: Partial<DeletionSteps> = {}): DeletionSteps => ({
    prepare: async () => {
      log.push('prepare')
      return {
        retire: async () => {
          log.push('retire')
        },
        release: () => void log.push('release'),
      }
    },
    request: async () => {
      log.push('request')
      return { delete_at: 7 }
    },
    signOut: () => {
      log.push('signOut')
    },
    ...over,
  })

  test('the identities get ready, the instance is asked, they go, then the session ends', async () => {
    const log: string[] = []
    expect(await runDeletion(steps(log), { password: 'pw' }, true)).toBe(7)
    expect(log).toEqual(['prepare', 'request', 'retire', 'signOut', 'release'])
  })

  test('the identities stay unless they are asked to go', async () => {
    const log: string[] = []
    await runDeletion(steps(log), { password: 'pw' }, false)
    expect(log).toEqual(['request', 'signOut'])
  })

  test('a refusal leaves the identities and the session alone', async () => {
    const log: string[] = []
    const refused = steps(log, {
      request: async () => {
        log.push('request')
        throw new Error('Wrong password')
      },
    })
    expect(
      await runDeletion(refused, { password: 'no' }, true).then(
        () => null,
        (e: Error) => e.message
      )
    ).toBe('Wrong password')
    expect(log).toEqual(['prepare', 'request', 'release'])
  })

  test('identities that cannot get ready here stop the deletion before the instance is asked', async () => {
    const log: string[] = []
    const offline = steps(log, {
      prepare: async () => {
        log.push('prepare')
        throw new Error(DELETION_P2P_OFFLINE)
      },
    })
    expect(
      await runDeletion(offline, { password: 'pw' }, true).then(
        () => null,
        (e: Error) => e.message
      )
    ).toBe(DELETION_P2P_OFFLINE)
    expect(log).toEqual(['prepare'])
  })

  test('the session ends even when the identities fail to go', async () => {
    const log: string[] = []
    const failing = steps(log, {
      prepare: async () => ({
        retire: async () => {
          log.push('retire')
          throw new Error('storage')
        },
        release: () => void log.push('release'),
      }),
    })
    expect(await runDeletion(failing, { password: 'pw' }, true)).toBe(7)
    expect(log).toEqual(['request', 'retire', 'signOut', 'release'])
  })
})

describe('the account', () => {
  const st = () => useStore.getState()
  const realFetch = globalThis.fetch
  let calls: { url: string; method: string; body: unknown }[] = []
  let status = 200

  beforeEach(() => {
    calls = []
    status = 200
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (url.endsWith('/me/delete') && method === 'POST')
        return status === 200
          ? new Response(writeJson({ delete_at: 99 }), { status: 200 })
          : new Response(writeJson({ error: "This account can't be deleted on this site" }), {
              status,
            })
      return new Response(writeJson({ ok: true }), { status: 200 })
    }) as typeof fetch
    useStore.setState({
      me: me('alice'),
      token: null,
      guest: false,
      authExpired: false,
      error: null,
      toast: null,
    })
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('a refused deletion keeps the session and passes the answer on', async () => {
    status = 403
    const refused = await st()
      .deleteAccount({ password: 'pw' }, false)
      .then(
        () => null,
        (e: Error) => e.message
      )
    expect(refused).toBe("This account can't be deleted on this site")
    expect(st().me?.username).toBe('alice')
    expect(st().authExpired).toBe(false)
  })

  test('an accepted deletion sends the confirmation and ends the session here', async () => {
    await st().deleteAccount({ password: 'pw' }, false)
    const sent = calls.find(c => c.url.endsWith('/me/delete'))
    expect(sent?.method).toBe('POST')
    expect(sent?.body).toEqual({ reauth: { password: 'pw' } })
    expect(st().me).toBeNull()
    expect(st().authExpired).toBe(true)
    useStore.setState({ authExpired: false })
  })

  test('the session does not end on its own while the deletion runs', async () => {
    const before = globalThis.fetch
    const gate = Promise.withResolvers<void>()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/me/delete')) await gate.promise
      return before(input, init)
    }) as typeof fetch
    const running = st().deleteAccount({ password: 'pw' }, false)
    st().expireSession()
    expect(st().me?.username).toBe('alice')
    gate.resolve()
    await running
    expect(st().me).toBeNull()
    useStore.setState({ authExpired: false })
  })

  const withIdentity = async (
    p2p: { runHere: () => Promise<boolean>; retire: () => Promise<boolean> },
    run: () => Promise<void>
  ) => {
    const { identities } = client.shown()
    const list = identities.list
    const app = { localId: 'main', p2p: { hasData: () => true, ...p2p } }
    identities.list = () => [app] as unknown as ReturnType<typeof list>
    try {
      await run()
    } finally {
      identities.list = list
    }
  }

  test('an identity that cannot connect here stops the deletion before it is sent', async () => {
    await withIdentity({ runHere: async () => false, retire: async () => true }, async () => {
      const stopped = await st()
        .deleteAccount({ password: 'pw' }, true)
        .then(
          () => null,
          (e: Error) => e.message
        )
      expect(stopped).toBe(DELETION_P2P_OFFLINE)
    })
    expect(calls.some(c => c.url.endsWith('/me/delete'))).toBe(false)
    expect(st().me?.username).toBe('alice')
    expect(st().authExpired).toBe(false)
  })

  test('an identity that is ready leaves after the instance accepts, then the session ends', async () => {
    const log: string[] = []
    await withIdentity(
      {
        runHere: async () => {
          log.push('ready')
          return true
        },
        retire: async () => {
          log.push(`retire ${calls.some(c => c.url.endsWith('/me/delete'))}`)
          return true
        },
      },
      () => st().deleteAccount({ password: 'pw' }, true)
    )
    expect(log).toEqual(['ready', 'retire true'])
    expect(st().me).toBeNull()
    expect(st().authExpired).toBe(true)
    useStore.setState({ authExpired: false })
  })

  test('keeping the account clears the date', async () => {
    useStore.setState({ me: { ...me('alice'), delete_at: 99 } })
    await st().keepAccount()
    expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/me/delete'))).toBe(true)
    expect(st().me?.username).toBe('alice')
    expect(st().me?.delete_at).toBeNull()
    expect(st().toast?.text).toBe('Your account is kept')
  })
})
