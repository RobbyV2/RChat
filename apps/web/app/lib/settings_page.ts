// The model of a settings page: which section shows and what the keys do. No imports.

// The section a page shows: the asked one, or the first when none or an unknown one is asked.
export const shownSection = (sections: { id: string }[], asked: string | null): string | null =>
  sections.find(s => s.id === asked)?.id ?? sections[0]?.id ?? null

// Where the arrow keys, Home and End move in a list of `count` entries from `index`; null for
// any other key.
export const navKey = (key: string, index: number, count: number): number | null => {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, count - 1)
    case 'ArrowUp':
      return Math.max(index - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

// Where Tab moves from `index` among `count` controls when it leaves the ends of a page: around
// to the other end, or in from outside it (`index` -1). Null leaves Tab to the browser.
export const tabWrap = (index: number, count: number, back: boolean): number | null => {
  if (count <= 0) return null
  if (index < 0) return back ? count - 1 : 0
  if (back && index === 0) return count - 1
  if (!back && index === count - 1) return 0
  return null
}

// What Esc does on a page: clears a search with text in it, otherwise closes the page.
export const pageEscape = (query: string): 'clear' | 'close' => (query === '' ? 'close' : 'clear')

export interface PressedKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

// Whether a key press should move focus to the search field: a plain slash outside a field.
export const focusesSearch = (e: PressedKey, on: { tag: string; editable: boolean }) =>
  e.key === '/' &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.altKey &&
  !on.editable &&
  !['INPUT', 'TEXTAREA', 'SELECT'].includes(on.tag)

// The element id of a row, for deep links and search results.
export const rowAnchor = (id: string) => `row-${id}`

// Whether a nav entry is the current page: on wide screens the section that shows beside the nav;
// on narrow ones, where the list is a screen of its own, only an open section.
export const currentEntry = (
  id: string,
  { shown, active, wide }: { shown: string | null; active: string | null; wide: boolean }
) => (wide ? shown === id : active === id)

// The open section of a page: the asked one, or its only section, which opens without the list.
export const openSection = (sections: { id: string }[], active: string | null) =>
  sections.length === 1 ? sections[0].id : active

// The sections a page keeps mounted: those visited so far and the shown one, so switching away
// keeps unsaved edits.
export const keptSections = (visited: readonly string[], shown: string | null) =>
  shown === null || visited.includes(shown) ? visited : [...visited, shown]
