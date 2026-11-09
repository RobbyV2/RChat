import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { itemFor, menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { actionById } from '../actions/registry'
import type { Target } from '../actions/types'
import { FOLDER_PRESETS } from '../folder_colors'
import { emptyLayout, type Folder, type Layout } from '../nav_layout'
import { useP2p } from '../p2p/app'
import { resetSessionCaches, useStore } from '../store'
import type { ContextMenuItem } from '../store_types'
import { me, memoryStorage } from './fixtures'

afterAll(resetSessionCaches)
beforeAll(registerAppActions)

const st = () => useStore.getState()
const storage = new Map<string, string>()
const saved = (key: string): Layout | null => {
  const raw = storage.get(key)
  return raw ? (JSON.parse(raw) as Layout) : null
}
const F = (id: string, over: Partial<Folder> = {}): Folder => ({
  id,
  name: null,
  servers: ['a', 'b'],
  open: false,
  ...over,
})
const ROOMS = ['A'.repeat(43), 'B'.repeat(43)]
const real = (({ openDialog, showToast }) => ({ openDialog, showToast }))(st())
const p2pReal = useP2p.getState()

const folder = (id = 'f1') =>
  st().layout.servers.find((e): e is Folder => typeof e !== 'string' && e.id === id)
const p2pFolder = (id = 'p1') =>
  useP2p.getState().layout.servers.find((e): e is Folder => typeof e !== 'string' && e.id === id)
const target = (f: Folder | undefined, p2p = false): Target => ({
  kind: 'folder',
  folder: f as Folder,
  ...(p2p ? { p2p: true } : {}),
})
const row = (t: Target) => itemFor('folder_color', ctxFor(st(), t, 'menu'))
const choices = (t: Target) => row(t)?.submenu ?? []
const pick = (t: Target, label: string) => {
  const item = choices(t).find(c => c.label === label)
  if (!item?.action) throw new Error(`no ${label} row`)
  item.action()
}
const settle = () => new Promise(r => setTimeout(r, 0))
const shape = (c: ContextMenuItem) => [c.label, c.swatch ?? null, c.checked ?? null]

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({
    me: me('alice'),
    guest: false,
    toast: null,
    activeDialog: null,
    layout: { ...emptyLayout, servers: ['x', F('f1'), 'c'] },
  })
  useP2p.setState({
    account: 'alice',
    dialog: null,
    layout: { ...emptyLayout, servers: [F('p1', { servers: ROOMS })] },
  })
})

afterEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
  useStore.setState({ ...real, me: null, layout: emptyLayout, toast: null, activeDialog: null })
  useP2p.setState({ account: p2pReal.account, dialog: null, layout: emptyLayout })
})

describe('the folder color action', () => {
  test('is a registry action that joins folder menus and not the plain palette', () => {
    const a = actionById('folder_color')
    expect(a?.title).toBe('Folder color')
    expect(a?.targets).toEqual(['folder'])
    const labels = menuItems(ctxFor(st(), target(folder()), 'menu')).map(i => i.label)
    expect(labels).toContain('Folder color')
    expect(paletteCommands(paletteCtx(st())).some(c => c.id === 'folder_color')).toBe(false)
  })

  test('offers the swatches, a custom color and the default, with the default checked', () => {
    const item = row(target(folder()))
    expect(item?.label).toBe('Folder color')
    expect(choices(target(folder())).map(shape)).toEqual([
      ...FOLDER_PRESETS.map(p => [p.label, p.color, false]),
      ['Custom color', null, false],
      ['Default', null, true],
    ])
    for (const c of choices(target(folder()))) expect(c.radio).toBe(true)
  })

  test('picking a swatch colors the folder, saves it and checks that swatch', async () => {
    pick(target(folder()), 'Blue')
    await settle()
    expect(folder()).toEqual(F('f1', { color: '#3b82d9' }))
    expect(saved('rchat_layout:alice')?.servers[1]).toEqual(F('f1', { color: '#3b82d9' }))
    const now = choices(target(folder())).filter(c => c.checked)
    expect(now.map(c => c.label)).toEqual(['Blue'])
    expect(useP2p.getState().layout.servers).toEqual([F('p1', { servers: ROOMS })])
  })

  test('default clears the color', async () => {
    useStore.setState({ layout: { ...emptyLayout, servers: [F('f1', { color: '#d9483b' })] } })
    expect(
      choices(target(folder()))
        .filter(c => c.checked)
        .map(c => c.label)
    ).toEqual(['Red'])
    pick(target(folder()), 'Default')
    await settle()
    expect(folder()).toEqual(F('f1'))
  })

  test('a color that is not a swatch shows on the custom row', () => {
    useStore.setState({ layout: { ...emptyLayout, servers: [F('f1', { color: '#123456' })] } })
    expect(
      choices(target(folder()))
        .filter(c => c.checked)
        .map(shape)
    ).toEqual([['Custom color', '#123456', true]])
  })

  test('custom color opens the folder dialog and changes nothing yet', async () => {
    pick(target(folder()), 'Custom color')
    await settle()
    expect(st().activeDialog).toEqual({ kind: 'rename_folder', id: 'f1', focus: 'color' })
    expect(folder()).toEqual(F('f1'))
  })

  test('the menu row uses the folder as it is now, not as it was when the menu opened', async () => {
    const stale = target(folder())
    st().setFolderColor('f1', '#3f9b5b')
    expect(
      choices(stale)
        .filter(c => c.checked)
        .map(c => c.label)
    ).toEqual(['Green'])
  })

  test('a folder that is gone has no row, and an open row says so', async () => {
    const t = target(folder())
    const open = choices(t).find(c => c.label === 'Pink')
    st().ungroupFolder('f1')
    expect(row(t)).toBeNull()
    open?.action?.()
    await settle()
    expect(st().toast?.text).toBe("That's no longer available")
    expect(st().layout.servers).toEqual(['x', 'a', 'b', 'c'])
  })

  test('a P2P folder is colored in the P2P rail only', async () => {
    const t = target(p2pFolder(), true)
    expect(
      choices(t)
        .filter(c => c.checked)
        .map(c => c.label)
    ).toEqual(['Default'])
    pick(t, 'Teal')
    await settle()
    expect(p2pFolder()).toEqual(F('p1', { servers: ROOMS, color: '#2a9d9a' }))
    expect(saved('rchat_p2p_layout:alice')?.servers).toEqual([
      F('p1', { servers: ROOMS, color: '#2a9d9a' }),
    ])
    expect(folder()).toEqual(F('f1'))
    expect(storage.has('rchat_layout:alice')).toBe(false)
    pick(target(p2pFolder(), true), 'Custom color')
    await settle()
    expect(useP2p.getState().dialog).toEqual({ kind: 'p2p_folder', id: 'p1', focus: 'color' })
    expect(st().activeDialog).toBeNull()
    pick(target(p2pFolder(), true), 'Default')
    await settle()
    expect(p2pFolder()).toEqual(F('p1', { servers: ROOMS }))
  })

  test('an instance folder id is not looked up in the P2P rail, or the other way round', () => {
    expect(row(target(folder(), true))).toBeNull()
    expect(row(target(p2pFolder(), false))).toBeNull()
  })
})
