import { afterEach, describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { InviteBody, RemoteBody } from '../../components/invite_card'
import { ApiError } from '../api'
import { refusalOf } from '../api_errors'
import { InstanceError, type InstanceConnection } from '../instances'
import {
  afterRefusal,
  fetchPreview,
  fetchRemoteInvite,
  refusedInvite,
  type InviteView,
  type RemoteView,
} from '../invite_load'
import { ACCESS_DENIED, PASSWORD_REQUIRED } from '../join_flow'
import type { RemoteInvite } from '../invite'
import type { InviteAccess } from '../remote_invite'
import { resetSessionCaches, useStore } from '../store'
import type { Invite } from '../types'
import { me, memoryStorage, msg } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }
const setBoth = (part: Partial<typeof initial>) => {
  Object.assign(initial, part)
  useStore.setState(part)
}

afterEach(() => {
  Object.assign(initial, saved)
  resetSessionCaches()
  memoryStorage.clear()
})

const invite = (over: Partial<Invite> = {}, server: Partial<Invite['server']> = {}): Invite => ({
  preview_channel_id: null,
  preview_sensitive: false,
  server: {
    name: 'club',
    display_name: 'Book Club',
    has_password: false,
    ...server,
  } as Invite['server'],
  member_count: 12,
  online_count: 3,
  status: 'joinable',
  preview_channel: null,
  preview: [],
  password_expires_at: null,
  password_uses_left: null,
  ...over,
})

const here = (over: Partial<Invite> = {}): InviteView => ({ kind: 'here', invite: invite(over) })

describe('what a refused invite request stands for', () => {
  const wanted = new ApiError(PASSWORD_REQUIRED, 401)
  const wrong = new ApiError(ACCESS_DENIED, 404)

  test('a server that wants its password is hidden, with the line for a wrong one', () => {
    expect(refusedInvite(wanted, false)).toEqual({ kind: 'hidden', denied: null })
    expect(refusedInvite(wrong, false)).toEqual({ kind: 'hidden', denied: ACCESS_DENIED })
  })

  test('an invite code has no password to ask for', () => {
    expect(refusedInvite(wrong, true)).toEqual({ kind: 'gone' })
    expect(refusedInvite(wanted, true).kind).toBe('locked')
  })

  test('a missing invite is gone, and one for accounts only is locked', () => {
    expect(refusedInvite(new ApiError('Not found', 404), false)).toEqual({ kind: 'gone' })
    const locked = refusedInvite(new ApiError('Unauthorized', 401), false)
    expect(locked.kind === 'locked' && locked.refusal.kind).toBe('sign_in')
  })

  test('any other failure stays a failure', () => {
    expect(() => refusedInvite(new ApiError('oops', 500), false)).toThrow('oops')
    expect(() => refusedInvite(new TypeError('Failed to fetch'), true)).toThrow()
  })
})

describe('asking again for an invite that is on screen', () => {
  const shown = here()

  test('a failure that passes keeps the invite', () => {
    expect(afterRefusal(shown, new ApiError('busy', 503), false)).toBe(shown)
    expect(afterRefusal(shown, new ApiError('slow down', 429), false)).toBe(shown)
    expect(afterRefusal(shown, new TypeError('Failed to fetch'), true)).toBe(shown)
  })

  test('an answer about the invite replaces it', () => {
    expect(afterRefusal(shown, new ApiError('Not found', 404), false)).toEqual({ kind: 'gone' })
    expect(afterRefusal(shown, new ApiError(PASSWORD_REQUIRED, 401), false).kind).toBe('hidden')
  })

  test('with no invite on screen the failure shows', () => {
    const error = new ApiError('busy', 503)
    expect(() => afterRefusal(null, error, false)).toThrow('busy')
    expect(() => afterRefusal({ kind: 'gone' }, error, false)).toThrow('busy')
  })
})

const settled = async <T,>(promise: Promise<T>): Promise<T | 'pending'> => {
  const pending = Symbol('pending')
  const first = await Promise.race([promise, Promise.resolve().then(() => pending)])
  if (first !== pending) return first as T
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const next = await Promise.race([promise, Promise.resolve().then(() => pending)])
  return next === pending ? 'pending' : (next as T)
}

