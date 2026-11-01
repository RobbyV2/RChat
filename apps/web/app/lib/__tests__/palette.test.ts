import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fuzzy, fuzzyParts } from '../fuzzy'
import {
  EMPTY_PALETTE,
  USED_MAX,
  commandsFor,
  frecency,
  noteUse,
  paletteKey,
  paletteValue,
  parsePalette,
  parseQuery,
  rank,
  registerCommands,
  type PaletteItem,
} from '../palette'
import { registerCoreCommands } from '../palette_commands'
import { PaletteIndex } from '../palette_index'
import { buildSections, flatItems, snippet, type ResultCtx } from '../palette_results'
import { usePaletteUi } from '../palette_store'
import { REDACTED, parseOpenApi } from '../openapi'
import { resetSessionCaches, useStore } from '../store'
import { SHORTCUTS, conflicts } from '../shortcuts'
import { emptySelection, selectAll, toggle } from '../selection'
import type { RChatState } from '../store_types'
import { me, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const has = (list: string[], want: string[]) => want.every(x => list.includes(x))

const item = (id: string, title: string, over: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  title,
  group: 'commands',
  run: () => {},
  ...over,
})

describe('fuzzy matching', () => {
  test('word starts and runs beat scattered letters; every word must match', () => {
    const a = fuzzy('gen', 'general')
    const b = fuzzy('gen', 'big engine')
    expect(a && b && a.score > b.score).toBe(true)
    expect(fuzzy('gnrl', 'general')?.hits).toEqual([0, 2, 4, 6])
    expect(fuzzy('mute gen', 'Mute #general') === null).toBe(false)
    expect(fuzzy('mute xyz', 'Mute #general')).toBeNull()
    expect(fuzzy('', 'x')).toEqual({ score: 0, hits: [] })
    const short = fuzzy('me', 'GET /api/me')
    const long = fuzzy('me', 'GET /api/servers/{name}/system_messages')
    expect(short && long && short.score > long.score).toBe(true)
    expect(fuzzyParts('general', [0, 1])).toEqual([
      { text: 'ge', hit: true },
      { text: 'neral', hit: false },
    ])
  })
})

describe('ranking', () => {
  const now = 1_000_000_000_000
  const items = [
    item('a', 'Mark as read'),
    item('b', 'Mute channel'),
    item('c', 'Mark server read'),
  ]

  test('usage lifts an item; recent use counts more than old use', () => {
    expect(rank(items, 'ma', {}, now).map(r => r.item.id)).toEqual(['a', 'c', 'b'])
    const usage = { c: { n: 9, at: now } }
    expect(rank(items, 'ma', usage, now)[0].item.id).toBe('c')
    expect(
      frecency({ n: 3, at: now }, now) > frecency({ n: 3, at: now - 30 * 86_400_000 }, now)
    ).toBe(true)
    expect(rank(items, '', usage, now).map(r => r.item.id)).toEqual(['c', 'a', 'b'])
    expect(rank(items, 'zzz', usage, now)).toEqual([])
  })

  test('keywords and aliases match, aliases as strongly as the title', () => {
    const list = [
      item('k', 'Switch theme', { keywords: ['dark mode'] }),
      item('x', 'Get the account', { aliases: ['GET /api/me'] }),
    ]
    expect(rank(list, 'dark', {}, now)[0].item.id).toBe('k')
    expect(rank(list, 'get /me', {}, now)[0].item.id).toBe('x')
  })
})

