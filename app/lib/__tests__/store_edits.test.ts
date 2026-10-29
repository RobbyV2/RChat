import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { parseSed } from '../sed'
import type { EditStub, Message, MessageMedia, ReplyRef, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
let patches: { url: string; body: Record<string, unknown> }[] = []
let refuse: string | null = null
let gets: string[] = []
let reads: Record<string, Message[]> = {}
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const bob = user('bob')
const quote = (over: Partial<ReplyRef> = {}): ReplyRef => ({
  id: 10,
  author: bob,
  content: 'teh plan',
  has_media: false,
  deleted: false,
  mention: true,
  ...over,
})
const mine = msg(10, { author: bob, content: 'teh plan', reactions: [] })
const reply = msg(11, { author: user('alice'), content: 'ok', reply_to: quote() })

beforeEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  patches = []
  refuse = null
  gets = []
  reads = {}
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push({ url, body })
      if (refuse !== null) return new Response(JSON.stringify({ error: refuse }), { status: 400 })
      const id = Number(url.split('/').at(-1))
      const saved: Message = msg(id, {
        author: bob,
        content: String(body.content),
        edited_at: 500,
        reactions: [],
      })
      return new Response(JSON.stringify(saved), { status: 200 })
    }
    if (!init?.method || init.method === 'GET') {
      gets.push(url)
      const list = reads[url]
      if (list) return new Response(JSON.stringify(list), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    confirm: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: { c1: [msg(9), mine, reply] },
    outbox: {},
    replying: {},
    editing: null,
    composerFocus: null,
    panel: null,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
})

describe('message_updated', () => {
  test('replaces the text, keeps reactions and updates quotes of it', () => {
    const reacted = { ...mine, reactions: [{ emoji: '👍', count: 1, me: true, first_at: 1 }] }
    const gone = msg(12, {
      author: user('carol'),
      reply_to: quote({ deleted: true, author: null }),
    })
    const thread = msg(13, { thread_root_id: 11, reply_to: quote() })
    useStore.setState({
      messages: { c1: [msg(9), reacted, reply, gone], t11: [thread] },
      panel: { kind: 'thread', root: { ...reply } },
      replying: { c1: { message: reacted, mention: true } },
    })
    dispatch({
      type: 'message_updated',
      message: { ...mine, content: 'the **plan**', edited_at: 77, reactions: [] },
    })
    const list = st().messages.c1
    expect(list[1].content).toBe('the **plan**')
    expect(list[1].edited_at).toBe(77)
    expect(list[1].reactions?.[0].emoji).toBe('👍')
    expect(list[2].reply_to?.content).toBe('the plan')
    expect(list[3].reply_to).toEqual(gone.reply_to)
    expect(st().messages.t11[0].reply_to?.content).toBe('the plan')
    const panel = st().panel
    expect(panel?.kind === 'thread' ? panel.root.reply_to?.content : null).toBe('the plan')
    expect(st().replying.c1?.message.content).toBe('the **plan**')
  })

  test('partial quotes are filled from the edited copy', () => {
    const late = msg(14, { reply_to: { ...quote(), content: '', author: null, partial: true } })
    dispatch({
      type: 'message',
      server: 's',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      message: late,
    })
    expect(st().messages.c1.at(-1)?.reply_to?.content).toBe('teh plan')
    dispatch({ type: 'message_updated', message: { ...mine, content: 'new plan', edited_at: 5 } })
    expect(st().messages.c1.at(-1)?.reply_to?.content).toBe('new plan')
  })
})

