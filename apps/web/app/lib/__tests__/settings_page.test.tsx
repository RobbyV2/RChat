import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Settings, Users } from 'lucide-react'
import { PageRow, SettingsPage, type PageSection } from '../../components/settings_page'
import { layerCovered } from '../escape_layers'
import {
  currentEntry,
  focusesSearch,
  keptSections,
  navKey,
  navRuns,
  openSection,
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

test('the nav runs open at each new group and keep ungrouped entries in the run before', () => {
  const runs = navRuns([
    { id: 'a' },
    { id: 'b', group: 'You' },
    { id: 'c', group: 'You' },
    { id: 'd' },
    { id: 'e', group: 'App' },
  ])
  expect(runs.map(r => [r.heading, r.entries.map(e => e.id)])).toEqual([
    [undefined, ['a']],
    ['You', ['b', 'c', 'd']],
    ['App', ['e']],
  ])
  expect(navRuns([])).toEqual([])
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
  expect(/aria-current="page"[^>]*>(<svg[^>]*>.*?<\/svg>)?(<span[^>]*>)+People/.test(html)).toBe(
    true
  )
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

const grouped: PageSection[] = [
  {
    id: 'one',
    label: 'One',
    icon: Settings,
    group: 'First',
    outline: true,
    rows: [
      { section: 'one', id: 'one_a', label: 'Part A' },
      { section: 'one', id: 'one_b', label: 'Part B' },
    ],
    render: () => <p>One body</p>,
  },
  {
    id: 'two',
    label: 'Two',
    icon: Users,
    group: 'First',
    outline: true,
    rows: [
      { section: 'two', id: 'two_a', label: 'Part C' },
      { section: 'two', id: 'two_b', label: 'Part D' },
    ],
    render: () => <p>Two body</p>,
  },
  {
    id: 'three',
    label: 'Three',
    icon: Users,
    group: 'Second',
    rows: [{ section: 'three', id: 'three_a', label: 'Part E' }],
    render: () => <p>Three body</p>,
  },
]

const groupedPage = (
  active: string | null,
  extra: Partial<Parameters<typeof SettingsPage>[0]> = {}
) =>
  renderToStaticMarkup(
    <SettingsPage
      title="Grouped"
      sections={grouped}
      active={active}
      onSection={() => {}}
      onClose={() => {}}
      {...extra}
    />
  )

test('the page is a large dialog on wide screens and fills narrow ones', () => {
  const html = page('general')
  expect(html).toContain('md:w-[min(94vw,1120px)]')
  expect(html).toContain('md:h-[min(88dvh,820px)]')
  expect(/role="dialog" aria-modal="true" aria-label="Demo settings"/.test(html)).toBe(true)
  const panel = /<div role="dialog"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''
  expect(panel.split(' ')).toContain('h-full')
  expect(panel.split(' ')).toContain('w-full')
  expect(panel.split(' ')).toContain('px-safe')
})

test('a section screen on narrow screens has the back arrow and a close button', () => {
  const html = page('people')
  const bar = html.slice(html.indexOf('title="Back"'), html.indexOf('<h1'))
  expect(bar).toContain('title="Close" aria-label="Close"')
  expect(bar).toContain('People')
})

test('nav groups get one heading each, in order', () => {
  const html = groupedPage('one')
  const headings = [...html.matchAll(/<p class="[^"]*uppercase[^"]*">([^<]+)<\/p>/g)].map(m => m[1])
  expect(headings).toEqual(['Grouped', 'First', 'Second'])
})

test('a header takes the place of the title at the top of the nav', () => {
  const html = groupedPage('one', { header: <div data-probe>Who</div> })
  expect(html).toContain('data-probe')
  const headings = [...html.matchAll(/<p class="[^"]*uppercase[^"]*">([^<]+)<\/p>/g)].map(m => m[1])
  expect(headings).toEqual(['First', 'Second'])
  expect(html.indexOf('data-probe')).toBeLessThan(html.indexOf('data-settings-section="one"'))
})

test('the shown section lists its parts under it in the nav, with a fold button', () => {
  const html = groupedPage('two')
  const parts = [...html.matchAll(/data-settings-part="([a-z_]+)"/g)].map(m => m[1])
  expect(parts).toEqual(['two_a', 'two_b'])
  const fold = /<button[^>]*title="Hide the parts of Two"[^>]*>/.exec(html)?.[0] ?? ''
  expect(fold).toContain('aria-label="Hide the parts of Two"')
  expect(fold).toContain('aria-expanded="true"')
  expect(html.indexOf('data-settings-section="two"')).toBeLessThan(html.indexOf('two_a'))
  expect(html.indexOf('two_b')).toBeLessThan(html.indexOf('data-settings-section="three"'))
})

test('a section with one part, or no outline, lists no parts', () => {
  expect(groupedPage('three')).not.toContain('data-settings-part')
  expect(page('general')).not.toContain('data-settings-part')
  expect(groupedPage('three')).not.toContain('aria-expanded')
})

test('the actor shows beside the section name', () => {
  const html = groupedPage('one', { actor: <span data-actor-probe /> })
  const header = html.slice(html.indexOf('<h1'))
  expect(header).toContain('data-actor-probe')
})

test('the section header and close button sit above the content, which scrolls alone', () => {
  const html = groupedPage('one', { closeTitle: 'Close grouped' })
  const header = /<div class="([^"]*)"><h1/.exec(html)?.[1] ?? ''
  expect(header.split(' ')).toContain('shrink-0')
  expect(header.split(' ')).toContain('border-b')
  const after = html.slice(html.indexOf('<h1'))
  expect(after).toContain('title="Close grouped" aria-label="Close grouped"')
  expect(
    /overflow-y-auto[^"]*"><div class="[^"]*mx-auto max-w-3xl"><div><div data-section-body="one"><p>One body/.test(
      after
    )
  ).toBe(true)
})

