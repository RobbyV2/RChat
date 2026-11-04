import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { home } from '../instances'
import {
  between,
  clear,
  deleteAllBody,
  deleteAuthorBody,
  deleteBody,
  deleteCounts,
  emptySelection,
  exported,
  isEmpty,
  isSelected,
  pickedIds,
  plainText,
  rangeTap,
  selectAll,
  selectAuthor,
  selectRange,
  selectable,
  selectedIn,
  selectionLabel,
  toggle,
} from '../selection'
import { selectionActions } from '../selection_actions'
import { exportBackoff } from '../selection_store'
import { SHORTCUTS, allKey, conflicts, selectKey, shortcutLabel } from '../shortcuts'
import { setSharing, type Sharing } from '../platform'
import { webSharing } from '../platform/web_sharing'
import type { BulkJob, Message, WsEvent } from '../types'
import { me, media, memoryStorage, msg, serverDetail, user } from './fixtures'

afterAll(resetSessionCaches)

const by = (id: number, author: string, over: Partial<Message> = {}) =>
  msg(id, { author: user(author), ...over })

const ids = (list: Message[]) => list.map(m => m.id)

describe('selection reducer', () => {
  const list = [by(1, 'bob'), by(2, 'alice'), by(3, 'bob'), by(4, 'carol'), by(5, 'alice')]

  test('toggle picks and unpicks and moves the anchor', () => {
    let sel = emptySelection('c1')
    sel = toggle(sel, list[1])
    sel = toggle(sel, list[3])
    expect(ids(selectedIn(sel, list))).toEqual([2, 4])
    expect(sel.anchor).toBe(4)
    sel = toggle(sel, list[1])
    expect(ids(selectedIn(sel, list))).toEqual([4])
    expect(selectionLabel(sel, list)).toBe('1 selected')
  })

  test('ranges run either way from the anchor and keep earlier picks', () => {
    let sel = toggle(emptySelection('c1'), list[0])
    sel = selectRange(sel, list, list[2])
    expect(ids(selectedIn(sel, list))).toEqual([1, 2, 3])
    sel = toggle(sel, list[4])
    sel = selectRange(sel, list, list[3])
    expect(ids(selectedIn(sel, list))).toEqual([1, 2, 3, 4, 5])
    expect(ids(between(list, 4, 2))).toEqual([2, 3, 4])
    expect(ids(between(list, 99, 2))).toEqual([2])
    expect(between(list, 1, 99)).toEqual([])
    const noAnchor = selectRange(emptySelection('c1'), list, list[2])
    expect(ids(selectedIn(noAnchor, list))).toEqual([3])
  })

  test('ranges span pages loaded later', () => {
    let sel = toggle(emptySelection('c1'), list[4])
    const older = [by(-2, 'dave'), by(-1, 'dave'), ...list]
    sel = selectRange(sel, older, older[0])
    expect(ids(selectedIn(sel, older))).toEqual([-2, -1, 1, 2, 3, 4, 5])
  })

  test('all is kept as all minus except, and rows loaded later are picked', () => {
    let sel = selectAll(toggle(emptySelection('c1'), list[0]))
    expect(sel.all && sel.ids.size === 0 && sel.anchor === 1).toBe(true)
    sel = toggle(sel, list[2])
    expect([...sel.except]).toEqual([3])
    expect(ids(selectedIn(sel, list))).toEqual([1, 2, 4, 5])
    const older = [by(-5, 'zed'), by(-4, 'zed'), ...list]
    expect(isSelected(sel, older[0]) && isSelected(sel, older[1])).toBe(true)
    sel = toggle(sel, list[2])
    expect(sel.except.size).toBe(0)
    expect(selectionLabel(sel, list)).toBe('All messages selected')
    sel = { ...sel, estimate: 4210, except: new Set([7, 8]) }
    expect(selectionLabel(sel, list)).toBe('All messages selected (about 4,208)')
    expect(isEmpty(sel, list)).toBe(false)
    expect(isEmpty(clear(sel), list)).toBe(true)
    expect(clear(sel).anchor).toBe(3)
  })

  test('picking an author covers their later rows; unchecking one excepts it', () => {
    let sel = selectAuthor(emptySelection('c1'), 'bob', list)
    expect(ids(selectedIn(sel, list))).toEqual([1, 3])
    sel = toggle(sel, list[0])
    expect(ids(selectedIn(sel, list))).toEqual([3])
    expect(isSelected(sel, by(9, 'bob'))).toBe(true)
    sel = selectAuthor(sel, 'bob', list)
    expect(ids(selectedIn(sel, list))).toEqual([1, 3])
    expect(pickedIds(sel, list)).toEqual([1, 3])
    expect(selectionLabel(sel, list)).toBe('All from this person selected')
    sel = toggle({ ...sel, estimate: 40 }, list[3])
    expect(selectionLabel(sel, list, 'bob')).toBe('All your messages selected (about 41)')
    sel = selectAuthor(sel, 'alice', list)
    expect([...sel.authors]).toEqual(['alice'])
    expect(sel.estimate).toBeNull()
    expect(ids(selectedIn(sel, list))).toEqual([2, 4, 5])
  })

  test('the label counts the loaded picks, as delete and copy do', () => {
    let sel = toggle(toggle(emptySelection('c1'), list[0]), list[1])
    sel = { ...sel, ids: new Set([...sel.ids, 99]) }
    expect(selectionLabel(sel, list)).toBe('2 selected')
  })

  test('the mobile range helper takes a first and a last tap', () => {
    let sel = { ...emptySelection('c1'), ranging: true }
    sel = rangeTap(sel, list, list[1])
    expect(sel.ranging && sel.anchor === 2).toBe(true)
    sel = rangeTap(sel, list, list[3])
    expect(sel.ranging).toBe(false)
    expect(ids(selectedIn(sel, list))).toEqual([2, 3, 4])
  })

  test('calls and system rows only when they can be deleted', () => {
    expect(selectable({ kind: 'user' }, false)).toBe(true)
    expect(selectable({ kind: 'poll' }, false)).toBe(true)
    expect(selectable({ kind: 'call' }, false)).toBe(false)
    expect(selectable({ kind: 'pin' }, true)).toBe(true)
  })
})

