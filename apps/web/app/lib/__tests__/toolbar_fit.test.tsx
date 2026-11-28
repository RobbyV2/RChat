import { describe, expect, test } from 'bun:test'
import { notAName } from '../names'
import { renderToStaticMarkup } from 'react-dom/server'
import { Forward, MessageSquareText, Pencil, Reply, Trash2 } from 'lucide-react'
import { toolbarFit } from '../toolbar_fit'
import { MessageToolbar, type ToolbarAction } from '../../components/message_toolbar'
import { msg } from './fixtures'

describe('how much of the toolbar a row shows beside a name line', () => {
  test('rows of 576 px and more show all of it', () => {
    for (const w of [576, 648, 728, 1200]) expect(toolbarFit(w)).toBe('full')
  })

  test('rows from 464 px move the quick reactions into the More menu', () => {
    for (const w of [464, 472, 575]) expect(toolbarFit(w)).toBe('compact')
  })

  test('narrower rows keep only the main buttons', () => {
    for (const w of [0, 319, 392, 463]) expect(toolbarFit(w)).toBe('tight')
  })
})

const action = (key: string, label: string, icon: ToolbarAction['icon']): ToolbarAction => ({
  key,
  label: notAName(label),
  icon,
  onClick: () => {},
})

describe('the toolbar buttons', () => {
  const html = renderToStaticMarkup(
    <MessageToolbar
      m={msg(1)}
      react
      actions={[
        action('edit', 'Edit', Pencil),
        action('reply', 'Reply', Reply),
        action('forward', 'Forward', Forward),
        action('thread', 'Reply in thread', MessageSquareText),
        action('delete', 'Delete message', Trash2),
      ]}
      onMore={() => {}}
    />
  )
  const cls = (label: string) =>
    html
      .match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*class="([^"]*)"`))?.[1]
      .split(' ') ??
    html
      .match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*aria-label="${label}"`))?.[1]
      .split(' ') ??
    []
  // The classes of the box around a button: it is what leaves the toolbar.
  const box = (label: string) =>
    html
      .match(new RegExp(`<span class="([^"]*)"><button[^>]*aria-label="${label}"`))?.[1]
      .split(' ') ?? []
  const COMPACT = 'group-data-[fit=compact]/bar:hidden'
  const TIGHT = 'group-data-[fit=tight]/bar:hidden'
  const quick = [...html.matchAll(/aria-label="(React with [^"]*)"/g)].map(m => m[1])

  test('the toolbar is the group its buttons hide by', () => {
    const bar = html.match(/<div role="toolbar"[^>]*class="([^"]*)"/)?.[1].split(' ') ?? []
    expect(bar).toContain('group/bar')
  })

  test('the quick reactions leave a compact or tight toolbar', () => {
    expect(quick.length).toBe(3)
    for (const label of quick) {
      expect(box(label)).toContain(COMPACT)
      expect(box(label)).toContain(TIGHT)
    }
    const rule =
      html.match(/<span aria-hidden="true" class="(h-5 w-px [^"]*)"/)?.[1].split(' ') ?? []
    expect(rule).toContain(COMPACT)
    expect(rule).toContain(TIGHT)
  })

  test('a tight toolbar keeps add reaction, reply and more', () => {
    for (const label of ['Add reaction', 'Reply', 'More']) {
      expect(cls(label).length > 0).toBe(true)
      expect(box(label)).not.toContain(COMPACT)
      expect(box(label)).not.toContain(TIGHT)
    }
  })

  test('edit, forward, reply in thread and delete leave only a tight toolbar', () => {
    for (const label of ['Edit', 'Forward', 'Reply in thread', 'Delete message']) {
      expect(box(label)).toContain(TIGHT)
      expect(box(label)).not.toContain(COMPACT)
    }
  })
})
