import { expect, test } from 'bun:test'
import { WidgetConnection } from '../widget_connection'
import { me, msg } from './fixtures'
import type { WidgetRoomMetadata } from '../widgets'

const memoryStorage = () => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

async function withWidget(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  run: (
    client: WidgetConnection,
    sockets: string[],
    closed: string[],
    ready: () => void,
    deliver: (event: object) => void
  ) => Promise<void>,
  canView: (room: WidgetRoomMetadata) => boolean = () => true,
  id = 'a'.repeat(32),
  storage = memoryStorage()
) {
  const sockets: string[] = []
  const closed: string[] = []
  let ready: () => void = () => {
    throw Error('Missing widget socket')
  }
  let deliver: (event: object) => void = () => {
    throw Error('Missing widget socket')
  }
  const originals = new Map(
    ['fetch', 'WebSocket', 'location', 'window', 'localStorage'].map(
      key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
  )
  const localWindow = { location: new URL('https://instance.example/widget/') }
  Object.assign(localWindow, { parent: localWindow })
  const replace = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let client: WidgetConnection | undefined
  try {
    replace('window', localWindow)
    replace('location', localWindow.location)
    replace(
      'WebSocket',
      class {
        onmessage?: (event: { data: string }) => void
        constructor(readonly url: string) {
          sockets.push(url)
          ready = () =>
            this.onmessage?.({ data: JSON.stringify({ type: 'widget_ready', name: 'guest' }) })
          deliver = event => this.onmessage?.({ data: JSON.stringify(event) })
        }
        close() {
          closed.push(this.url)
        }
      }
    )
    replace('fetch', fetch)
    replace('localStorage', storage)
    client = new WidgetConnection(id, () => {}, canView)
    await run(
      client,
      sockets,
      closed,
      () => ready(),
      event => deliver(event)
    )
  } finally {
    client?.destroy()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('local viewing permission precedes room content and can close an open subscription', async () => {
  const metadata: WidgetRoomMetadata = { server: 'music', channel_id: 15, kind: 'voice' }
  const allowedMetadata: WidgetRoomMetadata[] = []
  const paths: string[] = []
  let allow = false
  await withWidget(
    async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.split('/').at(-1)!
      paths.push(path)
      if (path === 'session') {
        expect(JSON.parse(String(init.body))).toEqual({
          parent: 'https://instance.example',
          read_key: null,
        })
        return Response.json({ mode: 'voice', ticket: 'ticket' })
      }
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      if (path === 'room') return Response.json(metadata)
      if (path === 'view')
        return Response.json({
          ...metadata,
          name: 'Lounge',
          participate: true,
          users: ['member'],
          messages: [],
        })
      throw Error('Unexpected request')
    },
    async (client, sockets, closed) => {
      await client.start()
      expect(client.metadata).toEqual(metadata)
      expect(client.room).toBeNull()
      await client.join()
      expect(paths).toEqual(['session', 'room'])
      expect(sockets).toHaveLength(0)
      allow = true
      await client.refresh()
      expect(client.room?.users).toEqual(['member'])
      expect(paths).toEqual(['session', 'room', 'room', 'view'])
      expect(sockets).toHaveLength(1)
      allow = false
      const suspended = client.refresh()
      expect(client.room).toBeNull()
      expect(closed).toEqual(sockets)
      await suspended
      expect(paths.at(-1)).toBe('room')
      expect(paths.filter(path => path === 'view')).toHaveLength(1)
      expect(allowedMetadata.every(room => JSON.stringify(room) === JSON.stringify(metadata))).toBe(
        true
      )
    },
    room => {
      allowedMetadata.push(room)
      return allow
    }
  )
})

test('a changed shared label returns the frame to discovery before the room opens', async () => {
  let marked = false
  let accepted = false
  const revisions: (string | null)[] = []
  const room = { server: 'music', channel_id: 15, kind: 'voice' } as const
  await withWidget(
    async (url, init) => {
      const path = new URL(url).pathname.split('/').at(-1)
      if (path === 'session') return Response.json({ mode: 'voice', ticket: 'ticket' })
      if (path === 'room') return Response.json({ ...room, sensitive: marked })
      if (path === 'view') {
        revisions.push(new Headers(init.headers).get('X-Widget-Room-Revision'))
        if (!marked) {
          marked = true
          return Response.json({ error: 'Room information changed' }, { status: 412 })
        }
        return Response.json({
          ...room,
          sensitive: true,
          name: 'Lounge',
          participate: true,
          messages: [],
          users: ['member'],
        })
      }
      throw Error('Unexpected request')
    },
    async (client, sockets) => {
      await client.start()
      expect(client.metadata?.sensitive).toBe(true)
      expect(client.room).toBeNull()
      expect(sockets).toHaveLength(0)
      expect(revisions).toEqual(['15.0'])
      accepted = true
      await client.refresh()
      expect(client.room?.users).toEqual(['member'])
      expect(revisions).toEqual(['15.0', '15.1'])
      expect(sockets).toHaveLength(1)
    },
    metadata => !metadata.sensitive || accepted
  )
})

test('an embedded guest renews an expired credential in the same widget session', async () => {
  const room = {
    server: 'orchard',
    channel_id: 21,
    kind: 'text',
    name: 'Garden',
    participate: true,
    messages: [],
    users: [],
  }
  const attempts: (string | null)[] = []
  const saved: string[] = []
  await withWidget(
    async (url, init) => {
      const path = new URL(url).pathname.split('/').at(-1)
      if (path === 'session') return Response.json({ mode: 'public_chat', ticket: 'garden-ticket' })
      if (path === 'room' || path === 'view') return Response.json(room)
      expect(path).toBe('messages')
      const headers = new Headers(init.headers)
      expect(headers.get('x-widget-session')).toBe('garden-ticket')
      expect(headers.get('x-widget-parent')).toBe('https://instance.example')
      const session = headers.get('x-guest-session')
      attempts.push(session)
      if (session === 'older')
        return Response.json({ error: 'Guest session expired' }, { status: 401 })
      const { content } = JSON.parse(String(init.body))
      saved.push(content)
      return Response.json({
        session: saved.length === 1 ? 'older' : 'renewed',
        message: { content },
      })
    },
    async client => {
      await client.start()
      for (const text of ['In spring', 'After summer', 'In autumn']) await client.send(text)
      expect(attempts).toEqual([null, 'older', null, 'renewed'])
      expect(saved).toEqual(['In spring', 'After summer', 'In autumn'])
    }
  )
})

test('account sign-in and password grants belong to the individual widget', async () => {
  const storage = memoryStorage()
  storage.setItem('rchat_token', 'app-account')
  storage.setItem('rchat_widget_token', 'other-account')
  storage.setItem('rchat_guest_grants', JSON.stringify({ music: 'app-grant' }))
  const requests: Headers[] = []
  const tickets: Headers[] = []
  const modes: (RequestCredentials | undefined)[] = []
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.split('/').at(-1)
    modes.push(init.credentials)
    if (path === 'session') {
      tickets.push(new Headers(init.headers))
      return Response.json({ mode: 'voice', ticket: 'ticket' })
    }
    if (path === 'login') return Response.json({ token: 'framed-account', user: me('member') })
    if (path === 'me') {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer framed-account')
      return Response.json(me('member'))
    }
    if (path === 'guest-access') return Response.json({ grant: 'framed-grant' })
    if (path === 'room') requests.push(new Headers(init.headers))
    return Response.json({
      server: 'music',
      channel_id: 15,
      kind: 'voice',
      messages: [],
      users: [],
    })
  }
  const identity = (token: string | null, grant: string | null) => {
    expect(requests.at(-1)?.get('authorization')).toBe(token)
    expect(requests.at(-1)?.get('x-guest-grant')).toBe(grant)
  }
  await withWidget(
    fetch,
    async client => {
      await client.start()
      identity(null, null)
      await client.unlock('password')
      identity(null, 'framed-grant')
      expect(client.account).toBeNull()
      await client.login('member', 'password')
      expect(client.signedIn).toBe(true)
      expect(client.account).toBe('member')
      identity('Bearer framed-account', null)
    },
    undefined,
    undefined,
    storage
  )
  await withWidget(
    fetch,
    async client => {
      await client.start()
      identity(null, null)
    },
    undefined,
    'b'.repeat(32),
    storage
  )
  await withWidget(
    fetch,
    async client => {
      await client.start()
      identity('Bearer framed-account', null)
      expect(client.account).toBe('member')
      client.logout()
      expect(client.signedIn).toBe(false)
      expect(client.account).toBeNull()
      identity(null, 'framed-grant')
      expect(storage.getItem('rchat_token')).toBe('app-account')
      expect(modes.every(mode => mode === 'omit')).toBe(true)
      expect(tickets.every(h => !h.has('authorization') && !h.has('x-guest-grant'))).toBe(true)
    },
    undefined,
    undefined,
    storage
  )
})

test('the live subscription picks up a posting change after the initial view', async () => {
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  await withWidget(
    async url => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      return Response.json(room)
    },
    async (client, sockets, _closed, ready) => {
      await client.start()
      expect(client.canPost).toBe(true)
      room.participate = false
      ready()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(client.canPost).toBe(false)
      expect(sockets).toHaveLength(1)
    }
  )
})

