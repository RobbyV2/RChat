import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { home } from '../instances'
import {
  attachModes,
  MAX_UPLOAD,
  siteSettings,
  startMode,
  useStore,
  resetSessionCaches,
} from '../store'
import { p2p, type CallBinding } from '../p2p'
import { DENIED_CALL, relayBook } from '../relays'
import type { CallRelays, MessageMedia, SiteSettings, VoiceMsg, WsEvent } from '../types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realRemove = p2p.removeFile.bind(p2p)
let removed: string[] = []
let realSettings = useStore.getState().settings
const tick = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

const hosted = (id: string, hoster: string): MessageMedia => ({
  id,
  filename: 'a.txt',
  kind: 'p2p',
  hoster,
  expires_at: null,
  size: 1,
  mime: 'text/plain',
  removed: false,
  removed_by_author: false,
  spoiler: false,
})

const scoped = { server: 's', channel_id: 1, dm_id: null, dm_users: null }

beforeEach(() => {
  realSettings = useStore.getState().settings
  Object.assign(globalThis, { localStorage: memoryStorage })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
  }
  removed = []
  p2p.removeFile = (id: string) => {
    removed.push(id)
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
  useStore.setState({
    me: me('bob'),
    token: 't',
    guest: false,
    error: null,
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: { s: serverDetail('s') },
    messages: {
      c1: [
        msg(10, { author: user('bob'), media: hosted('f10', 'bob') }),
        msg(11, { author: user('bob'), media: hosted('f11', 'bob') }),
        msg(12, { author: user('alice'), media: hosted('f12', 'alice') }),
        msg(13, { author: user('bob'), media: hosted('f13', 'bob') }),
      ],
    },
    outbox: {},
    panel: null,
  })
})

afterEach(() => {
  useStore.setState({ settings: realSettings })
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  p2p.removeFile = realRemove
})

describe('hosted P2P files follow their message', () => {
  test('deleting your own message stops hosting its file', async () => {
    await st().deleteMessage(10)
    await tick()
    expect(removed).toEqual(['f10'])
    expect(st().messages.c1.map(m => m.id)).toEqual([11, 12, 13])
  })

  test('a deletion from elsewhere stops hosting, but only your own files', () => {
    dispatch({ type: 'message_deleted', id: 11, thread_root_id: null, ...scoped })
    dispatch({ type: 'message_deleted', id: 12, thread_root_id: null, ...scoped })
    expect(removed).toEqual(['f11'])
  })

  test('a removed attachment stops being hosted', () => {
    dispatch({
      type: 'media_removed',
      message_id: 13,
      removed_by_author: false,
      ...scoped,
    })
    expect(removed).toEqual(['f13'])
  })
})

describe('removals reach files and copies of messages not loaded here', () => {
  const realForget = p2p.forgetMessage.bind(p2p)
  const realReconcile = p2p.reconcile.bind(p2p)
  let forgot: number[] = []
  let checked: [string[], string[]][] = []
  beforeEach(() => {
    forgot = []
    checked = []
    p2p.forgetMessage = (id: number) => {
      forgot.push(id)
    }
    p2p.reconcile = async (live: string[], ids: string[]) => {
      checked.push([live, ids])
    }
  })
  afterEach(() => {
    p2p.forgetMessage = realForget
    p2p.reconcile = realReconcile
  })

  test('removal and deletion events always tell the P2P store', () => {
    dispatch({
      type: 'media_removed',
      message_id: 99,
      removed_by_author: true,
      ...scoped,
    })
    dispatch({ type: 'message_deleted', id: 98, thread_root_id: null, ...scoped })
    expect(forgot).toEqual([99, 98])
    expect(removed).toEqual([])
  })

  test('turning P2P attachments back on asks for hosted files again', () => {
    const ws = home.ws as unknown as { sendVoice: (m: VoiceMsg) => boolean }
    const realSend = ws.sendVoice
    const sent: VoiceMsg[] = []
    ws.sendVoice = m => {
      sent.push(m)
      return true
    }
    const settings = { ...st().settings, p2p_attachments: false }
    useStore.setState({
      settings,
      p2pAvailability: { alice: { ids: [], online: true } },
    })
    dispatch({ type: 'settings_changed', settings: { ...settings, p2p_attachments: true } })
    ws.sendVoice = realSend
    expect(st().p2pAvailability).toEqual({})
    expect(sent).toEqual([{ type: 'p2p_who', hosters: ['bob', 'alice'] }])
  })

  test("the server's hosting answer is reconciled", () => {
    dispatch({ type: 'p2p_hosted', live: ['a'], checked: ['a', 'b'] })
    expect(checked).toEqual([[['a'], ['a', 'b']]])
  })
})