describe('an invite on another site', () => {
  const conn = { origin: 'https://far.example', info: { name: 'Far' } } as InstanceConnection
  const access = (read: InviteAccess['read'], current = true): InviteAccess => ({
    current: () => current,
    read,
  })
  const owner = (connect: () => Promise<InstanceConnection>) =>
    ({ invites: { remoteConnection: connect } }) as unknown as Parameters<
      typeof fetchRemoteInvite
    >[0]
  const ask = (a: InviteAccess) => ({
    origin: conn.origin,
    server: 'club',
    password: null,
    access: a,
  })

  test('the site and the invite, once both answer', async () => {
    const said: boolean[] = []
    const view = await fetchRemoteInvite(
      owner(() => Promise.resolve(conn)),
      ask(access(() => Promise.resolve(invite()))),
      false,
      site => said.push(site)
    )
    expect(view.kind).toBe('here')
    expect(said).toEqual([true])
  })

  test('a site that wants a password, and an invite that is gone', async () => {
    const through = (error: unknown) =>
      fetchRemoteInvite(
        owner(() => Promise.resolve(conn)),
        ask(access(() => Promise.reject(error))),
        false,
        () => {}
      )
    expect((await through(new ApiError(PASSWORD_REQUIRED, 401))).kind).toBe('hidden')
    expect((await through(new ApiError(ACCESS_DENIED, 404))).kind).toBe('hidden')
    expect((await through(new ApiError('Not found', 404))).kind).toBe('gone')
    const busy = new ApiError('busy', 503)
    expect(await through(busy).catch((error: unknown) => error)).toBe(busy)
  })

  test('an address that is not one of these sites says so in its own words', async () => {
    const said: boolean[] = []
    const from = (error: unknown) =>
      fetchRemoteInvite(
        owner(() => Promise.reject(error)),
        ask(access(() => Promise.resolve(invite()))),
        false,
        site => said.push(site)
      )
    expect(await from(new InstanceError('far.example is not a public https site'))).toEqual({
      kind: 'foreign',
      line: 'far.example is not a public https site',
    })
    expect(await from(new TypeError('Failed to fetch'))).toEqual({ kind: 'foreign', line: null })
    expect(said).toEqual([false, false])
  })

  test('an answer for an audience that changed never shows', async () => {
    const said: boolean[] = []
    const view = fetchRemoteInvite(
      owner(() => Promise.resolve(conn)),
      ask(access(() => Promise.resolve(invite()), false)),
      false,
      site => said.push(site)
    )
    expect(await settled(view)).toBe('pending')
    expect(said).toEqual([])
  })
})

describe('the messages of a preview channel', () => {
  const conn = (answer: Invite) =>
    ({ api: { getInvite: () => Promise.resolve(answer) } }) as unknown as InstanceConnection

  test('the messages of the channel that was asked for', async () => {
    const preview = [msg(1, { content: 'hello' })]
    const got = await fetchPreview(
      {
        conn: conn(invite({ preview_channel_id: 4, preview_sensitive: false, preview })),
        server: 'club',
        password: null,
        id: 4,
        label: false,
      },
      () => {
        throw new Error('nothing changed')
      }
    )
    expect(got).toBe(preview)
  })

  test('an answer for another channel tells the card and shows nothing', async () => {
    const changes: unknown[] = []
    const got = fetchPreview(
      {
        conn: conn(
          invite({ preview_channel_id: 9, preview_sensitive: true, preview_channel: 'lounge' })
        ),
        server: 'club',
        password: null,
        id: 4,
        label: false,
      },
      to => changes.push(to)
    )
    expect(await settled(got)).toBe('pending')
    expect(changes).toEqual([{ id: 9, label: true, name: 'lounge' }])
  })
})

const router = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
}
const routed = (node: ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>
  )