test('a revoked widget account keeps its unsent text for an explicit choice', async () => {
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  const posts: (string | null)[] = []
  let status = 200
  await withWidget(
    async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      if (url.endsWith('/login')) return Response.json({ token: 'current', user: me('member') })
      if (url.endsWith('/messages')) {
        posts.push(new Headers(init.headers).get('authorization'))
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (status !== 200) return Response.json({ error: 'Unavailable' }, { status })
      return Response.json(room)
    },
    async client => {
      await client.start()
      await client.login('member', 'password')
      client.draft.text = 'The unfinished phrase'
      status = 503
      await client.refresh()
      expect(client.signedIn).toBe(true)
      expect(client.room).toBeNull()
      status = 200
      await client.refresh()
      expect(client.draft.text).toBe('The unfinished phrase')
      expect(await client.send(client.draft.text).catch(e => e.message)).toBe('Unauthorized')
      await client.refresh()
      expect(client.signedIn).toBe(false)
      expect(client.canRestoreDraft).toBe(true)
      expect(client.draft.text).toBe('')
      client.recoverDraft(true)
      expect(client.draft.text).toBe('The unfinished phrase')
      expect(client.canRestoreDraft).toBe(false)
      expect(posts).toEqual(['Bearer current'])
      await client.login('member', 'password')
      status = 404
      await client.refresh()
      expect(client.signedIn).toBe(true)
      expect(client.canPost).toBe(false)
      expect(client.canRestoreDraft).toBe(false)
    }
  )
})

