import { afterEach, expect, test } from 'bun:test'
import { openActionMenu, openChoiceMenu } from '../actions/menu'
import { defineAction } from '../actions/registry'
import { resetSessionCaches, useStore } from '../store'
import type { RChatState } from '../store_types'
import { me } from './fixtures'

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
  resetSessionCaches()
})

test('a menu opens only with the rows the registry gives for a target', () => {
  useStore.setState({ me: me('alice'), contextMenu: null })
  openActionMenu(1, 2, { kind: 'none' })
  expect(useStore.getState().contextMenu).toBeNull()
  offs.push(
    defineAction({
      id: 'test_menu_ownership',
      title: 'Owned',
      scope: 'global',
      targets: ['none'],
      available: () => true,
      run: () => {},
    })
  )
  openActionMenu(1, 2, { kind: 'none' }, { owner: 'test' })
  const menu = useStore.getState().contextMenu
  expect([menu?.x, menu?.y, menu?.owner, menu?.items.map(i => i.label)]).toEqual([
    1,
    2,
    'test',
    ['Owned'],
  ])
  useStore.getState().closeContextMenu()
  openChoiceMenu(1, 2, 'test_menu_ownership', { kind: 'none' })
  expect(useStore.getState().contextMenu).toBeNull()
})

// Checked by the compiler: the store has no opener, and takes no menu written by hand.
test('nothing else can put a menu on screen', () => {
  const refused = (state: RChatState, set: (next: Partial<RChatState>) => void) => {
    // @ts-expect-error the store has no opener
    state.openContextMenu(0, 0, [{ label: 'A' }])
    // @ts-expect-error a menu written by hand is not an open menu
    set({ contextMenu: { x: 0, y: 0, items: [{ label: 'A' }] } })
    // @ts-expect-error nor with an owner
    set({ contextMenu: { x: 0, y: 0, items: [], owner: 'x' } })
    set({ contextMenu: null })
    set({ contextMenu: state.contextMenu })
  }
  expect(typeof refused).toBe('function')
})