describe('P2P sends', () => {
  const realStage = p2p.stage.bind(p2p)
  const realPosted = p2p.posted.bind(p2p)
  const realAnnounce = p2p.announce.bind(p2p)
  afterEach(() => {
    p2p.stage = realStage
    p2p.posted = realPosted
    p2p.announce = realAnnounce
  })

  const sendP2p = async (answers: number[]) => {
    const log: string[] = []
    const bodies: string[] = []
    p2p.stage = async (id: string) => {
      log.push(`stage ${id}`)
    }
    p2p.posted = (id: string, messageId: number) => log.push(`posted ${id} ${messageId}`)
    p2p.announce = () => log.push('announce')
    p2p.removeFile = (id: string) => log.push(`remove ${id}`)
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p2p?: { p2p_id: string } }
      const id = body.p2p?.p2p_id ?? ''
      bodies.push(id)
      log.push(`post ${id}`)
      const status = answers.shift() ?? 200
      return status === 200
        ? new Response(JSON.stringify(msg(77, { author: user('bob') })), { status })
        : new Response(JSON.stringify({ error: 'Invalid p2p_id' }), { status })
    }) as unknown as typeof fetch
    const file = new File(['hello'], 'a.txt')
    // A channel no other test sends in: the store drains each conversation once at a time.
    useStore.setState({
      view: { kind: 'channel', server: 's', channelId: 4242 },
      pending: { c4242: { file, spoiler: false, mode: 'p2p', scope: 'c4242' } },
      outbox: {},
    })
    st().sendMessage('')
    const settled = () => {
      const head = st().outbox.c4242?.[0]
      return !head || head.status === 'failed'
    }
    for (let i = 0; i < 500 && !settled(); i += 1) await tick()
    return { log, bodies }
  }

  test('a P2P file is announced only after its message is posted', async () => {
    const { log, bodies } = await sendP2p([200])
    const id = bodies[0]
    expect(/^[0-9a-f]{32}$/.test(id)).toBe(true)
    expect(log).toEqual([`stage ${id}`, `post ${id}`, `posted ${id} 77`])
    expect(st().error).toBeNull()
  })

  test('an id someone posted first is replaced once with a fresh one', async () => {
    const { log, bodies } = await sendP2p([400])
    const [first, second] = bodies
    expect(/^[0-9a-f]{32}$/.test(second)).toBe(true)
    expect(second === first).toBe(false)
    expect(log).toEqual([
      `stage ${first}`,
      `post ${first}`,
      `remove ${first}`,
      `stage ${second}`,
      `post ${second}`,
      `posted ${second} 77`,
    ])
    expect(st().outbox.c4242).toBeUndefined()
  })

  test('a second refusal fails the send and drops the staged file', async () => {
    const { log, bodies } = await sendP2p([400, 400])
    expect(bodies.length).toBe(2)
    expect(log.slice(-2)).toEqual([`post ${bodies[1]}`, `remove ${bodies[1]}`])
    expect(st().outbox.c4242[0].status).toBe('failed')
    expect(st().error === null).toBe(false)
  })
})

describe('attachment settings', () => {
  const base: SiteSettings = {
    profanity_filter: false,
    profanity_targets: {
      messages: true,
      links: true,
      usernames: true,
      server_names: true,
      channel_names: true,
      role_names: true,
      file_names: true,
      bios: true,
      channel_topics: true,
      category_names: true,
    },
    asset_previews: true,
    asset_uploads: true,
    p2p_attachments: true,
    guests_enabled: true,
  }
  const big = MAX_UPLOAD + 1

  test('older servers without the switch keep P2P on', () => {
    const old = { ...base } as Partial<SiteSettings>
    delete old.p2p_attachments
    expect(siteSettings(old as SiteSettings).p2p_attachments).toBe(true)
    expect(siteSettings({ ...base, p2p_attachments: false }).p2p_attachments).toBe(false)
  })

  test('P2P does not depend on uploads and has no size cap; both off is text only', () => {
    expect(startMode(base, 10)).toBe('server')
    expect(startMode(base, big)).toBe('p2p')
    expect(startMode({ ...base, asset_uploads: false }, 10)).toBe('p2p')
    expect(startMode({ ...base, asset_uploads: false }, 2 ** 40)).toBe('p2p')
    expect(startMode({ ...base, p2p_attachments: false }, big)).toBe('server')
    const textOnly = { ...base, asset_uploads: false, p2p_attachments: false }
    expect(startMode(textOnly, 1)).toBeNull()
    expect(attachModes(textOnly)).toEqual([])
  })

  test('picking or dropping a file follows the switches', () => {
    const file = (size: number) =>
      ({ name: 'f.bin', size, type: '', slice: () => new Blob([]) }) as unknown as File
    useStore.setState({ settings: { ...base, asset_uploads: false }, pending: {}, error: null })
    st().uploadFile('c1', file(big))
    expect(st().pending.c1?.mode).toBe('p2p')
    st().toggleUploadMode('c1')
    expect(st().pending.c1?.mode).toBe('p2p')
    useStore.setState({
      settings: { ...base, asset_uploads: false, p2p_attachments: false },
      pending: {},
    })
    st().uploadFile('c1', file(1))
    expect(st().pending.c1).toBeUndefined()
    expect(st().error).toBeNull()
    useStore.setState({ settings: { ...base, p2p_attachments: false }, pending: {} })
    st().uploadFile('c1', file(big))
    expect(st().pending.c1).toBeUndefined()
    expect(st().error === null).toBe(false)
  })
})

