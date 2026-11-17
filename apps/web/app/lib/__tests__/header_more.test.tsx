import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Pin, Search, SquareCheckBig } from 'lucide-react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { isActionMenu, menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { resetSessionCaches, useStore, type ContextMenuItem } from '../store'
import type { RChatState } from '../store_types'
import { HEADER_MORE, HeaderMore } from '../../components/message_pane'
import { drain, me, msg } from './fixtures'

// Server rendering reads the store's initial state, and a click reads the current one, so the
// test state goes into both.
const initial = useStore.getInitialState()
const saved = { ...initial }
const current = useStore.getState()

const put = (state: Partial<RChatState>) => {
  Object.assign(initial, state)
  useStore.setState(state)
}

beforeAll(registerAppActions)

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(current, true)
  resetSessionCaches()
})

const render = () => renderToStaticMarkup(<HeaderMore scope="c1" search />)

type Button = ReactElement<{ onClick(e: unknown): void }> | null

// Renders the button and clicks it where it sits.
function Pressed({ scope, search }: { scope: string | null; search: boolean }) {
  const button = HeaderMore({ scope, search }) as Button
  button?.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ right: 300, bottom: 40 }) },
  })
  return button
}

// The menu the button opens, or what it renders when there is none.
const press = (scope: string | null, search: boolean) => {
  put({ contextMenu: null })
  const html = renderToStaticMarkup(<Pressed scope={scope} search={search} />)
  return { html, menu: useStore.getState().contextMenu }
}

const shape = (i: ContextMenuItem) => [
  i.label,
  i.icon ?? null,
  i.subtitle ?? null,
  !!i.wrap,
  !!i.danger,
  !!i.disabled,
  i.submenu?.length ?? 0,
]

const row = (label: string, icon: typeof Pin) => [label, icon, null, false, false, false, 0]
const SELECT = row('Select Messages', SquareCheckBig)
const PINS = row('Pinned Messages', Pin)
const SEARCH = row('Search', Search)

const signedIn = () => put({ token: 'tok', me: me('alice'), guest: false })
const asGuest = () => put({ token: null, me: null, guest: true })

describe('header More button', () => {
  test('says whether its own menu is open', () => {
    Object.assign(initial, { me: me('alice'), contextMenu: null })
    expect(render()).toContain('aria-expanded="false"')
    Object.assign(initial, { contextMenu: { x: 0, y: 0, items: [], owner: HEADER_MORE } })
    expect(render()).toContain('aria-expanded="true"')
    Object.assign(initial, { contextMenu: { x: 0, y: 0, items: [] } })
    expect(render()).toContain('aria-expanded="false"')
  })

  test('lists what a narrow header folds away, for an account and for a guest', () => {
    signedIn()
    expect(press('c1', true).menu?.items.map(shape)).toEqual([SELECT, PINS, SEARCH])
    expect(press('d3', false).menu?.items.map(shape)).toEqual([SELECT, PINS])
    expect(press(null, true).menu?.items.map(shape)).toEqual([SEARCH])
    asGuest()
    expect(press('c1', true).menu?.items.map(shape)).toEqual([PINS, SEARCH])
    expect(press('d3', false).menu?.items.map(shape)).toEqual([PINS])
    put({ token: null, me: null, guest: false })
    expect(press('c1', true).menu?.items.map(shape)).toEqual([PINS, SEARCH])
  })

  test('is not there when nothing folds away', () => {
    for (const as of [signedIn, asGuest]) {
      as()
      expect(press(null, false)).toEqual({ html: '', menu: null })
    }
  })

  test('opens under its right edge, named as its own, with no header row', () => {
    signedIn()
    const { html, menu } = press('c1', true)
    expect(html).toContain('title="More"')
    expect(html).toContain('aria-label="More"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(menu && [menu.x, menu.y, menu.owner, menu.header]).toEqual([
      300,
      44,
      HEADER_MORE,
      undefined,
    ])
  })

  test('its rows select in the header conversation, open the pins and open search', async () => {
    const calls: unknown[][] = []
    signedIn()
    put({
      view: { kind: 'channel', server: 's', channelId: 1 },
      panel: { kind: 'thread', root: msg(7) },
      startSelection: (...a: unknown[]) => void calls.push(['select', ...a]),
      openPins: (...a: unknown[]) => void calls.push(['pins', ...a]),
      openSearch: (...a: unknown[]) => void calls.push(['search', ...a]),
    } as Partial<RChatState>)
    const items = press('c1', true).menu?.items ?? []
    for (const item of items) {
      item.action?.()
      await drain()
    }
    expect(calls).toEqual([['select', 'c1'], ['pins'], ['search']])
  })

  test('its menu is the registry menu of the header, and its rows stay out of the palette', () => {
    signedIn()
    put({ view: { kind: 'channel', server: 's', channelId: 1 } })
    expect(isActionMenu(press('c1', true).menu)).toBe(true)
    const rows = (list: string | null, search: boolean) =>
      menuItems(ctxFor(useStore.getState(), { kind: 'header', list, search }, 'menu')).map(shape)
    expect(rows('c1', true)).toEqual([SELECT, PINS, SEARCH])
    expect(rows(null, false)).toEqual([])
    const palette = paletteCommands(paletteCtx(useStore.getState())).map(c => c.id)
    expect(palette.length).toBeGreaterThan(20)
    expect(palette.filter(id => id.startsWith('header_'))).toEqual([])
  })
})