describe('inline editing', () => {
  test('only your own user messages', () => {
    st().startEdit('c1', reply)
    expect(st().editing).toBeNull()
    st().startEdit('c1', msg(15, { author: bob, kind: 'call' }))
    expect(st().editing).toBeNull()
    useStore.setState({ guest: true })
    st().startEdit('c1', mine)
    expect(st().editing).toBeNull()
    useStore.setState({ guest: false })
    st().startEdit('c1', mine)
    expect(st().editing).toEqual({ key: 'c1', id: 10, text: 'teh plan' })
  })

  test('Up edits the newest own message, nothing without one', () => {
    useStore.setState({ messages: { c1: [mine, msg(12, { author: bob }), reply] } })
    expect(st().editLast('c1')).toBe(true)
    expect(st().editing?.id).toBe(12)
    st().cancelEdit()
    expect(st().editLast('c2')).toBe(false)
    expect(st().editing).toBeNull()
  })

  test('the thread composer edits in the thread, then the root', () => {
    const root = msg(20, { author: bob, content: 'root' })
    useStore.setState({
      panel: { kind: 'thread', root },
      messages: { c1: [root], t20: [msg(21, { thread_root_id: 20 })] },
    })
    expect(st().editLast('t20')).toBe(true)
    expect(st().editing).toEqual({ key: 't20', id: 20, text: 'root' })
  })

  test('saving patches the message right away and sends the text', async () => {
    st().startEdit('c1', mine)
    st().setEditText('the plan')
    st().saveEdit(true)
    expect(st().editing).toBeNull()
    expect(st().composerFocus?.key).toBe('c1')
    expect(st().messages.c1[1].content).toBe('the plan')
    expect((st().messages.c1[1].edited_at ?? 0) > 0).toBe(true)
    await tick()
    expect(patches).toEqual([{ url: '/api/messages/10', body: { content: 'the plan' } }])
    expect(st().messages.c1[1].edited_at).toBe(500)
    expect(st().messages.c1[2].reply_to?.content).toBe('the plan')
  })

  test('unchanged text closes without a request', async () => {
    st().startEdit('c1', mine)
    st().saveEdit()
    await tick()
    expect(st().editing).toBeNull()
    expect(st().composerFocus).toBeNull()
    expect(patches).toEqual([])
  })

  test('a refused edit restores the text and shows the error', async () => {
    refuse = 'Content blocked by profanity filter'
    st().startEdit('c1', mine)
    st().setEditText('bad')
    st().saveEdit()
    await tick()
    expect(st().messages.c1[1].content).toBe('teh plan')
    expect(st().messages.c1[1].edited_at).toBeUndefined()
    expect(st().error).toBe('Content blocked by profanity filter')
  })

  test('an empty edit asks to delete and keeps editing', async () => {
    st().startEdit('c1', mine)
    st().setEditText('   ')
    st().saveEdit()
    expect(st().confirm?.title).toBe('Delete Message')
    expect(st().editing?.id).toBe(10)
    await tick()
    expect(patches).toEqual([])
  })

  test('deleting the message closes its editor', () => {
    st().startEdit('c1', mine)
    dispatch({
      type: 'message_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      dm_users: null,
      id: 10,
      thread_root_id: null,
    })
    expect(st().editing).toBeNull()
  })
})

describe('s/ edits', () => {
  test('replace in your newest message', async () => {
    const ok = await st().sedEdit('c1', parseSed('s/teh/the')!)
    expect(ok).toBe(true)
    expect(patches).toEqual([{ url: '/api/messages/10', body: { content: 'the plan' } }])
    expect(st().messages.c1[1].content).toBe('the plan')
    expect(st().error).toBeNull()
  })

  test('no match or no message of yours: an error and no request', async () => {
    expect(await st().sedEdit('c1', parseSed('s/xyz/abc')!)).toBe(false)
    expect(st().error).toBe('No match in your last message')
    useStore.setState({ messages: { c1: [reply] }, error: null })
    expect(await st().sedEdit('c1', parseSed('s/ok/fine')!)).toBe(false)
    expect(st().error).toBe('You have no message here to edit')
    expect(patches).toEqual([])
  })

  test('a refused edit reports false', async () => {
    refuse = 'Content blocked by profanity filter'
    expect(await st().sedEdit('c1', parseSed('s/teh/bad')!)).toBe(false)
    expect(st().error).toBe('Content blocked by profanity filter')
    expect(st().messages.c1[1].content).toBe('teh plan')
  })
})