describe('P2P call binding', () => {
  const ws = home.ws as unknown as { sendVoice: (m: VoiceMsg) => boolean }
  const realSend = ws.sendVoice
  const real = {
    dial: p2p.dial.bind(p2p),
    bind: p2p.bind.bind(p2p),
    peerId: p2p.peerId.bind(p2p),
    mediaActive: p2p.mediaActive.bind(p2p),
  }
  let sent: VoiceMsg[] = []
  let dialed = 0
  let bound: CallBinding[] = []
  let tab = 'bob-tab'
  beforeEach(() => {
    // Before the socket is captured: a relay change makes managers left hosting by other test
    // files announce again.
    relayBook.load(null)
    sent = []
    dialed = 0
    bound = []
    tab = 'bob-tab'
    ws.sendVoice = m => {
      sent.push(m)
      return true
    }
    p2p.dial = () => {
      dialed += 1
    }
    p2p.bind = b => {
      if (bound.some(x => x.callId === b.callId)) return false
      bound.push(b)
      return true
    }
    p2p.peerId = () => tab
    p2p.mediaActive = () => true
    useStore.setState({ call: null, error: null })
  })
  afterEach(() => {
    ws.sendVoice = realSend
    Object.assign(p2p, real)
  })

  const active = (
    from: string,
    peers?: { user: string; peer_id: string }[],
    id = 'c1',
    relays?: CallRelays[]
  ) =>
    dispatch({
      type: 'call_state',
      dm_id: 5,
      dm_users: ['alice', 'bob'],
      state: 'active',
      from,
      kind: 'p2p',
      ...(peers ? { call_id: id, peers } : {}),
      ...(relays ? { relays } : {}),
    })
  const peers = [
    { user: 'bob', peer_id: 'bob-tab' },
    { user: 'alice', peer_id: 'alice-tab' },
  ]

  test('the caller dials only the tab the server named, once per call', async () => {
    active('bob', peers)
    active('bob', peers)
    await tick()
    expect(bound).toEqual([{ callId: 'c1', peer: 'alice-tab', dial: true }])
    expect(dialed).toBe(1)
    expect(sent).toEqual([])
  })

  test("the caller asks about the callee's unknown relay first, and Deny hangs up", async () => {
    active('bob', peers, 'c1', [{ user: 'alice', hosts: ['turn.alice.example'] }])
    await tick()
    expect(st().relayPrompt).toBe('turn.alice.example')
    expect([bound, dialed]).toEqual([[], 0])
    st().answerRelayPrompt('deny')
    await tick()
    expect(st().relayPrompt).toBeNull()
    expect([bound, dialed]).toEqual([[], 0])
    expect(st().error).toBe(DENIED_CALL)
    expect(sent.map(m => m.type)).toEqual(['call_leave'])
  })

  test('Always allow dials, and the host is not asked about again', async () => {
    active('bob', peers, 'c1', [{ user: 'alice', hosts: ['turn.alice.example'] }])
    await tick()
    st().answerRelayPrompt('always')
    await tick()
    expect(dialed).toBe(1)
    expect(st().relayPrefs.allowed).toEqual(['turn.alice.example'])
    active('bob', peers, 'c2', [{ user: 'alice', hosts: ['turn.alice.example'] }])
    await tick()
    expect(st().relayPrompt).toBeNull()
    expect(dialed).toBe(2)
  })

  test("the caller's own relay hosts are never asked about", async () => {
    active('bob', peers, 'c1', [{ user: 'bob', hosts: ['turn.bob.example'] }])
    await tick()
    expect(st().relayPrompt).toBeNull()
    expect(dialed).toBe(1)
  })

  test('the callee binds to the caller and waits for it to dial', () => {
    active('alice', peers)
    expect(bound).toEqual([{ callId: 'c1', peer: 'alice-tab', dial: false }])
    expect(dialed).toBe(0)
  })

  test('other tabs of the same user and tabs without media stay out of the call', () => {
    tab = 'bob-other-tab'
    active('bob', peers)
    tab = 'bob-tab'
    p2p.mediaActive = () => false
    active('bob', peers)
    expect([bound, dialed]).toEqual([[], 0])
  })

  test('a call without a binding (an older server or app) never connects', () => {
    active('bob')
    expect([bound, dialed]).toEqual([[], 0])
    active('bob', [peers[0]])
    expect([bound, dialed]).toEqual([[], 0])
    expect(st().error).toContain('older app')
    expect(typeof st().p2pCallFailed[5]).toBe('number')
  })

  test('a later call that binds clears the failed mark', () => {
    active('bob')
    expect(typeof st().p2pCallFailed[5]).toBe('number')
    active('bob', peers, 'c2')
    expect(st().p2pCallFailed[5]).toBeUndefined()
  })
})