describe('prefixes and prefs', () => {
  test('a leading prefix picks the mode', () => {
    expect(parseQuery('#gen')).toEqual({ mode: 'channels', q: 'gen' })
    expect(parseQuery(' @ bob ')).toEqual({ mode: 'people', q: 'bob' })
    expect(parseQuery('>mute')).toEqual({ mode: 'commands', q: 'mute' })
    expect(parseQuery('/get me')).toEqual({ mode: 'api', q: 'get me' })
    expect(parseQuery('?')).toEqual({ mode: 'help', q: '' })
    expect(parseQuery('general #x')).toEqual({ mode: 'all', q: 'general #x' })
  })

  test('Ctrl/Cmd+K only, and the shortcut list stays free of clashes', () => {
    const k = { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(paletteKey(k)).toBe(true)
    expect(paletteKey({ ...k, ctrlKey: false, metaKey: true })).toBe(true)
    expect(paletteKey({ ...k, shiftKey: true })).toBe(false)
    expect(paletteKey({ ...k, ctrlKey: false })).toBe(false)
    expect(SHORTCUTS.some(s => s.keys === 'Mod+K')).toBe(true)
    expect(conflicts()).toEqual([])
  })

  test('prefs are parsed defensively and usage is capped', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2}', '"x"'])
      expect(parsePalette(raw)).toEqual(EMPTY_PALETTE)
    const ok = parsePalette(
      JSON.stringify({
        v: 1,
        index: 'full',
        used: { a: { n: 2, at: 5 }, b: { n: -1, at: 1 }, c: 4 },
      })
    )
    expect(ok).toEqual({ v: 1, index: 'full', used: { a: { n: 2, at: 5 } } })
    expect(parsePalette(JSON.stringify({ v: 1, index: 'everything', used: {} })).index).toBe('off')
    let p = EMPTY_PALETTE
    for (let i = 0; i < USED_MAX + 20; i++) p = noteUse(p, `id${i}`, i)
    p = noteUse(p, 'id319', 999)
    expect(Object.keys(p.used)).toHaveLength(USED_MAX)
    expect(p.used.id0).toBeUndefined()
    expect(p.used.id319).toEqual({ n: 2, at: 999 })
    expect(parsePalette(paletteValue(p))).toEqual(p)
  })
})

describe('the command registry', () => {
  test('providers register, follow the state, skip duplicates and unregister', () => {
    const off = registerCommands('test', () => [
      item('t1', 'One'),
      { ...item('t2', 'Two'), when: st => st.guest },
      item('t1', 'Duplicate'),
    ])
    const s = useStore.getState()
    const ids = commandsFor({ ...s, guest: false }).map(c => c.id)
    expect(ids.filter(i => i.startsWith('t'))).toEqual(['t1'])
    expect(commandsFor({ ...s, guest: true }).some(c => c.id === 't2')).toBe(true)
    off()
    expect(commandsFor(s).some(c => c.id === 't1')).toBe(false)
  })

  test('a throwing provider does not break the others', () => {
    const err = console.error
    console.error = () => {}
    const off = registerCommands('broken', () => {
      throw new Error('x')
    })
    const off2 = registerCommands('fine', () => [item('fine', 'Fine')])
    expect(commandsFor(useStore.getState()).some(c => c.id === 'fine')).toBe(true)
    off()
    off2()
    console.error = err
  })
})