const stub = (id: number, thread_root_id: number | null = null): EditStub => ({
  type: 'message_updated',
  stub: true,
  id,
  server: 's',
  channel_id: 1,
  thread_root_id,
  edited_at: 600,
})

const media = (over: Partial<MessageMedia> = {}): MessageMedia => ({
  id: 'm',
  filename: 'a.png',
  kind: 'server',
  hoster: null,
  expires_at: null,
  size: 1,
  mime: 'image/png',
  removed: false,
  removed_by_author: false,
  spoiler: false,
  ...over,
})

describe('edit stubs (server channels)', () => {
  test('a shown message is re-read through the list, keeping reactions', async () => {
    const reacted = { ...mine, reactions: [{ emoji: '👍', count: 1, me: true, first_at: 1 }] }
    useStore.setState({ messages: { c1: [msg(9), reacted, reply] } })
    reads['/api/channels/1/messages?around=10&limit=1'] = [
      msg(10, { author: bob, content: 'new plan', edited_at: 600, reactions: [] }),
    ]
    dispatch(stub(10))
    await tick()
    expect(gets).toEqual(['/api/channels/1/messages?around=10&limit=1'])
    const list = st().messages.c1
    expect(list[1].content).toBe('new plan')
    expect(list[1].edited_at).toBe(600)
    expect(list[1].reactions?.[0].emoji).toBe('👍')
    expect(list[2].reply_to?.content).toBe('new plan')
  })

  test('a message only quoted is re-read to refresh the quote', async () => {
    useStore.setState({ messages: { c1: [reply] } })
    reads['/api/channels/1/messages?around=10&limit=1'] = [
      msg(10, { author: bob, content: 'later plan', edited_at: 600 }),
    ]
    dispatch(stub(10))
    await tick()
    expect(gets.length).toBe(1)
    expect(st().messages.c1[0].reply_to?.content).toBe('later plan')
  })

  test('thread replies are re-read from their thread', async () => {
    const inThread = msg(21, { author: bob, thread_root_id: 20, content: 'a' })
    useStore.setState({ messages: { c1: [mine], t20: [inThread] } })
    reads['/api/messages/20/thread?around=21&limit=1'] = [{ ...inThread, content: 'b' }]
    dispatch(stub(21, 20))
    await tick()
    expect(gets).toEqual(['/api/messages/20/thread?around=21&limit=1'])
    expect(st().messages.t20[0].content).toBe('b')
  })

  test('nothing held: no request; not readable: nothing changes', async () => {
    dispatch(stub(99))
    await tick()
    expect(gets).toEqual([])
    reads['/api/channels/1/messages?around=10&limit=1'] = [msg(30, { content: 'other' })]
    dispatch(stub(10))
    await tick()
    expect(gets.length).toBe(1)
    expect(st().messages.c1.map(m => m.content)).toEqual(['hi', 'teh plan', 'ok'])
  })

  test('a stub during a re-read reads once more', async () => {
    reads['/api/channels/1/messages?around=10&limit=1'] = [
      msg(10, { author: bob, content: 'v2', edited_at: 600 }),
    ]
    dispatch(stub(10))
    dispatch(stub(10))
    dispatch(stub(10))
    await tick()
    await tick()
    expect(gets.length).toBe(2)
    expect(st().messages.c1[1].content).toBe('v2')
  })
})

