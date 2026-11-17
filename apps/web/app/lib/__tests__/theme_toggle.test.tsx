import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeToggle } from '../../components/status_clock'
import { resetSessionCaches, useStore } from '../store'

afterEach(resetSessionCaches)

const button = () => {
  const tag = renderToStaticMarkup(<ThemeToggle />).match(/^<button[^>]*>/)?.[0] ?? ''
  return {
    title: tag.match(/ title="([^"]*)"/)?.[1],
    label: tag.match(/ aria-label="([^"]*)"/)?.[1],
  }
}

test('the theme toggle is named for screen readers as it is on hover, in both themes', () => {
  for (const theme of ['dark', 'light'] as const) {
    // Server rendering reads the store's initial state.
    Object.assign(useStore.getInitialState(), { theme })
    expect(button()).toEqual({ title: 'Toggle theme', label: 'Toggle theme' })
  }
})
