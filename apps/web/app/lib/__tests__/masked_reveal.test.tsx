import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ctxFor, paletteCtx, refreshCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { REVEAL_ACTION, revealMasked } from '../actions/masked'
import { menuItems, openActionMenu } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import type { Target } from '../actions/types'
import {
  actionElement,
  hiddenOnScreen,
  hiddenWords,
  revealWords,
  withActionElement,
} from '../masked_reveal'
import { hasMasked, type PaletteItem } from '../palette'
import { resetSessionCaches, useStore } from '../store'
import { longPress } from '../../components/context_menu'
import { msg } from './fixtures'

// Stand-ins for a row element and the masked words inside it; `palette`: the words are in the
// palette.
const words = (n: number, palette = false) => {
  const fired: string[] = []
  const list = Array.from({ length: n }, () => ({
    dispatchEvent: (e: Event) => fired.push(e.type),
    closest: (q: string) => (palette && q === '[data-palette]' ? {} : null),
  }))
  const row = {
    isConnected: true,
    querySelectorAll: (q: string) => (q === '[data-masked-word]' ? list : []),
  }
  return {
    fired,
    list,
    row: row as unknown as Element,
    detach: () => void (row.isConnected = false),
  }
}

const labels = () => useStore.getState().contextMenu?.items.map(i => i.label) ?? []
const click = (label: string) =>
  useStore
    .getState()
    .contextMenu?.items.find(i => i.label === label)
    ?.action?.()
const SHOW = 'Show masked text'
const m5: Target = { kind: 'message', message: msg(5), list: 'c1' }

const rightClick = (row: Element, open: (x: number, y: number) => void) =>
  longPress(open).onContextMenu({
    nativeEvent: new Event('contextmenu'),
    currentTarget: row,
    preventDefault: () => {},
    clientX: 3,
    clientY: 4,
  } as never)

const onScreen = <T,>(list: unknown[], f: () => T): T => {
  const g = globalThis as { document?: unknown }
  const had = Object.hasOwn(g, 'document')
  const before = g.document
  g.document = { querySelectorAll: (q: string) => (q === '[data-masked-word]' ? list : []) }
  try {
    return f()
  } finally {
    if (had) g.document = before
    else delete g.document
  }
}

beforeAll(registerAppActions)
afterAll(resetSessionCaches)
afterEach(() => useStore.setState({ contextMenu: null }))