test('a delayed rejection from one account leaves its replacement signed in', async () => {
  const result = Promise.withResolvers<Response>()
  const submitted = Promise.withResolvers<void>()
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  await withWidget(
    async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      if (url.endsWith('/login')) {
        const username = JSON.parse(String(init.body)).username
        return Response.json({ token: username + '-token', user: me(username) })
      }
      if (url.endsWith('/messages')) {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer pianist-token')
        submitted.resolve()
        return result.promise
      }
      return Response.json(room)
    },
    async client => {
      await client.start()
      await client.login('pianist', 'password')
      const send = client.send('First score')
      await submitted.promise
      await client.login('flutist', 'password')
      result.resolve(Response.json({ error: 'Unauthorized' }, { status: 401 }))
      expect(await send.catch(e => e.message)).toBe('Unauthorized')
      expect(client.account).toBe('flutist')
      expect(client.canPost).toBe(true)
      expect(client.canRestoreDraft).toBe(false)
    }
  )
})

test('open copies in one embedding scope follow its sign-in and keep their unsent text', async () => {
  const id = 'a'.repeat(32)
  const key = { key: 'rchat_widget:' + id + ':https://instance.example' } as StorageEvent
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  await withWidget(
    async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      if (url.endsWith('/login')) {
        const username = JSON.parse(String(init.body)).username
        return Response.json({ token: username + '-token', user: me(username) })
      }
      if (url.endsWith('/logout')) return Response.json({ ok: true })
      if (url.endsWith('/me')) {
        const token = new Headers(init.headers).get('authorization') ?? ''
        return Response.json(me(token.slice('Bearer '.length).replace('-token', '')))
      }
      return Response.json(room)
    },
    async first => {
      const second = new WidgetConnection(id, () => {})
      try {
        await first.start()
        await second.start()
        second.draft.text = 'Typed as a guest'
        await first.login('flutist', 'password')
        await second.syncLogin(key)
        expect(second.account).toBe('flutist')
        expect(second.draft.text).toBe('')
        expect(second.canRestoreDraft).toBe(true)
        expect(second.draftExpired).toBe(false)
        second.recoverDraft(true)
        expect(second.draft.text).toBe('Typed as a guest')
        second.draft.text = 'Typed as flutist'
        first.logout()
        await second.syncLogin(key)
        expect(second.signedIn).toBe(false)
        expect(second.canRestoreDraft).toBe(true)
        await first.login('oboist', 'password')
        await second.syncLogin(key)
        expect(second.account).toBe('oboist')
        expect(second.canRestoreDraft).toBe(false)
        await first.login('flutist', 'password')
        await second.syncLogin(key)
        expect(second.account).toBe('flutist')
        expect(second.canRestoreDraft).toBe(false)
      } finally {
        second.destroy()
      }
    }
  )
})

test('link previews stay in place while the room is read again, then follow the new answer', async () => {
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [msg(30, { content: 'See https://instance.example/s/music/15/7/' })],
    users: [],
  }
  const answers: PromiseWithResolvers<Response>[] = []
  const settled = async (check: () => boolean) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(check()).toBe(true)
  }
  await withWidget(
    async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      if (url.endsWith('/locations')) {
        expect(JSON.parse(String(init.body))).toEqual({ ids: [7] })
        const answer = Promise.withResolvers<Response>()
        answers.push(answer)
        return answer.promise
      }
      return Response.json(room)
    },
    async client => {
      await client.start()
      await settled(() => answers.length === 1)
      answers[0].resolve(Response.json([{ id: 7, content: 'Rehearsal at seven' }]))
      await settled(() => client.linkCards.get(7)?.content === 'Rehearsal at seven')
      await client.refresh()
      await settled(() => answers.length === 2)
      expect(client.linkCards.get(7)?.content).toBe('Rehearsal at seven')
      answers[1].resolve(Response.json([]))
      await settled(() => !client.linkCards.has(7))
    }
  )
})