describe('edit fixes', () => {
  test('Up with an edit open focuses it instead of replacing it', () => {
    useStore.setState({ messages: { c1: [mine, msg(12, { author: bob }), reply] } })
    st().startEdit('c1', mine)
    st().setEditText('half done')
    expect(st().editLast('c1')).toBe(true)
    expect(st().editing).toEqual({ key: 'c1', id: 10, text: 'half done', focus: 1 })
  })

  test('Up does not drop a changed edit in another view', () => {
    useStore.setState({ messages: { c1: [mine], c2: [msg(12, { author: bob, channel_id: 2 })] } })
    st().startEdit('c1', mine)
    st().setEditText('half done')
    useStore.setState({ view: { kind: 'channel', server: 's', channelId: 2 } })
    expect(st().editLast('c2')).toBe(true)
    expect(st().editing?.text).toBe('half done')
    expect(st().error).toBe('Finish your other edit first')
  })

  test('saving an edit of a message that is gone tells you', () => {
    st().startEdit('c1', mine)
    st().setEditText('x')
    useStore.setState({ messages: { c1: [reply] } })
    st().saveEdit()
    expect(st().editing).toBeNull()
    expect(st().error).toBe('This message is no longer here')
  })

  test('a removed attachment counts as none for an empty edit', async () => {
    const pic = msg(16, { author: bob, content: 'cap', media: media({ removed: true }) })
    useStore.setState({ messages: { c1: [pic] } })
    st().startEdit('c1', pic)
    st().setEditText('')
    st().saveEdit()
    expect(st().confirm?.title).toBe('Delete Message')
    await tick()
    expect(patches).toEqual([])
  })

  test('s/ that empties the message asks to delete it', async () => {
    expect(await st().sedEdit('c1', parseSed('s/teh plan/')!)).toBe(true)
    expect(st().confirm?.title).toBe('Delete Message')
    expect(patches).toEqual([])
    const pic = msg(16, { author: bob, content: 'cap', media: media() })
    useStore.setState({ messages: { c1: [pic] }, confirm: null })
    expect(await st().sedEdit('c1', parseSed('s/cap/')!)).toBe(true)
    expect(st().confirm).toBeNull()
    expect(patches).toEqual([{ url: '/api/messages/16', body: { content: '' } }])
  })

  test('s/ right after sending waits for the send and edits that message', async () => {
    let deliver: (m: Message) => void = () => {}
    const real = msg(30, { author: bob, content: 'quick tpyo' })
    useStore.setState({
      outbox: {
        c77: [
          {
            tempId: 9_000_001,
            key: 'c77',
            status: 'queued',
            msg: msg(9_000_001, { author: bob, content: 'quick tpyo' }),
            pending: null,
            p2pExpiresIn: null,
            send: () => new Promise<Message>(r => (deliver = r)),
          },
        ],
      },
    })
    st().retryOutgoing('c77', 9_000_001)
    const done = st().sedEdit('c77', parseSed('s/tpyo/typo')!)
    await tick()
    expect(patches).toEqual([])
    deliver(real)
    expect(await done).toBe(true)
    expect(patches).toEqual([{ url: '/api/messages/30', body: { content: 'quick typo' } }])
  })

  test('s/ on a message that fails to send edits nothing', async () => {
    let refuseSend: (e: Error) => void = () => {}
    useStore.setState({
      outbox: {
        c77: [
          {
            tempId: 9_000_002,
            key: 'c77',
            status: 'queued',
            msg: msg(9_000_002, { author: bob, content: 'quick tpyo' }),
            pending: null,
            p2pExpiresIn: null,
            send: () => new Promise<Message>((_, no) => (refuseSend = no)),
          },
        ],
      },
    })
    st().retryOutgoing('c77', 9_000_002)
    expect(await st().sedEdit('c77', parseSed('s/zzz/y')!)).toBe(false)
    expect(st().error).toBe('No match in your last message')
    const done = st().sedEdit('c77', parseSed('s/tpyo/typo')!)
    await tick()
    refuseSend(new Error('offline'))
    expect(await done).toBe(false)
    expect(st().error).toBe('Your last message was not sent')
    expect(patches).toEqual([])
  })
})