const card = (view: InviteView, over: { big?: boolean; code?: string | null } = {}) =>
  routed(
    <InviteBody
      view={view}
      named="club"
      password={null}
      given={over.code ?? null}
      code={over.code ?? null}
      big={over.big ?? false}
      autoJoin={false}
      reload={() => {}}
      onUnlocked={() => {}}
    />
  )

describe('the invite card', () => {
  test('a signed-in account can join an invite that is here', () => {
    setBoth({ me: me('reader') })
    const html = card(here())
    expect(html).toContain('You&#x27;ve been invited to join a server')
    expect(html).toContain('Book Club')
    expect(html).toContain('>Join</button>')
  })

  test('a visitor is asked to log in', () => {
    const html = card(here(), { big: true })
    expect(html).toContain('>Log in to join</button>')
    expect(html.includes('>Join</button>')).toBe(false)
  })

  test('a member goes to the server, and a banned account cannot join', () => {
    setBoth({ me: me('reader') })
    expect(card(here({ status: 'member' }))).toContain('>Go to server</button>')
    const banned = card(here({ status: 'banned' }))
    expect(banned).toContain('You are banned from this server')
    expect(/<button[^>]*disabled=""[^>]*>Banned<\/button>/.test(banned)).toBe(true)
  })

  test('a server that wants its password asks for it, with the line for a wrong one', () => {
    setBoth({ me: me('reader') })
    const html = card({ kind: 'hidden', denied: null })
    expect(html).toContain('Enter the password to view this invite')
    expect(html).toContain('>Enter password</button>')
    expect(html.includes('role="alert"')).toBe(false)
  })

  test('an invite whose password ticket ran out is hidden again, or gone for a code', () => {
    setBoth({ me: me('reader') })
    const spent = here({ password_expires_at: 1 })
    expect(card(spent)).toContain('Enter the password to view this invite')
    const code = card(spent, { code: 'abc' })
    expect(code).toContain('Invalid invite')
    expect(code).toContain('You&#x27;ve received an invite, but…')
  })

  test('an invite that is gone says so, with a way on from the page', () => {
    setBoth({ me: me('reader') })
    const embed = card({ kind: 'gone' })
    expect(embed).toContain('Invalid invite')
    expect(embed).toContain('This invite may have expired, or the server no longer exists.')
    expect(embed.includes('<button')).toBe(false)
    expect(card({ kind: 'gone' }, { big: true })).toContain('<button')
  })

  test('an invite for accounts only: a visitor logs in, an account whose session ended is told', () => {
    const locked: InviteView = {
      kind: 'locked',
      refusal: refusalOf(new ApiError('Unauthorized', 401)),
    }
    expect(card(locked, { big: true })).toContain('>Log in to join</button>')
    setBoth({ me: me('reader') })
    const ended = card(locked)
    expect(ended).toContain('Could not load this invite. Your session ended.')
    expect(ended).toContain('data-notice="error"')
  })
})

describe('the card of an invite on another site', () => {
  const remote: RemoteInvite = {
    origin: 'https://far.example',
    server: 'club',
    password: null,
    url: 'https://far.example/invite/club',
  } as RemoteInvite
  const info = { name: 'Far Away' } as InstanceConnection['info']
  const draw = (view: RemoteView) => routed(<RemoteBody view={view} invite={remote} />)

  test('a site that wants a password and an invite that is gone both offer the site', () => {
    const hidden = draw({ kind: 'hidden', info })
    expect(hidden).toContain('Enter the password to view this invite')
    expect(hidden).toContain('Far Away')
    expect(hidden).toContain('Open on ')
    expect(draw({ kind: 'gone', info })).toContain('Invalid invite')
  })

  test('an address that is not one of these sites says why, with its host marked', () => {
    const plain = draw({ kind: 'foreign', line: null })
    expect(plain).toContain('This link is not an RChat invite, or that site could not be reached.')
    const said = draw({ kind: 'foreign', line: 'far.example is not a public https site' })
    expect(
      /<span class="streamer[^"]*">far\.example<\/span> is not a public https site/.test(said)
    ).toBe(true)
  })
})