test('wide screens mark the shown section current; the narrow list marks only an open one', () => {
  expect(currentEntry('a', { shown: 'a', active: null, wide: true })).toBe(true)
  expect(currentEntry('a', { shown: 'a', active: null, wide: false })).toBe(false)
  expect(currentEntry('b', { shown: 'b', active: 'b', wide: false })).toBe(true)
  expect(currentEntry('a', { shown: 'b', active: 'b', wide: true })).toBe(false)
})

test('a page with one section opens it without the list', () => {
  expect(openSection([{ id: 'a' }], null)).toBe('a')
  expect(openSection([{ id: 'a' }, { id: 'b' }], null)).toBeNull()
  expect(openSection([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b')
})

test('visited sections stay kept, in the order they were opened', () => {
  const first = keptSections([], 'a')
  expect(first).toEqual(['a'])
  expect(keptSections(first, 'a')).toBe(first)
  expect(keptSections(first, 'b')).toEqual(['a', 'b'])
  expect(keptSections(['a', 'b'], 'a')).toEqual(['a', 'b'])
  expect(keptSections(['a'], null)).toEqual(['a'])
})

test('a section shows in its own body, and only the shown one is made at first', () => {
  const html = groupedPage('two')
  expect([...html.matchAll(/data-section-body="([a-z]+)"/g)].map(m => m[1])).toEqual(['two'])
  expect(html).not.toContain('One body')
})

test('the only section opens on phones too, with no way back to a one-entry list', () => {
  const html = renderToStaticMarkup(
    <SettingsPage
      title="Single"
      sections={[grouped[2]]}
      active={null}
      onSection={() => {}}
      onClose={() => {}}
    />
  )
  expect(html).toContain('data-screen="section"')
  expect(html).not.toContain('title="Back"')
  expect(html).toContain('Three body')
  expect(html.split('title="Close" aria-label="Close"').length - 1).toBe(3)
})

test('a lead shows above the shown section', () => {
  const html = groupedPage('one', { lead: <p data-lead>Notice</p> })
  expect(html.indexOf('data-lead')).toBeLessThan(html.indexOf('data-section-body="one"'))
})