describe('Show masked text is a registry action', () => {
  test("right-click on a row with masked words offers it once in the row's menu; it reveals them", () => {
    const { fired, row } = words(2)
    rightClick(row, (x, y) => openActionMenu(x, y, m5))
    expect(labels().filter(l => l === SHOW).length).toBe(1)
    click(SHOW)
    expect(fired).toEqual(['rchat-reveal', 'rchat-reveal'])
    const rows = withActionElement(row, () => menuItems(ctxFor(useStore.getState(), m5, 'menu')))
    expect(rows.map(i => i.label)).toContain(SHOW)
  })

  test('every row kind with a registry menu offers it, P2P contacts too', () => {
    const { row } = words(1)
    const c = { ik: 'k', name: 'shit', petname: null, state: 'mutual', certs: [], intros: [] }
    const target: Target = { kind: 'p2p_contact', c: c as never, me: null }
    const rows = withActionElement(row, () =>
      menuItems(ctxFor(useStore.getState(), target, 'menu'))
    )
    expect(rows.map(i => i.label)).toContain(SHOW)
  })

  test('not for a row without masked words, nor in a menu opened from a button', () => {
    rightClick(words(0).row, (x, y) => openActionMenu(x, y, m5))
    expect(labels()).not.toContain(SHOW)
    rightClick(words(2).row, () => {})
    openActionMenu(1, 2, m5)
    expect(labels()).not.toContain(SHOW)
  })

  test('a row that left the page while its menu was open is not acted on', () => {
    const { fired, row, detach } = words(1)
    rightClick(row, (x, y) => openActionMenu(x, y, m5))
    expect(labels()).toContain(SHOW)
    detach()
    const ctx = withActionElement(row, () => ctxFor(useStore.getState(), m5, 'menu'))
    expect(refreshCtx(ctx)?.element).toBeUndefined()
    click(SHOW)
    expect(fired).toEqual([])
  })

  test('menus built by hand get it through the registry item helper', () => {
    const { fired, row } = words(1)
    const reply = { label: 'Reply', action: () => {} }
    rightClick(row, (x, y) => useStore.getState().openContextMenu(x, y, [reply]))
    expect(labels()).toEqual(['Reply', SHOW])
    click(SHOW)
    expect(fired).toEqual(['rchat-reveal'])
    withActionElement(row, () => useStore.getState().openContextMenu(1, 2, [reply]))
    expect(labels()).toEqual(['Reply'])
  })

  test('the element lasts while the menu opens, and its contexts keep it when refreshed', () => {
    const { row } = words(1)
    const seen: (Element | null)[] = []
    rightClick(row, () => void seen.push(actionElement()))
    expect(seen).toEqual([row])
    expect(actionElement()).toBe(null)
    const ctx = withActionElement(row, () => ctxFor(useStore.getState(), m5, 'menu'))
    expect(ctx.element).toBe(row)
    expect(refreshCtx(ctx)?.element).toBe(row)
    expect('element' in ctxFor(useStore.getState(), m5, 'menu')).toBe(false)
  })

  test('the palette lists it while masked words show outside the palette, and reveals those', () => {
    const outside = words(2)
    const inside = words(1, true)
    const all = [...outside.list, ...inside.list]
    const row = onScreen(all, () =>
      paletteCommands(paletteCtx(useStore.getState())).find(c => c.id === REVEAL_ACTION)
    )
    expect(row?.title).toBe(SHOW)
    onScreen(all, () => row?.run())
    expect(outside.fired).toEqual(['rchat-reveal', 'rchat-reveal'])
    expect(inside.fired).toEqual([])
    expect(onScreen(inside.list, () => hiddenOnScreen().length)).toBe(0)
    const none = onScreen([], () => paletteCommands(paletteCtx(useStore.getState())))
    expect(none.some(c => c.id === REVEAL_ACTION)).toBe(false)
  })

  test("Alt+Enter in the palette runs it on the active option, quietly when there's nothing", () => {
    const toasts: string[] = []
    const showToast = useStore.getState().showToast
    useStore.setState({ showToast: t => void toasts.push(t) })
    try {
      const { fired, row } = words(2)
      expect(revealMasked(row)).toBe(true)
      expect(fired.length).toBe(2)
      expect(revealMasked(words(0).row)).toBe(false)
      expect(revealMasked(null)).toBe(false)
      expect(toasts).toEqual([])
    } finally {
      useStore.setState({ showToast })
    }
  })

  test('the helpers find and reveal the words', () => {
    const { fired, row } = words(3)
    expect(hiddenWords(row).length).toBe(3)
    expect(hiddenWords(null)).toEqual([])
    revealWords(hiddenWords(row))
    expect(fired.length).toBe(3)
    expect(hiddenOnScreen()).toEqual([])
  })
})

describe('the palette', () => {
  const mask = (t: string) => t.replace(/shit/g, '****')
  const item = (over: Partial<PaletteItem>): PaletteItem => ({
    id: 'x',
    title: 'shit club',
    group: 'navigation',
    run: () => {},
    ...over,
  })

  test('knows when the active option shows masked text', () => {
    expect(hasMasked(item({ name: true }), mask)).toBe(true)
    expect(hasMasked(item({ name: true, own: true }), mask)).toBe(false)
    expect(hasMasked(item({}), mask)).toBe(false)
    expect(hasMasked(item({ title: 'club', name: true }), mask)).toBe(false)
    expect(hasMasked(item({ title: 'a', subtitle: 'shit', subtitleName: true }), mask)).toBe(true)
    expect(hasMasked(undefined, mask)).toBe(false)
  })
})