test('a frame that cannot send says why it holds the unsent text of an ended sign-in', async () => {
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  let token = 'current'
  await withWidget(
    async (url, init) => {
      if (url.endsWith('/session')) return Response.json({ mode: 'members', ticket: 'ticket' })
      if (url.endsWith('/login')) return Response.json({ token, user: me('member') })
      const auth = new Headers(init.headers).get('authorization')
      if (auth === null) return Response.json({ error: 'Not found' }, { status: 404 })
      if (auth !== 'Bearer ' + token)
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return Response.json(room)
    },
    async client => {
      await client.start()
      expect(client.room).toBeNull()
      expect(client.heldNotice).toBeNull()
      await client.login('member', 'password')
      expect(client.canPost).toBe(true)
      client.draft.text = 'Before the change'
      token = 'replaced'
      await client.refresh()
      await client.refresh()
      expect(client.signedIn).toBe(false)
      expect(client.room).toBeNull()
      expect(client.canRestoreDraft).toBe(false)
      expect(client.heldNotice).toBe(
        'Your sign-in expired. Sign in again to send your unsent text.'
      )
      await client.login('member', 'password')
      expect(client.canRestoreDraft).toBe(true)
      expect(client.heldNotice).toBeNull()
      client.recoverDraft(true)
      expect(client.draft.text).toBe('Before the change')
    }
  )
})

test('refresh notices that arrive during a refresh lead to one more', async () => {
  const room = {
    server: 'music',
    channel_id: 15,
    kind: 'text',
    participate: true,
    messages: [],
    users: [],
  }
  const views: (() => void)[] = []
  let viewed = 0
  let rooms = 0
  await withWidget(
    async url => {
      if (url.endsWith('/session')) return Response.json({ mode: 'public_chat', ticket: 'ticket' })
      if (url.endsWith('/room')) rooms++
      if (url.endsWith('/view')) {
        viewed++
        if (viewed > 1) await new Promise<void>(resolve => views.push(resolve))
      }
      return Response.json(room)
    },
    async (client, _sockets, _closed, _ready, deliver) => {
      await client.start()
      expect(viewed).toBe(1)
      for (let i = 0; i < 5; i++) deliver({ type: 'widget_refresh' })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect([rooms, viewed]).toEqual([2, 2])
      views.shift()?.()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect([rooms, viewed]).toEqual([3, 3])
      views.shift()?.()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect([rooms, viewed]).toEqual([3, 3])
    }
  )
})

test('the voice list in a frame says who is muted or deafened, and by whom', async () => {
  const metadata: WidgetRoomMetadata = { server: 'music', channel_id: 15, kind: 'voice' }
  await withWidget(
    async (url: string) => {
      const path = new URL(url).pathname.split('/').at(-1)!
      if (path === 'session') return Response.json({ mode: 'voice', ticket: 'ticket' })
      if (path === 'room') return Response.json(metadata)
      if (path === 'view')
        return Response.json({
          ...metadata,
          name: 'Lounge',
          participate: true,
          users: ['alice', 'bob', 'carol'],
          messages: [],
        })
      throw Error('Unexpected request')
    },
    async (client, _sockets, _closed, ready, deliver) => {
      await client.start()
      await client.refresh()
      ready()
      const audio = (channel_id: number, username: string, muted: boolean, deafened: boolean) =>
        deliver({ type: 'voice_audio', server: 'music', channel_id, username, muted, deafened })
      audio(15, 'alice', true, true)
      audio(16, 'carol', true, false)
      expect(client.statusOf('alice')).toEqual(['Muted', 'Deafened'])
      expect(client.statusOf('carol')).toEqual([])
      deliver({ type: 'widget_mutes', users: ['bob', 'carol'], staff: ['carol'] })
      expect(client.statusOf('bob')).toEqual(['Muted by a moderator'])
      expect(client.statusOf('carol')).toEqual(['Muted by staff'])
      deliver({
        type: 'voice_muted',
        server: 'music',
        channel_id: 15,
        username: 'carol',
        muted: false,
        staff: true,
      })
      expect(client.statusOf('carol')).toEqual([])
      audio(15, 'alice', false, false)
      expect(client.statusOf('alice')).toEqual([])
      audio(15, 'alice', true, false)
      deliver({ type: 'voice_state', server: 'music', channel_id: 15, users: ['bob'] })
      expect(client.audio).toEqual({})
    }
  )
})
