import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resetSessionCaches, useStore } from '../store'
import { HEADER_MORE, HeaderMore } from '../../components/message_pane'
import { me } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  Object.assign(initial, saved)
  resetSessionCaches()
})

const render = () => renderToStaticMarkup(<HeaderMore scope="c1" search />)

describe('header More button', () => {
  test('says whether its own menu is open', () => {
    Object.assign(initial, { me: me('alice'), contextMenu: null })
    expect(render()).toContain('aria-expanded="false"')
    Object.assign(initial, { contextMenu: { x: 0, y: 0, items: [], owner: HEADER_MORE } })
    expect(render()).toContain('aria-expanded="true"')
    Object.assign(initial, { contextMenu: { x: 0, y: 0, items: [] } })
    expect(render()).toContain('aria-expanded="false"')
  })
})
