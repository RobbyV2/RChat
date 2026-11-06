import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { Copy, Trash2 } from 'lucide-react'
import { ctxFor, currentList, paletteCtx, refreshCtx } from '../actions/ctx'
import { menuItems, openActionMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import {
  actionById,
  actionsFor,
  allActions,
  defineAction,
  qualifiedId,
  runAction,
  subscribeActions,
  targetActions,
} from '../actions/registry'
import { confirmThenRun } from '../actions/steps'
import type { Action, Args, Target, Via } from '../actions/types'
import type { PaletteItem } from '../palette'
import { buildSections, flatItems, type ResultCtx } from '../palette_results'
import { closePalette, openPaletteAt, usePaletteUi } from '../palette_store'
import { resetSessionCaches, useStore, type ConfirmRequest } from '../store'
import type { RChatState } from '../store_types'
import { me, member, msg, paged, serverDetail, user } from './fixtures'
import { importsOf, packagesOf } from './import_graph'

afterAll(resetSessionCaches)

const real = (({ askConfirm, openContextMenu }) => ({ askConfirm, openContextMenu }))(
  useStore.getState()
)
const offs: (() => void)[] = []
const def = (a: Action) => offs.push(defineAction(a))
const on = { available: () => true, run: () => {} }
const ctx = (via: Via = 'menu', target: Target = { kind: 'none' }) =>
  ctxFor(useStore.getState(), target, via)
const m5: Target = { kind: 'message', message: msg(5), list: 'c1' }
const openC1 = {
  view: { kind: 'channel' as const, server: 's', channelId: 1 },
  wsStatus: 'green' as const,
}
const quiet = <T>(f: () => T): { out: T; logged: unknown[][] } => {
  const err = console.error
  const logged: unknown[][] = []
  console.error = (...a: unknown[]) => void logged.push(a)
  try {
    return { out: f(), logged }
  } finally {
    console.error = err
  }
}

beforeEach(() => useStore.setState({ messages: {}, members: {}, memberInfo: {} }))

afterEach(() => {
  offs.splice(0).forEach(off => off())
  closePalette()
  useStore.setState({
    ...real,
    me: null,
    contextMenu: null,
    confirm: null,
    toast: null,
    view: null,
    panel: null,
    profile: null,
    servers: {},
    dms: [],
    messages: {},
    newer: {},
    stale: {},
    wsStatus: 'red',
    members: {},
    memberInfo: {},
  })
})

test('defineAction keeps registration order, ignores a duplicate id and unregisters', () => {
  def({ id: 't_a', title: 'A', scope: 'global', ...on })
  def({ id: 't_b', title: 'B', scope: 'global', ...on })
  const { logged } = quiet(() => def({ id: 't_a', title: 'Dup', scope: 'global', ...on }))
  expect(logged).toEqual([['duplicate action', 't_a']])
  expect(
    actionsFor(ctx(), 'global')
      .filter(a => a.id.startsWith('t_'))
      .map(a => a.title)
  ).toEqual(['A', 'B'])
  offs.pop()!()
  expect(actionById('t_a')?.title).toBe('A')
  offs.shift()!()
  expect(actionById('t_a')).toBeUndefined()
  expect(allActions().map(a => a.id)).toEqual(['t_b'])
})

test('a throwing available hides only that action and logs once', () => {
  const { out, logged } = quiet(() => {
    def({
      id: 't_bad',
      title: 'Bad',
      scope: 'global',
      available: () => {
        throw new Error('x')
      },
      run: () => {},
    })
    def({ id: 't_ok', title: 'Ok', scope: 'global', ...on })
    actionsFor(ctx())
    return actionsFor(ctx()).map(a => a.id)
  })
  expect(out).toContain('t_ok')
  expect(out).not.toContain('t_bad')
  expect(logged.length).toBe(1)
})

test('ids are namespaced: built-ins are core.*, and a colliding id is rejected', () => {
  def({ id: 't_a', title: 'A', scope: 'global', ...on })
  expect(qualifiedId('t_a')).toBe('core.t_a')
  expect(qualifiedId('core.t_a')).toBe('core.t_a')
  expect(qualifiedId('notes.t_a')).toBe('notes.t_a')
  expect(actionById('core.t_a')).toBe(actionById('t_a'))
  const { logged } = quiet(() => {
    def({ id: 'core.t_a', title: 'Shadow', scope: 'global', ...on })
    def({ id: 'core.t_new', title: 'Claim', scope: 'global', ...on })
    def({ id: 'notes.t_a', title: 'Notes A', scope: 'global', ...on })
    def({ id: 'notes.t_a', title: 'Notes Dup', scope: 'global', ...on })
    for (const id of ['', '.t_a', 'notes.', 'two words', 'x'.repeat(201)])
      def({ id, title: 'Bad', scope: 'global', ...on })
  })
  expect(logged.map(l => l[0])).toEqual([
    'bad action id',
    'bad action id',
    'duplicate action',
    ...Array(5).fill('bad action id'),
  ])
  expect(actionById('t_a')?.title).toBe('A')
  expect(actionById('t_new')).toBeUndefined()
  expect(actionById('notes.t_a')?.title).toBe('Notes A')
  expect(allActions().map(a => a.id)).toEqual(['t_a', 'notes.t_a'])
})

test('each unregister acts once, on its own registration; a throwing listener costs nothing', () => {
  const a: Action = { id: 't_same', title: 'Same', scope: 'global', ...on }
  const first = defineAction(a)
  offs.push(first)
  first()
  const second = defineAction(a)
  offs.push(second)
  first()
  expect(actionById('t_same')).toBe(a)
  second()
  expect(actionById('t_same')).toBeUndefined()
  offs.push(
    subscribeActions(() => {
      throw new Error('x')
    })
  )
  const { out: third, logged } = quiet(() => defineAction(a))
  offs.push(third)
  expect([actionById('t_same'), logged.length]).toEqual([a, 1])
  quiet(third)
  expect(actionById('t_same')).toBeUndefined()
})

test('menu rows: targets pick the menu; order, disabled, danger, icon; one choice step is a submenu; menu: false stays out', () => {
  const t = { targets: ['message'] as const, scope: 'message' as const }
  def({ id: 't_copy', title: 'Copy', icon: Copy, order: 900, ...t, ...on })
  def({ id: 't_del', title: 'Delete', icon: Trash2, danger: true, order: 510, ...t, ...on })
  def({ id: 't_off', title: 'Off', disabled: () => true, ...t, ...on })
  def({ id: 't_hid', title: 'Hidden', menu: false, ...t, ...on })
  def({ id: 't_glob', title: 'Theme', scope: 'global', ...on })
  def({
    id: 't_lvl',
    title: 'Level',
    ...t,
    ...on,
    args: [
      {
        kind: 'choice',
        name: 'level',
        prompt: 'Level',
        choices: () => [
          { value: 'all', label: 'All', radio: true, checked: true },
          { value: 'none', label: 'Nothing', radio: true, checked: false },
        ],
      },
    ],
  })
  const items = menuItems(ctx('menu', m5))
  expect(items.map(i => i.label)).toEqual(['Off', 'Level', 'Delete', 'Copy'])
  expect(items[0].disabled).toBe(true)
  expect(items[2]).toMatchObject({ danger: true, icon: Trash2 })
  expect(items[1].submenu?.map(i => [i.label, i.radio, i.checked])).toEqual([
    ['All', true, true],
    ['Nothing', true, false],
  ])
  expect(targetActions(ctx('palette', m5)).map(a => a.id)).toContain('t_hid')
})

test('a choice in a submenu runs with its value', async () => {
  const got: Args[] = []
  def({
    id: 't_lvl',
    title: 'Level',
    scope: 'message',
    targets: ['message'],
    available: () => true,
    run: (_c, a) => void got.push(a),
    args: [
      {
        kind: 'choice',
        name: 'level',
        prompt: 'Level',
        choices: () => [{ value: 'all', label: 'All' }],
      },
    ],
  })
  menuItems(ctx('menu', m5))[0].submenu?.[0].action?.()
  await Promise.resolve()
  expect(got).toEqual([{ level: 'all' }])
})

test('a confirm step asks through askConfirm in a menu; menuRun replaces the steps', async () => {
  const asked: ConfirmRequest[] = []
  let ran = 0,
    direct = 0
  useStore.setState({ askConfirm: c => void asked.push(c) })
  def({
    id: 't_leave',
    title: 'Leave',
    danger: true,
    scope: 'server',
    targets: ['message'],
    available: () => true,
    run: () => void ran++,
    args: [
      {
        kind: 'confirm',
        title: 'Leave Server',
        body: () => 'Leave this server?',
        confirm: 'Leave',
      },
    ],
  })
  def({
    id: 't_dlg',
    title: 'Time Out',
    scope: 'member',
    targets: ['message'],
    available: () => true,
    run: () => void ran++,
    menuRun: () => void direct++,
    args: [{ kind: 'text', name: 'why', prompt: 'Why' }],
  })
  const [leave, dlg] = menuItems(ctx('menu', m5))
  leave.action?.()
  expect([asked[0].title, asked[0].body, asked[0].confirm, ran]).toEqual([
    'Leave Server',
    'Leave this server?',
    'Leave',
    0,
  ])
  asked[0].action('')
  await Promise.resolve()
  expect(ran).toBe(1)
  dlg.action?.()
  expect([direct, ran]).toEqual([1, 1])
})

test('a menu row with a text step opens the palette at that step, on its target', async () => {
  const seen: (number | null)[] = []
  def({
    id: 't_note',
    title: 'Note',
    scope: 'message',
    targets: ['message'],
    available: () => true,
    run: (c, a) => void seen.push(c.message?.id ?? null, Number(a.text)),
    args: [{ kind: 'text', name: 'text', prompt: 'A note' }],
  })
  menuItems(ctx('menu', m5))[0].action?.()
  const ui = usePaletteUi.getState()
  expect(ui.open).toBe(true)
  const view = ui.view as { kind: 'arg'; item: PaletteItem }
  expect(view.kind).toBe('arg')
  expect(view.item).toMatchObject({
    id: 't_note',
    action: 't_note',
    arg: { placeholder: 'A note' },
  })
  await view.item.run('7')
  expect(seen).toEqual([5, 7])
})

test('openActionMenu opens nothing when no row is available', () => {
  let opened = 0
  useStore.setState({ openContextMenu: () => void opened++ })
  openActionMenu(10, 10, { kind: 'none' })
  expect(opened).toBe(0)
  def({ id: 't_copy', title: 'Copy', scope: 'message', targets: ['message'], ...on })
  openActionMenu(10, 10, m5)
  expect(opened).toBe(1)
})

test('runAction re-checks on fresh state: a target that is gone runs nothing and says so', async () => {
  useStore.setState({ me: me('alice'), messages: { c1: [msg(5)] }, ...openC1 })
  let ran = 0
  def({
    id: 't_pin',
    title: 'Pin',
    scope: 'message',
    targets: ['message'],
    available: c => c.message !== null,
    run: () => void ran++,
  })
  const c = ctx('menu', m5)
  useStore.setState({ messages: { c1: [] } })
  expect(await runAction('t_pin', c)).toBe(false)
  expect(ran).toBe(0)
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
})

test('a menuRun row re-checks on fresh state: a message deleted before the click runs nothing', () => {
  useStore.setState({ messages: { c1: [msg(4), msg(5), msg(6)] } })
  let direct = 0
  def({
    id: 't_dlg',
    title: 'Time Out',
    scope: 'member',
    targets: ['message'],
    ...on,
    menuRun: () => void direct++,
  })
  const [row] = menuItems(ctx('menu', m5))
  useStore.setState({ messages: { c1: [msg(4), msg(6)] } })
  row.action?.()
  expect(direct).toBe(0)
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
})

test('refreshCtx: fresh message, kept outside the loaded window, gone inside it; a member who left is gone', () => {
  const edited = msg(5, { content: 'edited' })
  useStore.setState({ messages: { c1: [edited] } })
  expect(refreshCtx(ctx('menu', m5))?.message).toBe(edited)
  useStore.setState({ messages: {} })
  expect(refreshCtx(ctx('menu', m5))?.message?.id).toBe(5)
  useStore.setState({ messages: { c1: [] } })
  expect(refreshCtx(ctx('menu', m5))?.message).toBe(m5.message)
  const loaded = Array.from({ length: 200 }, (_, i) => msg(1000 + i))
  useStore.setState({ messages: { c1: loaded } })
  expect(refreshCtx(ctx('menu', m5))?.message).toBe(m5.message)
  const tail: Target = { kind: 'message', message: msg(1300), list: 'c1' }
  expect(refreshCtx(ctx('menu', tail))?.message?.id).toBe(1300)
  const inside: Target = { kind: 'message', message: msg(1100), list: 'c1' }
  useStore.setState({ messages: { c1: loaded.filter(m => m.id !== 1100) } })
  expect(refreshCtx(ctx('menu', inside))).toBeNull()
  const bob: Target = { kind: 'member', user: user('bob'), server: 's', where: 'list' }
  useStore.setState({ members: { s: paged([member('bob')]) } })
  expect(refreshCtx(ctx('menu', bob))?.member?.username).toBe('bob')
  useStore.setState({ members: {}, memberInfo: { s: { bob: null } } })
  expect(refreshCtx(ctx('menu', bob))).toBeNull()
  expect(refreshCtx(ctx('menu', { ...bob, server: null }))?.member?.username).toBe('bob')
})

test('refreshCtx: on the open, caught-up list, a message above its window is gone too', () => {
  const at = (id: number, list = 'c1'): Target => ({ kind: 'message', message: msg(id), list })
  const gone = (t: Target) => refreshCtx(ctx('menu', t)) === null
  useStore.setState({ messages: { c1: [msg(4), msg(5)] }, ...openC1 })
  expect([gone(at(6)), gone(at(3)), gone(at(1e15 + 1))]).toEqual([true, false, false])
  useStore.setState({ messages: { c1: [] } })
  expect(gone(m5)).toBe(true)
  const keptWhen = (over: Partial<RChatState>) => {
    useStore.setState({
      messages: { c1: [msg(4), msg(5)] },
      newer: {},
      stale: {},
      ...openC1,
      ...over,
    })
    return refreshCtx(ctx('menu', at(6)))?.message?.id
  }
  expect([
    keptWhen({ view: { kind: 'channel', server: 's', channelId: 2 } }),
    keptWhen({ view: null }),
    keptWhen({ newer: { c1: { more: true, loading: false } } }),
    keptWhen({ stale: { c1: true } }),
    keptWhen({ wsStatus: 'yellow' }),
  ]).toEqual([6, 6, 6, 6, 6])
  const root = msg(3, { reply_count: 2 })
  useStore.setState({
    ...openC1,
    panel: { kind: 'thread', root },
    messages: { c1: [msg(2)], t3: [msg(7, { thread_root_id: 3 })] },
  })
  expect([gone(at(8, 't3')), gone(at(4))]).toEqual([true, true])
  useStore.setState({ messages: { c1: [msg(2)], t3: [] } })
  expect(refreshCtx(ctx('menu', at(3, 't3')))?.message).toBe(root)
  expect(refreshCtx(ctx('menu', at(3)))?.message).toBe(root)
  useStore.setState({ panel: null, messages: { c1: [msg(2)] } })
  expect([gone(at(3, 't3')), gone(at(3))]).toEqual([true, true])
})

test('refreshCtx: channels, categories and DMs on fresh state, or gone', () => {
  const general = { id: 1, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
  const talk = { id: 2, name: 'Talk', position: 0 }
  const bobDm = { id: 9, other: user('bob'), is_self: false }
  const chan: Target = { kind: 'channel', server: 's', channel: general }
  const cat: Target = { kind: 'category', server: 's', category: talk }
  const dm: Target = { kind: 'dm', dm: bobDm, where: 'sidebar' }
  useStore.setState({ dms: [bobDm] })
  const open = { channel: ctx('menu', chan), category: ctx('menu', cat), dm: ctx('menu', dm) }
  const fresh = () => {
    const c = refreshCtx(open.channel)
    const k = refreshCtx(open.category)
    const d = refreshCtx(open.dm)
    return [
      c && [c.channel?.name, c.target.kind === 'channel' && c.target.channel.name],
      k && k.target.kind === 'category' && k.target.category.name,
      d && [d.dm?.other.username, d.target.kind === 'dm' && d.target.dm.other.username],
    ]
  }
  expect(fresh()).toEqual([['general', 'general'], 'Talk', ['bob', 'bob']])
  useStore.setState({
    servers: {
      s: serverDetail('s', {
        channels: [{ ...general, name: 'renamed' }],
        categories: [{ ...talk, name: 'Chat' }],
      }),
    },
    dms: [{ ...bobDm, other: user('bob', { display_name: 'Bobby' }) }],
  })
  expect(fresh()).toEqual([['renamed', 'renamed'], 'Chat', ['bob', 'bob']])
  expect(refreshCtx(open.dm)?.dm?.other.display_name).toBe('Bobby')
  useStore.setState({ servers: { s: serverDetail('s', { categories: [] }) }, dms: [] })
  expect(fresh()).toEqual([null, null, null])
  useStore.setState({ servers: { s: serverDetail('s') } })
  expect(refreshCtx(open.category)?.target).toBe(cat)
})

test('a gone action or an unavailable one is no longer available', async () => {
  let ok = true
  def({ id: 't_flip', title: 'Flip', scope: 'global', available: () => ok, run: () => {} })
  ok = false
  expect(await runAction('t_flip', ctx('palette'))).toBe(false)
  expect(await runAction('t_missing', ctx('palette'))).toBe(false)
  expect(useStore.getState().toast?.text).toBe("That's no longer available")
})

test('ctxFor resolves the open place, or the place the target names', () => {
  const general = { id: 1, name: 'general', kind: 'text' as const, slowmode_seconds: 0 }
  const bobDm = { id: 9, other: user('bob'), is_self: false }
  useStore.setState({
    servers: { s: serverDetail('s', { channels: [general] }) },
    dms: [bobDm],
    view: { kind: 'channel', server: 's', channelId: 1 },
    profile: { user: user('carol'), server: null, x: 0, y: 0 },
  })
  const open = ctx('palette')
  expect([open.server, open.channel?.id, open.dm, open.list, open.member?.username]).toEqual([
    's',
    1,
    null,
    'c1',
    'carol',
  ])
  expect(paletteCtx(useStore.getState())).toMatchObject({
    via: 'palette',
    target: { kind: 'none' },
  })
  const inDm = ctx('menu', {
    kind: 'message',
    message: msg(3, { channel_id: null, dm_id: 9 }),
    list: 'd9',
  })
  expect([inDm.server, inDm.channel, inDm.dm?.id, inDm.list, inDm.message?.id]).toEqual([
    null,
    null,
    9,
    'd9',
    3,
  ])
  expect(inDm.member?.username).toBe('alice')
  const hook = msg(4, { webhook: { id: 1, embeds: [] } })
  expect(ctx('menu', { kind: 'message', message: hook, list: 'c1' }).member).toBeNull()
  const friend = ctx('menu', { kind: 'member', user: user('dave'), server: null, where: 'friend' })
  expect([friend.server, friend.channel, friend.member?.username]).toEqual([null, null, 'dave'])
  expect(ctx('menu', { kind: 'dm', dm: bobDm, where: 'sidebar' }).dm).toBe(bobDm)
  useStore.setState({ panel: { kind: 'thread', root: msg(3) } })
  expect(currentList(useStore.getState())).toBe('t3')
})

test('palette rows come from the registry, without duplicates', () => {
  def({
    id: 't_theme',
    title: 'Theme',
    label: () => 'Switch to dark theme',
    group: 'settings',
    scope: 'global',
    ...on,
  })
  const row = paletteCommands(ctx('palette')).find(r => r.id === 't_theme')
  expect(row).toMatchObject({ title: 'Switch to dark theme', group: 'settings', action: 't_theme' })
  expect(row?.keywords).toContain('Theme')
  const results: ResultCtx = {
    usage: {},
    now: 1,
    index: null,
    visible: () => true,
    ops: null,
    history: [],
    recents: [],
    mask: t => t,
  }
  const titles = () =>
    flatItems(buildSections(useStore.getState(), '>theme', results))
      .filter(r => r.id === 't_theme')
      .map(r => r.title)
  expect(titles()).toEqual(['Switch to dark theme'])
  def({
    id: 't',
    title: 'Later',
    group: 'settings',
    scope: 'global',
    ...on,
    expand: () => [{ key: 'theme', label: 'Later theme' }],
  })
  expect(titles()).toEqual(['Switch to dark theme'])
})

test('palette rows: one step is the argument, a confirm step asks before the run', async () => {
  const got: Args[] = []
  const asked: ConfirmRequest[] = []
  useStore.setState({ askConfirm: c => void asked.push(c) })
  const g = {
    scope: 'global' as const,
    available: () => true,
    run: (_c: unknown, a: Args) => void got.push(a),
  }
  def({
    id: 't_mute',
    title: 'Mute',
    ...g,
    args: [
      {
        kind: 'choice',
        name: 'for',
        prompt: 'For how long',
        choices: () => [
          { value: '1h', label: 'An hour', subtitle: 'Until 5' },
          { value: 'x', label: 'Off', disabled: true },
        ],
      },
    ],
  })
  def({
    id: 't_name',
    title: 'Rename',
    ...g,
    args: [
      { kind: 'text', name: 'name', prompt: 'New name', check: t => (t ? null : 'Type a name') },
    ],
  })
  def({
    id: 't_go',
    title: 'Go',
    ...g,
    args: [{ kind: 'confirm', title: 'Go?', body: () => 'Really go?', confirm: 'Go' }],
  })
  const rows = Object.fromEntries(paletteCommands(ctx('palette')).map(r => [r.id, r]))
  expect(rows.t_mute.arg).toEqual({
    placeholder: 'For how long',
    choices: [{ value: '1h', label: 'An hour', subtitle: 'Until 5' }],
  })
  expect(rows.t_name.arg?.placeholder).toBe('New name')
  expect([rows.t_name.arg?.check?.(''), rows.t_name.arg?.check?.('x')]).toEqual([
    'Type a name',
    null,
  ])
  expect(rows.t_go.arg).toBeUndefined()
  await rows.t_mute.run('1h')
  await rows.t_name.run('Ann')
  await rows.t_go.run()
  expect(got).toEqual([{ for: '1h' }, { name: 'Ann' }])
  expect([asked.length, asked[0].body]).toEqual([1, 'Really go?'])
  asked[0].action('')
  expect(got).toEqual([{ for: '1h' }, { name: 'Ann' }, {}])
})

test('runtime register and unregister: an open menu and the palette follow the registry', () => {
  let notified = 0
  const stop = subscribeActions(() => void notified++)
  def({ id: 't_copy', title: 'Copy', scope: 'message', targets: ['message'], ...on })
  openActionMenu(4, 8, m5, { header: 'Header' })
  const labels = () => useStore.getState().contextMenu?.items.map(i => i.label)
  const rows = () => paletteCommands(ctx('palette')).map(r => r.id)
  expect(labels()).toEqual(['Copy'])
  const off = defineAction({
    id: 'notes.late',
    title: 'Late',
    scope: 'message',
    targets: ['message'],
    ...on,
  })
  expect(labels()).toEqual(['Copy', 'Late'])
  expect(useStore.getState().contextMenu).toMatchObject({ x: 4, y: 8, header: 'Header' })
  expect(rows()).toContain('notes.late')
  off()
  off()
  expect(labels()).toEqual(['Copy'])
  expect(rows()).not.toContain('notes.late')
  offs.pop()!()
  expect(useStore.getState().contextMenu).toBeNull()
  expect(notified).toBe(4)
  stop()
})

test('an open action menu keeps its state when a registry change leaves its rows alone', () => {
  const msgAction = { scope: 'message' as const, targets: ['message'] as const, ...on }
  def({ id: 't_copy', title: 'Copy', ...msgAction })
  openActionMenu(4, 8, m5)
  const first = useStore.getState().contextMenu
  def({ id: 't_glob', title: 'Theme', scope: 'global', ...on })
  def({ id: 't_hid', title: 'Hidden', menu: false, ...msgAction })
  offs.pop()!()
  expect(useStore.getState().contextMenu).toBe(first)
  def({ id: 't_late', title: 'Late', ...msgAction })
  const second = useStore.getState().contextMenu
  expect([second === first, second?.items.map(i => i.label)]).toEqual([false, ['Copy', 'Late']])
  def({ id: 't_glob2', title: 'Other', scope: 'global', ...on })
  expect(useStore.getState().contextMenu).toBe(second)
  useStore.getState().openContextMenu(2, 2, [{ label: 'Legacy' }])
  const legacy = useStore.getState().contextMenu
  def({ id: 't_later', title: 'Later', ...msgAction })
  expect(useStore.getState().contextMenu).toBe(legacy)
})

test('a throwing label, subtitle, body, parse or choices, and a choice step with nothing to pick', () => {
  const msgAction = { scope: 'message' as const, targets: ['message'] as const, ...on }
  const level = (choices: { value: string; label: string; disabled?: boolean }[]) => ({
    ...msgAction,
    args: [{ kind: 'choice' as const, name: 'level', prompt: 'Level', choices: () => choices }],
  })
  const boom = () => {
    throw new Error('x')
  }
  const asked: ConfirmRequest[] = []
  useStore.setState({ askConfirm: c => void asked.push(c) })
  const { out, logged } = quiet(() => {
    def({
      id: 't_label',
      title: 'Plain',
      label: () => {
        throw new Error('x')
      },
      ...msgAction,
    })
    def({
      id: 't_sub',
      title: 'Sub',
      subtitle: () => {
        throw new Error('x')
      },
      ...msgAction,
    })
    def({ id: 't_none', title: 'None', ...level([]) })
    def({ id: 't_off', title: 'Off', ...level([{ value: 'a', label: 'A', disabled: true }]) })
    def({
      id: 't_two',
      title: 'Two',
      ...level([]),
      args: [...level([]).args, { kind: 'text', name: 'why', prompt: 'Why' }],
    })
    def({ id: 't_ok', title: 'Ok', ...level([{ value: 'a', label: 'A' }]) })
    def({
      id: 't_body',
      title: 'Body',
      ...msgAction,
      args: [{ kind: 'confirm', title: 'Sure?', body: boom, confirm: 'Yes' }],
    })
    def({
      id: 't_parse',
      title: 'Parse',
      scope: 'global',
      ...on,
      args: [{ kind: 'text', name: 'q', prompt: 'Q' }],
      parse: boom,
    })
    def({
      id: 't_choices',
      title: 'Choices',
      ...msgAction,
      args: [{ kind: 'choice', name: 'level', prompt: 'Level', choices: boom }],
    })
    const menu = menuItems(ctx('menu', m5))
    const palette = paletteCommands(ctx('palette', m5)).filter(r => r.id.startsWith('t_'))
    const body = menu.find(i => i.label === 'Body')
    body?.action?.()
    body?.action?.()
    const parse = palette.find(r => r.id === 't_parse')?.parse
    openPaletteAt('t_choices', m5)
    return [
      menu.map(i => i.label),
      palette.map(r => r.title),
      asked.map(c => [c.title, c.body]),
      [parse?.('x'), parse?.('y')],
      usePaletteUi.getState().open,
    ]
  })
  expect(out).toEqual([
    ['Plain', 'Ok', 'Body'],
    ['Plain', 'Ok', 'Body', 'Parse'],
    [
      ['Sure?', ''],
      ['Sure?', ''],
    ],
    [null, null],
    false,
  ])
  expect(logged.map(l => l[1])).toEqual(['t_label', 't_sub', 't_choices', 't_body', 't_parse'])
})

test('an action with more than one value step has no row and never runs short of an argument', async () => {
  const got: Args[] = []
  const asked: ConfirmRequest[] = []
  useStore.setState({ askConfirm: c => void asked.push(c) })
  const steps = {
    scope: 'message' as const,
    targets: ['message'] as const,
    available: () => true,
    run: (_c: unknown, a: Args) => void got.push(a),
  }
  const level = {
    kind: 'choice' as const,
    name: 'level',
    prompt: 'Level',
    choices: () => [{ value: 'a', label: 'A' }],
  }
  const why = { kind: 'text' as const, name: 'why', prompt: 'Why' }
  def({ id: 't_two', title: 'Two', ...steps, args: [level, why] })
  def({ id: 't_dlg', title: 'Dialog', ...steps, args: [level, why], menuRun: () => {} })
  def({
    id: 't_sure',
    title: 'Sure',
    ...steps,
    args: [why, { kind: 'confirm', title: 'Sure?', body: () => '', confirm: 'Yes' }],
  })
  expect(menuItems(ctx('menu', m5)).map(i => i.label)).toEqual(['Dialog', 'Sure'])
  expect(
    paletteCommands(ctx('palette', m5))
      .filter(r => r.id.startsWith('t_'))
      .map(r => r.id)
  ).toEqual(['t_sure'])
  openPaletteAt('t_two', m5)
  expect(usePaletteUi.getState().open).toBe(false)
  const c = ctx('menu', m5)
  await confirmThenRun(actionById('t_two')!, c, { level: 'a' })
  await confirmThenRun(actionById('t_sure')!, c, {})
  expect([got, asked.length]).toEqual([[], 0])
  await confirmThenRun(actionById('t_two')!, c, { level: 'a', why: 'b' })
  expect(got).toEqual([{ level: 'a', why: 'b' }])
})

test('row fields reach menus and the palette: wrap, checked, radio, choice danger and disabled, group, hint, order 500', () => {
  const t = { targets: ['message'] as const, scope: 'message' as const }
  def({ id: 't_late', title: 'Late', order: 501, ...t, ...on })
  def({ id: 't_mid', title: 'Mid', wrap: true, checked: () => true, radio: true, ...t, ...on })
  def({ id: 't_first', title: 'First', order: 499, ...t, ...on })
  def({
    id: 't_pick',
    title: 'Pick',
    order: 502,
    ...t,
    ...on,
    args: [
      {
        kind: 'choice',
        name: 'how',
        prompt: 'How',
        choices: () => [
          { value: 'a', label: 'Wipe', danger: true },
          { value: 'b', label: 'Later', disabled: true },
        ],
      },
    ],
  })
  def({ id: 't_kbd', title: 'Keys', scope: 'global', danger: true, hint: 'Ctrl+K', ...on })
  const items = menuItems(ctx('menu', m5))
  expect(items.map(i => i.label)).toEqual(['First', 'Mid', 'Late', 'Pick'])
  expect(items[1]).toMatchObject({ wrap: true, checked: true, radio: true })
  expect(items[3].submenu?.map(i => [i.label, i.danger, i.disabled])).toEqual([
    ['Wipe', true, undefined],
    ['Later', undefined, true],
  ])
  expect(paletteCommands(ctx('palette')).find(r => r.id === 't_kbd')).toMatchObject({
    group: 'commands',
    danger: true,
    hint: 'Ctrl+K',
  })
})

test('dangerFor decides a row danger in menus and the palette; a throwing one keeps danger', () => {
  let risky = false
  const t = { targets: ['message'] as const, scope: 'message' as const, danger: true }
  def({ id: 't_flag', title: 'Flag', dangerFor: () => risky, ...t, ...on })
  def({
    id: 't_throw',
    title: 'Throw',
    dangerFor: () => {
      throw new Error('x')
    },
    ...t,
    ...on,
  })
  const rows = () =>
    quiet(() => [
      menuItems(ctx('menu', m5)).map(i => i.danger),
      paletteCommands(ctx('palette', m5))
        .filter(r => r.id.startsWith('t_'))
        .map(r => r.danger),
    ])
  const first = rows()
  expect(first.out).toEqual([
    [false, true],
    [false, true],
  ])
  expect(first.logged.map(l => l[1])).toEqual(['t_throw'])
  risky = true
  expect(rows().out).toEqual([
    [true, true],
    [true, true],
  ])
})

test('an open action menu rebuilds when a registry change swaps a row and keeps the count', () => {
  const msgAction = { scope: 'message' as const, targets: ['message'] as const, run: () => {} }
  let swapped = false
  def({ id: 't_a', title: 'Before', available: () => !swapped, ...msgAction })
  def({ id: 't_b', title: 'After', available: () => swapped, ...msgAction })
  openActionMenu(4, 8, m5)
  expect(useStore.getState().contextMenu?.items.map(i => i.label)).toEqual(['Before'])
  swapped = true
  def({ id: 't_glob', title: 'Theme', scope: 'global', ...on })
  expect(useStore.getState().contextMenu?.items.map(i => i.label)).toEqual(['After'])
})

test('parse needs a value step: without one the row offers no parsed text', () => {
  def({ id: 't_p', title: 'Shout', scope: 'global', ...on, parse: (text: string) => text })
  expect(paletteCommands(ctx('palette')).find(r => r.id === 't_p')?.parse).toBeUndefined()
})

test('the registry loads without the store, zustand or React', () => {
  for (const entry of ['registry.ts', 'types.ts']) {
    const path = `apps/web/app/lib/actions/${entry}`
    const files = [...importsOf(path)].filter(
      p => p.endsWith('/store.ts') || p.includes('/slices/')
    )
    const packages = [...packagesOf(path)].filter(p => /^(react|zustand)(\/|$)/.test(p))
    expect([entry, files, packages]).toEqual([entry, [], []])
  }
})