describe('sections', () => {
  const g = globalThis as { window?: unknown; document?: unknown }
  const real = {
    window: g.window,
    document: g.document,
    askAddFriends: useStore.getState().askAddFriends,
  }
  let asked: string[][] = []
  const general = [
    msg(1, { content: 'hello rockets', author: user('bob') }),
    msg(2, { content: 'the secret is ||banana pudding|| ok', author: user('bob') }),
    msg(3, { content: 'thread root', reply_count: 2 }),
  ]

  const ctx = (over: Partial<ResultCtx> = {}): ResultCtx => ({
    usage: {},
    now: 1,
    index: null,
    visible: () => true,
    ops: null,
    history: [],
    recents: [],
    mask: t => t,
    ...over,
  })

  beforeEach(() => {
    asked = []
    Object.assign(globalThis, { localStorage: memoryStorage })
    g.window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x' },
      innerWidth: 800,
    }
    registerCoreCommands()
    useStore.setState({
      token: 'tok',
      me: me('alice', {
        servers: [{ name: 's', display_name: 'Space', creator: null, is_admin: false }],
      }),
      guest: false,
      servers: {
        s: serverDetail('s', {
          channels: [
            { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0, category_id: 7 },
            { id: 2, name: 'random', kind: 'text', slowmode_seconds: 0 },
          ],
          categories: [{ id: 7, name: 'Chat', position: 0 }],
        }),
      },
      dms: [{ id: 9, other: user('bob', { display_name: 'Bobby' }), is_self: false }],
      blocked: {},
      view: { kind: 'channel', server: 's', channelId: 1 },
      messages: { c1: general },
      selection: null,
      streamer: false,
      call: null,
      voice: null,
      panel: null,
      askAddFriends: (names: string[]) => void asked.push(names),
    })
  })

  afterEach(() => {
    g.window = real.window
    g.document = real.document
    useStore.setState({
      askAddFriends: real.askAddFriends,
      token: null,
      me: null,
      selection: null,
      messages: {},
      servers: {},
      dms: [],
    })
  })

  const st = (): RChatState => useStore.getState()

  test('selection actions come first while messages are selected (Ctrl+A)', () => {
    expect(buildSections(st(), '', ctx())[0].group === 'selection').toBe(false)
    useStore.setState({ selection: selectAll(toggle(emptySelection('c1'), general[0])) })
    const secs = buildSections(st(), '', ctx())
    expect(secs[0].group).toBe('selection')
    const ids = secs[0].items.map(i => i.item.id)
    expect(ids).toContain('selection_delete')
    expect(ids).toContain('selection_export_json')
    expect(buildSections(st(), 'export', ctx())[0].items[0].item.id).toBe('selection_export_text')
    expect(buildSections(st(), '>', ctx())[0].group).toBe('selection')
  })

  test('typed commands run with their argument: add friends en masse goes to one preview', async () => {
    const secs = buildSections(st(), 'add friends carol @Dave erin', ctx())
    expect(secs[0].label).toBe('Run')
    const run = secs[0].items[0].item
    expect(run.title).toBe('Add friends: carol dave erin')
    await run.run()
    expect(asked).toEqual([['carol', 'dave', 'erin']])
    expect(buildSections(st(), 'dm bob', ctx())[0].items[0].item.title).toBe('Start a DM: bob')
  })

  test('navigation: channels with categories, DMs, threads; # and @ narrow', () => {
    const chan = flatItems(buildSections(st(), '#', ctx()))
    expect(
      has(
        chan.map(i => i.id),
        ['channel_1', 'channel_2', 'category_7', 'thread_3', 'server_s']
      )
    ).toBe(true)
    expect(chan.find(i => i.id === 'channel_1')?.subtitle).toBe('Space · Chat')
    const all = flatItems(buildSections(st(), 'rand', ctx()))
    expect(all[0].id).toBe('channel_2')
    const people = flatItems(buildSections(st(), '@bob', ctx()))
    expect(people.map(i => i.id)).toEqual(['person_bob'])
    expect(people[0].subtitleName).toBe(true)
    useStore.setState({ blocked: { bob: true } })
    expect(flatItems(buildSections(st(), '@bob', ctx()))).toEqual([])
  })

  test('messages come from the index, spoilers masked, nothing shown in streamer mode', () => {
    const index = new PaletteIndex(1e9)
    index.add(
      general.map(m => ({
        id: `m${m.id}`,
        kind: 'message' as const,
        bucket: 'c1',
        source: 'instance',
        server: 's',
        channel: 1,
        dm: null,
        thread: null,
        msg: m.id,
        author: m.author.username,
        name: m.author.display_name,
        text: m.content,
        at: m.created_at,
      }))
    )
    const found = flatItems(buildSections(st(), 'banana', ctx({ index })))
    const hit = found.find(i => i.id === 'message_m2')
    expect(hit?.title).toBe('the secret is ████████ ok')
    expect(hit?.subtitle?.startsWith('bob · #general')).toBe(true)
    expect(found.some(i => i.id === 'search_server')).toBe(true)
    expect(
      flatItems(buildSections(st(), 'banana', ctx({ index, visible: () => false }))).some(
        i => i.id === 'message_m2'
      )
    ).toBe(false)
    useStore.setState({ streamer: true })
    const hidden = flatItems(buildSections(st(), 'banana', ctx({ index }))).find(
      i => i.id === 'message_m2'
    )
    expect(hidden?.title).toBe('Message from bob')
    expect(hidden?.name).toBe(true)
    expect(snippet('a ||b|| c', t => t.replace('a', '*'))).toBe('* ███ c')
  })

  test('/ lists API operations and slash commands like /poll; ? lists help', () => {
    const ops = parseOpenApi({
      paths: {
        '/api/me': { get: { operationId: 'me', summary: 'Get the signed-in account' } },
        '/api/servers/{name}/system_messages': {
          get: { operationId: 'sys', summary: 'Get join and leave message settings' },
        },
      },
    })
    const secs = buildSections(st(), '/poll', ctx({ ops }))
    expect(secs[0].items[0].item.title).toBe('/poll  Create poll')
    const api = flatItems(buildSections(st(), '/get me', ctx({ ops })))
    expect(api.filter(i => i.group === 'api')[0].id).toBe('api_me')
    expect(api.every(i => i.group !== 'api' || i.keepOpen)).toBe(true)
    const help = flatItems(buildSections(st(), '?', ctx()))
    expect(
      has(
        help.map(i => i.id),
        ['help_channels', 'help_api']
      )
    ).toBe(true)
  })

  test('guests get no API console: no rows, no help row, no history', () => {
    const ops = parseOpenApi({
      paths: { '/api/me': { get: { operationId: 'me', summary: 'Get the signed-in account' } } },
    })
    const history = [
      {
        op: 'me',
        method: 'GET' as const,
        path: '/api/me',
        status: 200,
        at: 1,
        values: { params: {}, body: '' },
      },
    ]
    expect(
      flatItems(buildSections(st(), '/', ctx({ ops, history }))).some(i => i.group === 'api')
    ).toBe(true)
    useStore.setState({ guest: true, me: null, token: null })
    for (const text of ['/', '/get me', '/me'])
      expect(
        flatItems(buildSections(st(), text, ctx({ ops, history }))).filter(
          i => i.group === 'api' || i.id.startsWith('apihistory_')
        )
      ).toEqual([])
    expect(flatItems(buildSections(st(), '?', ctx())).some(i => i.id === 'help_api')).toBe(false)
  })

  test('a saved request row shows the path template, never a secret path value', () => {
    const ops = parseOpenApi({
      paths: {
        '/api/webhooks/{id}/{token}': {
          post: {
            operationId: 'run_hook',
            summary: 'Run a webhook',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
            ],
          },
        },
      },
    })
    const history = [
      {
        op: 'run_hook',
        method: 'POST' as const,
        // An entry from before templates were kept still can't show what it filled in.
        path: '/api/webhooks/7/s3cr3t',
        status: 204,
        at: 1,
        values: { params: { id: '7', token: REDACTED }, body: '' },
      },
    ]
    const row = flatItems(buildSections(st(), '/', ctx({ ops, history }))).find(i =>
      i.id.startsWith('apihistory_')
    )
    expect(row?.title).toBe('POST /api/webhooks/7/{token}')
  })

  test('context: DM commands, guests get no member commands', () => {
    useStore.setState({ view: { kind: 'dm', dmId: 9 } })
    const ids = commandsFor(st()).map(c => c.id)
    expect(has(ids, ['call', 'video_call', 'close_dm', 'mute_here', 'poll'])).toBe(true)
    expect(commandsFor(st()).find(c => c.id === 'mark_read_here')?.title).toBe(
      'Mark this DM as read'
    )
    useStore.setState({
      guest: true,
      me: null,
      view: { kind: 'channel', server: 's', channelId: 1 },
    })
    const guest = commandsFor(st()).map(c => c.id)
    expect(guest.some(id => ['add_friends', 'poll', 'logout'].includes(id))).toBe(false)
    expect(guest).toContain('theme')
  })

  test('used commands are suggested first', () => {
    usePaletteUi.setState({ prefs: { ...EMPTY_PALETTE, used: { theme: { n: 3, at: 1 } } } })
    const secs = buildSections(st(), '', ctx({ usage: usePaletteUi.getState().prefs.used }))
    const frequent = secs.find(x => x.label === 'Frequent commands')
    expect(frequent?.items[0].item.id).toBe('theme')
  })
})