describe('delete confirm text', () => {
  const picked = [
    ...Array.from({ length: 30 }, (_, i) => by(i + 1, 'alice')),
    ...Array.from({ length: 7 }, (_, i) => by(i + 100, 'bob')),
  ]

  test('mixed permissions', () => {
    const counts = deleteCounts(picked, 'alice', false)
    expect(counts).toEqual({ total: 37, mine: 30, others: 7 })
    expect(deleteBody(counts, false)).toBe(
      'Delete 37 messages? You can delete 30 of them. 7 belong to others and need Manage messages.'
    )
    expect(deleteBody(deleteCounts(picked.slice(29, 31), 'alice', false), false)).toBe(
      'Delete 2 messages? You can delete 1 of them. 1 belongs to someone else and needs Manage messages.'
    )
    expect(deleteBody(counts, true)).toBe(
      'Delete 37 messages? You can delete 30 of them. 7 belong to the other person.'
    )
    expect(deleteBody(deleteCounts(picked, 'alice', true), false)).toBe(
      'Delete 37 messages? This cannot be undone.'
    )
    expect(deleteBody(deleteCounts(picked.slice(30), 'alice', false), false)).toBeNull()
    expect(deleteAllBody(4210, 'in #general')).toBe(
      'Delete all 4,210 messages you can delete in #general?'
    )
    expect(deleteAllBody(1, 'in this DM')).toBe('Delete all 1 message you can delete in this DM?')
    expect(deleteAuthorBody(37, 'in #general', false)).toBe(
      'Delete all 37 messages from this person you can delete in #general?'
    )
    expect(deleteAuthorBody(37, 'in #general', true, 2)).toBe(
      'Delete all 37 of your messages in #general? 2 other selected messages are deleted too.'
    )
    expect(deleteAuthorBody(1, 'here', true)).toBe('Delete your 1 message here?')
  })
})

describe('copy and export', () => {
  test('plain text has author and time lines', () => {
    const list = [
      by(1, 'bob', { content: 'hello' }),
      by(2, 'carol', { content: '', media: media({ filename: 'a.png' }) }),
    ]
    expect(plainText(list, ts => `t${ts}`)).toBe(
      'bob (@bob) t1\nhello\n\ncarol (@carol) t2\n\n[a.png]'
    )
  })

  test('the JSON schema of one message', () => {
    const m = by(5, 'bob', { content: 'x', edited_at: 9, reply_to: null })
    expect(exported(m)).toEqual({
      id: 5,
      author: { username: 'bob', display_name: 'bob' },
      created_at: 5,
      edited_at: 9,
      kind: 'user',
      content: 'x',
      reply_to: null,
      thread_root_id: null,
      attachment: null,
      poll: null,
    })
  })
})

