import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, Users } from 'lucide-react'
import { PageRow, SettingsPage, type PageSection } from '../../components/settings_page'
import { layerCovered } from '../escape_layers'
import {
  focusesSearch,
  navKey,
  pageEscape,
  rowAnchor,
  shownSection,
  tabWrap,
} from '../settings_page'
import type { RChatState } from '../store_types'

test('the nav keys move through the sections and stop at the ends', () => {
  expect(navKey('ArrowDown', 0, 3)).toBe(1)
  expect(navKey('ArrowDown', 2, 3)).toBe(2)
  expect(navKey('ArrowUp', 0, 3)).toBe(0)
  expect(navKey('ArrowUp', 2, 3)).toBe(1)
  expect(navKey('Home', 2, 3)).toBe(0)
  expect(navKey('End', 0, 3)).toBe(2)
  expect(navKey('a', 0, 3)).toBeNull()
  expect(navKey('ArrowDown', 0, 0)).toBeNull()
})

test('a slash focuses search, except while typing or with a modifier', () => {
  const key = { key: '/', ctrlKey: false, metaKey: false, altKey: false }
  expect(focusesSearch(key, { tag: 'BODY', editable: false })).toBe(true)
  expect(focusesSearch(key, { tag: 'BUTTON', editable: false })).toBe(true)
  expect(focusesSearch(key, { tag: 'INPUT', editable: false })).toBe(false)
  expect(focusesSearch(key, { tag: 'TEXTAREA', editable: false })).toBe(false)
  expect(focusesSearch(key, { tag: 'SELECT', editable: false })).toBe(false)
  expect(focusesSearch(key, { tag: 'DIV', editable: true })).toBe(false)
  expect(focusesSearch({ ...key, ctrlKey: true }, { tag: 'BODY', editable: false })).toBe(false)
  expect(focusesSearch({ ...key, key: 'a' }, { tag: 'BODY', editable: false })).toBe(false)
})

test('Tab wraps at the ends of the page and brings focus in from outside it', () => {
  expect(tabWrap(-1, 4, false)).toBe(0)
  expect(tabWrap(-1, 4, true)).toBe(3)
  expect(tabWrap(3, 4, false)).toBe(0)
  expect(tabWrap(0, 4, true)).toBe(3)
  expect(tabWrap(1, 4, false)).toBeNull()
  expect(tabWrap(2, 4, true)).toBeNull()
  expect(tabWrap(-1, 0, false)).toBeNull()
})

test('Esc clears a search first and closes the page once the search is empty', () => {
  expect(pageEscape('join')).toBe('clear')
  expect(pageEscape(' ')).toBe('clear')
  expect(pageEscape('')).toBe('close')
})

// The app with nothing open over it; the layers read only these.
const open = {
  contextMenu: null,
  confirm: null,
  activeDialog: null,
  profile: null,
  invite: null,
  panel: null,
} as unknown as RChatState

test('Esc reaches the page only while nothing is open above it', () => {
  const modal = () => true
  expect(layerCovered('page', open, modal)).toBe(false)
  for (const above of [
    { activeDialog: { kind: 'ban_confirm', username: 'bob' } },
    { confirm: { title: 'Delete', body: '', confirm: 'Delete', action: () => {} } },
    { contextMenu: { x: 0, y: 0, items: [] } },
    { profile: { username: 'bob', x: 0, y: 0 } },
  ])
    expect(layerCovered('page', { ...open, ...above } as RChatState, modal)).toBe(true)
})

test('the other layers keep their order around the page', () => {
  const dialog = { ...open, activeDialog: { kind: 'ban_confirm', username: 'bob' } } as RChatState
  expect(layerCovered('dialog', dialog, () => true)).toBe(false)
  expect(layerCovered('confirm', dialog, () => true)).toBe(false)
  expect(layerCovered('panel', open, () => true)).toBe(true)
  expect(layerCovered('panel', open, () => false)).toBe(false)
  expect(
    layerCovered('stage', { ...open, panel: { kind: 'friends' } } as RChatState, () => false)
  ).toBe(true)
})

test('the shown section is the asked one, or the first when it is missing or unknown', () => {
  const sections = [{ id: 'a' }, { id: 'b' }]
  expect(shownSection(sections, 'b')).toBe('b')
  expect(shownSection(sections, null)).toBe('a')
  expect(shownSection(sections, 'zzz')).toBe('a')
  expect(shownSection([], null)).toBeNull()
})

test('a row anchor is a stable element id', () => {
  expect(rowAnchor('server_joining')).toBe('row-server_joining')
})

const sections: PageSection[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings,
    rows: [{ section: 'general', id: 'name', label: 'Name', line: 'What it is called.' }],
    render: () => (
      <PageRow id="name">
        <p>General body</p>
      </PageRow>
    ),
  },
  { id: 'people', label: 'People', icon: Users, render: () => <p>People body</p> },
]

const page = (active: string | null) =>
  renderToStaticMarkup(
    <SettingsPage
      title="Demo settings"
      sections={sections}
      active={active}
      onSection={() => {}}
      onClose={() => {}}
    />
  )

test('the page names itself, lists every section and marks the open one', () => {
  const html = page('people')
  expect(html).toContain('Demo settings')
  expect(html).toContain('People body')
  expect(html).not.toContain('General body')
  expect(/aria-current="page"[^>]*>(<svg[^>]*>.*?<\/svg>)?<span[^>]*>People/.test(html)).toBe(true)
  expect(html.match(/aria-current="page"/g)).toHaveLength(1)
})

test('without a section the first one shows on wide screens and the list on narrow ones', () => {
  const html = page(null)
  expect(html).toContain('General body')
  expect(html).toContain('id="row-name"')
  expect(html).toContain('data-screen="list"')
  expect(page('general')).toContain('data-screen="section"')
})

test('the page can take focus itself when none of its controls shows', () => {
  expect(/<div[^>]*role="dialog"[^>]*tabindex="-1"/.test(page('general'))).toBe(true)
})

test('every icon-only control has a title and a name', () => {
  const html = page('general')
  for (const button of html.match(/<button[^>]*>/g) ?? []) {
    if (!button.includes('data-icon-only')) continue
    expect(button).toContain('title=')
    expect(button).toContain('aria-label=')
  }
  expect(html).toContain('aria-label="Close"')
  expect(html).toContain('aria-label="Search settings"')
})