describe('shortcuts', () => {
  test('no two shortcuts share keys in one place', () => {
    expect(conflicts()).toEqual([])
    expect(
      conflicts([
        { keys: 'Mod+K', action: 'a', where: 'anywhere' },
        { keys: 'Mod+K', action: 'b', where: 'composer' },
      ]).length
    ).toBe(2)
    expect(SHORTCUTS.some(s => s.keys === 'Mod+Shift+S')).toBe(true)
    const composer = SHORTCUTS.filter(s => s.where === 'composer').map(s => s.keys)
    for (const keys of ['Mod+B', 'Mod+I', 'Mod+E', 'Mod+Shift+X', 'Mod+Shift+H'])
      expect(composer).toContain(keys)
    // Selection mode toggles anywhere, so no composer key may take it.
    expect(composer.includes('Mod+Shift+S')).toBe(false)
  })

  test('keys and labels', () => {
    const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as never
    expect(selectKey(ev('S', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(selectKey(ev('s', { metaKey: true, shiftKey: true }))).toBe(true)
    expect(selectKey(ev('s', { ctrlKey: true }))).toBe(false)
    expect(allKey(ev('a', { ctrlKey: true }))).toBe(true)
    expect(allKey(ev('a', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(shortcutLabel('Mod+Shift+S', true)).toBe('Cmd+Shift+S')
    expect(shortcutLabel('Mod+A', false)).toBe('Ctrl+A')
  })
})

describe('selection store', () => {
  const st = () => useStore.getState()
  const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
  const tick = () => new Promise(r => setTimeout(r, 0))
  type Call = { method: string; url: string; body?: unknown }
  let calls: Call[] = []
  let routes: [RegExp, (body: unknown) => unknown][] = []
  let copied: string[] = []
  const realFetch = globalThis.fetch
  const g = globalThis as { window?: unknown; document?: unknown }
  const real = { window: g.window, document: g.document }
  const general = [by(1, 'alice'), by(2, 'bob'), by(3, 'alice'), by(4, 'carol')]
  const job = (over: Partial<BulkJob> = {}): BulkJob => ({
    id: 7,
    scope: 'c1',
    status: 'running',
    deleted: 0,
    skipped: 0,
    estimate: 40,
    created_at: 1,
    finished_at: null,
    error: null,
    ...over,
  })

  beforeEach(() => {
    calls = []
    routes = []
    copied = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method: init?.method ?? 'GET', url: url.replace(/^https?:\/\/[^/]+/, ''), body })
      const hit = routes.find(([re]) => re.test(url))
      return new Response(JSON.stringify(hit ? hit[1](body) : []), { status: 200 })
    }) as typeof fetch
    Object.assign(globalThis, { localStorage: memoryStorage })
    g.window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
      history: { state: null, pushState: () => {}, replaceState: () => {} },
    }
    g.document = { cookie: '' }
    setSharing({
      copyText: async (text: string) => {
        copied.push(text)
        return true
      },
      canShare: () => false,
      share: async () => 'failed',
      saveFile: () => true,
      saveBlob: () => true,
      openFile: async () => null,
      openBlob: async () => null,
      canPrint: () => false,
      print: async () => false,
    } as Sharing)
    useStore.setState({
      token: 'tok',
      me: me('alice', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
      }),
      guest: false,
      servers: {
        s: serverDetail('s', {
          channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
        }),
      },
      view: { kind: 'channel', server: 's', channelId: 1 },
      messages: { c1: general },
      selection: null,
      selectAnchor: null,
      bulkJobs: {},
      selectionBusy: null,
      confirm: null,
      toast: null,
    })
  })

  afterEach(() => {
    setSharing(webSharing)
    home.ws.stop()
    globalThis.fetch = realFetch
    g.window = real.window
    g.document = real.document
    useStore.setState({ token: null, selection: null, bulkJobs: {}, messages: {} })
  })

  test('Ctrl+click and Shift+click flows enter the mode', () => {
    st().setSelectAnchor('c1', 1)
    st().startSelection('c1')
    st().selectRangeTo('c1', general[2])
    expect(ids(selectedIn(st().selection, general))).toEqual([1, 2, 3])
    st().exitSelection()
    st().toggleSelect('c1', general[3])
    expect(st().selection?.scope).toBe('c1')
    expect(ids(selectedIn(st().selection, general))).toEqual([4])
  })

  test('select all then older rows load selected, with the server estimate', async () => {
    routes.push([/bulk_delete$/, () => ({ total: 4210, deletable: 2000, others: 2210 })])
    st().startSelection('c1', general[0])
    st().selectAllMessages()
    await tick()
    await tick()
    expect(calls[0].body).toEqual({ scope: 'c1', all: true, dry_run: true })
    expect(selectionLabel(st().selection!, general)).toBe('All messages selected (about 4,210)')
    useStore.setState({ messages: { c1: [by(-1, 'zed'), ...general] } })
    expect(isSelected(st().selection, by(-1, 'zed'))).toBe(true)
  })

  test('mixed permissions: the confirm counts and only own ids are sent', async () => {
    routes.push([
      /bulk_delete$/,
      () => ({ total: 2, deletable: 2, others: 0, missing: 0, deleted: 2, ids: [3, 1], job: null }),
    ])
    st().startSelection('c1')
    for (const m of general) st().toggleSelect('c1', m)
    st().askDeleteSelection()
    expect(st().confirm?.body).toBe(
      'Delete 4 messages? You can delete 2 of them. 2 belong to others and need Manage messages.'
    )
    st().confirm?.action('')
    await tick()
    await tick()
    expect(calls[0].body).toEqual({ scope: 'c1', ids: [1, 3] })
    expect(ids(st().messages.c1)).toEqual([2, 4])
    expect(st().selection).toBeNull()
    expect(st().toast?.text).toBe('Deleted 2 messages')
  })

  test('DMs: only your own messages', () => {
    useStore.setState({
      view: { kind: 'dm', dmId: 9 },
      messages: {
        d9: [
          by(1, 'alice', { dm_id: 9, channel_id: null }),
          by(2, 'bob', { dm_id: 9, channel_id: null }),
        ],
      },
    })
    st().startSelection('d9')
    st().toggleSelect('d9', st().messages.d9[1])
    st().askDeleteSelection()
    expect(st().confirm).toBeNull()
    st().toggleSelect('d9', st().messages.d9[0])
    st().askDeleteSelection()
    expect(st().confirm?.body).toBe(
      'Delete 2 messages? You can delete 1 of them. 1 belongs to the other person.'
    )
    expect(selectionActions(st()).some(a => a.id === 'select_author')).toBe(false)
  })

  test('deleting everything starts a job that reports progress', async () => {
    routes.push([
      /bulk_delete$/,
      body =>
        (body as { dry_run?: boolean }).dry_run
          ? { total: 50, deletable: 40, others: 10, upto: 60 }
          : { total: 50, deletable: 40, others: 10, missing: 0, deleted: 0, ids: [], job: job() },
    ])
    st().startSelection('c1')
    st().selectAllMessages()
    st().toggleSelect('c1', general[1])
    await tick()
    st().askDeleteSelection()
    await tick()
    await tick()
    expect(st().confirm?.body).toBe('Delete all 40 messages you can delete in #general?')
    st().confirm?.action('')
    await tick()
    await tick()
    expect(calls.at(-1)?.body).toEqual({ scope: 'c1', all: true, except: [2], before: 61 })
    expect(st().bulkJobs.c1?.status).toBe('running')
    dispatch({
      type: 'messages_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      thread_root_id: null,
      ids: [4, 3],
    } as WsEvent)
    expect(ids(st().messages.c1)).toEqual([1, 2])
    dispatch({ type: 'bulk_delete_progress', username: 'alice', job: job({ deleted: 20 }) })
    expect(st().bulkJobs.c1?.deleted).toBe(20)
    dispatch({
      type: 'bulk_delete_progress',
      username: 'alice',
      job: job({ deleted: 40, status: 'done', finished_at: 2 }),
    })
    expect(st().toast?.text).toBe('Deleted 40 messages')
    routes.push([/jobs\/7$/, () => job({ status: 'cancelled' })])
    await st().cancelBulkJob('c1')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  test('select mine deletes every one of them as a job, like the export', async () => {
    routes.push([
      /bulk_delete$/,
      body =>
        (body as { dry_run?: boolean }).dry_run
          ? { total: 37, deletable: 37, others: 0, upto: 90 }
          : { total: 37, deletable: 37, others: 0, missing: 0, deleted: 0, ids: [], job: job() },
    ])
    st().startSelection('c1')
    st().toggleSelect('c1', general[1])
    st().selectAuthorMessages('alice')
    await tick()
    await tick()
    expect(calls[0].body).toEqual({ scope: 'c1', all: true, dry_run: true, author: 'alice' })
    expect(selectionLabel(st().selection!, general, 'alice')).toBe(
      'All your messages selected (about 38)'
    )
    st().toggleSelect('c1', general[2])
    expect(selectionActions(st()).some(a => a.id === 'delete')).toBe(true)
    st().askDeleteSelection()
    await tick()
    await tick()
    expect(calls.at(-1)?.body).toEqual({
      scope: 'c1',
      all: true,
      author: 'alice',
      except: [3],
      dry_run: true,
    })
    expect(st().confirm?.body).toBe('Delete all 37 of your messages in #general?')
    st().confirm?.action('')
    await tick()
    await tick()
    expect(calls.at(-1)?.body).toEqual({
      scope: 'c1',
      all: true,
      except: [3],
      before: 91,
      author: 'alice',
    })
    expect(calls.filter(c => (c.body as { ids?: number[] })?.ids).length).toBe(0)
    expect(st().bulkJobs.c1?.status).toBe('running')
    expect(st().selection).toBeNull()
  })

  test('a moderator deleting all from an author also deletes the other picks', async () => {
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: true }],
      }),
    })
    routes.push([
      /bulk_delete$/,
      body => {
        const b = body as { dry_run?: boolean; ids?: number[] }
        if (b.ids)
          return {
            total: 1,
            deletable: 1,
            others: 0,
            missing: 0,
            deleted: 1,
            ids: b.ids,
            job: null,
          }
        return b.dry_run
          ? { total: 5, deletable: 5, others: 0, upto: 9 }
          : { total: 5, deletable: 5, others: 0, missing: 0, deleted: 0, ids: [], job: job() }
      },
    ])
    st().startSelection('c1')
    st().toggleSelect('c1', general[3])
    st().selectAuthorMessages('bob')
    await tick()
    st().askDeleteSelection()
    await tick()
    await tick()
    expect(st().confirm?.body).toBe(
      'Delete all 5 messages from this person you can delete in #general? 1 other selected message is deleted too.'
    )
    st().confirm?.action('')
    await tick()
    await tick()
    await tick()
    const bodies = calls.map(c => c.body as Record<string, unknown>)
    expect(bodies.some(b => JSON.stringify(b?.ids) === '[4]')).toBe(true)
    expect(bodies.at(-1)).toEqual({ scope: 'c1', all: true, except: [], before: 10, author: 'bob' })
  })

  test('exports wait and try again when rate limited', async () => {
    exportBackoff.ms = 0
    let limited = 1
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push({ method: 'GET', url })
      if (/bulk_delete/.test(url))
        return new Response(JSON.stringify({ total: 2 }), { status: 200 })
      if (limited-- > 0)
        return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 })
      return new Response(JSON.stringify([by(1, 'alice'), by(2, 'bob'), by(3, 'alice')]), {
        status: 200,
      })
    }) as typeof fetch
    st().startSelection('c1')
    st().selectAuthorMessages('alice')
    await st().exportSelection('json')
    expect(st().toast?.text).toBe('Exported 2 messages')
    exportBackoff.ms = 1000
  })

  test('thread replies decrement the root once', () => {
    const root = by(10, 'bob', { reply_count: 3 })
    useStore.setState({
      messages: {
        c1: [root],
        t10: [by(11, 'alice', { thread_root_id: 10 }), by(12, 'alice', { thread_root_id: 10 })],
      },
    })
    dispatch({
      type: 'messages_deleted',
      server: 's',
      channel_id: 1,
      dm_id: null,
      thread_root_id: 10,
      ids: [11, 12],
    } as WsEvent)
    expect(st().messages.t10).toEqual([])
    expect(st().messages.c1[0].reply_count).toBe(1)
  })

  test('copy text and links, the actions list', async () => {
    st().startSelection('c1')
    st().toggleSelect('c1', general[0])
    st().toggleSelect('c1', general[1])
    st().copySelectionText()
    await tick()
    expect(copied[0]).toContain('alice (@alice)')
    expect(copied[0]).toContain('\n\nbob (@bob)')
    st().copySelectionLinks()
    await tick()
    expect(copied[1].split('\n')).toHaveLength(2)
    const actionIds = selectionActions(st(), user('bob')).map(a => a.id)
    expect(actionIds).toEqual([
      'select_all',
      'clear',
      'delete',
      'copy_text',
      'copy_links',
      'export_text',
      'export_json',
      'select_mine',
      'exit',
    ])
    st().toggleSelect('c1', general[1])
    expect(selectionActions(st()).map(a => a.id)).toContain('forward')
  })
})
