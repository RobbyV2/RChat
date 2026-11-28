import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { AutomationChip } from '../../components/automations/automation_chip'
import {
  type Component,
  ComponentsView,
  pickedLabel,
  picksOk,
  togglePick,
} from '../../components/automations/components_view'
import { OnlyYouRow } from '../../components/automations/only_you_row'
import { importsOf, packagesOf } from './import_graph'

const noop = () => {}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../../crates/automation/vectors/components.json', import.meta.url)
    ),
    'utf8'
  )
) as { cases: { note: string; components: Component[][]; problems: unknown[] }[] }

const panel = vectors.cases[0].components
const count = (html: string, part: string) => html.split(part).length - 1
const view = (props: Partial<Parameters<typeof ComponentsView>[0]> = {}) =>
  renderToStaticMarkup(<ComponentsView rows={panel} onPress={noop} onPick={noop} {...props} />)

describe('the automation chip', () => {
  test('says what posted, with a tooltip, in the tertiary container colors', () => {
    const html = renderToStaticMarkup(<AutomationChip />)
    expect(html).toContain('>AUTOMATION</span>')
    expect(html).toContain('title="Posted by an automation, not by a member"')
    expect(html).toContain('bg-tertiary-container')
    expect(html).toContain('text-on-tertiary-container')
    expect(html).not.toContain('button')
  })

  test('names who ran or saved it, as a name', () => {
    const run = renderToStaticMarkup(<AutomationChip by={{ how: 'run', name: 'alice' }} />)
    expect(run).toContain('run by <span class="streamer">alice</span>')
    const saved = renderToStaticMarkup(<AutomationChip by={{ how: 'saved', name: '<dave>' }} />)
    expect(saved).toContain('saved by <span class="streamer">&lt;dave&gt;</span>')
  })
})

describe('the only-you row', () => {
  test('a dashed card that says only you see it, with the text as text', () => {
    const html = renderToStaticMarkup(
      <OnlyYouRow text={'You have the role <b>Minecraft</b> now.\nYou can see #mc.'} />
    )
    expect(html).toContain('Only you can see this')
    expect(html).toContain('You have the role &lt;b&gt;Minecraft&lt;/b&gt; now.\nYou can see #mc.')
    expect(html).toContain('role="note"')
    expect(html).toContain('bg-surface-container-high')
    expect(html).toContain('border-dashed')
    expect(html).toContain('border-outline-variant')
    expect(html).not.toContain('<button')
  })

  test('Dismiss and the jump are real buttons with pointers', () => {
    const html = renderToStaticMarkup(
      <OnlyYouRow text="Posted" onDismiss={noop} jump={{ label: 'Jump', onJump: noop }} />
    )
    expect(count(html, '<button type="button"')).toBe(2)
    expect(count(html, 'cursor-pointer')).toBe(2)
    expect(html).toContain('>Dismiss</button>')
    expect(html).toContain('>Jump</button>')
  })

  test('an error reads as one', () => {
    const html = renderToStaticMarkup(<OnlyYouRow text="Blocked by a server rule" kind="error" />)
    expect(html).toContain('text-error')
    expect(renderToStaticMarkup(<OnlyYouRow text="ok" />)).not.toContain('text-error')
  })
})

describe('message components', () => {
  test('one real button per button, in rows, with the emoji and label', () => {
    const html = view()
    expect(count(html, 'data-cid=')).toBe(4)
    expect(count(html, 'role="group"')).toBe(2)
    expect(html).toContain('data-cid="mc"')
    expect(html).toContain('<span aria-hidden="true">⛏</span>')
    expect(html).toContain('Minecraft')
    expect(count(html, '<button type="button"')).toBe(4)
    expect(count(html, 'cursor-pointer')).toBe(4)
  })

  test('role buttons say whether they are pressed; other buttons have no pressed state', () => {
    const html = view({ pressed: new Set(['mc']) })
    expect(/data-cid="mc"[^>]*aria-pressed="true"/.test(html)).toBe(true)
    expect(/data-cid="val"[^>]*aria-pressed="false"/.test(html)).toBe(true)
    expect(count(html, 'bg-secondary-container')).toBe(1)
    const kinds = renderToStaticMarkup(
      <ComponentsView rows={vectors.cases[1].components} onPress={noop} onPick={noop} />
    )
    expect(kinds).not.toContain('aria-pressed')
    expect(kinds).toContain('bg-primary')
    expect(kinds).toContain('bg-error')
    expect(/data-cid="site"[^>]*title="https:\/\/example.com\/"/.test(kinds)).toBe(true)
  })

  test('targets are 44 px tall and rows wrap', () => {
    const html = view()
    expect(count(html, 'min-h-11')).toBe(4)
    expect(count(html, 'flex-wrap')).toBe(1)
  })

  test('disabled says why, in a tooltip and a described-by line everyone sees', () => {
    const html = view({ disabled: 'Sign in to use this' })
    expect(count(html, 'disabled=""')).toBe(4)
    expect(count(html, 'title="Sign in to use this"')).toBe(4)
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? 'none'
    expect(count(html, `aria-describedby="${id}"`)).toBe(4)
    expect(html).toContain(
      `<p id="${id}" class="text-xs text-on-surface-variant">Sign in to use this</p>`
    )
    expect(html).not.toContain('sr-only')
    expect(view()).not.toContain('aria-describedby')
    expect(view()).not.toContain('disabled=""')
  })

  test('a control that waits is disabled and says what it waits for', () => {
    const html = view({ waiting: { mc: "Waiting for a moderator's device" } })
    expect(count(html, 'disabled=""')).toBe(1)
    expect(/data-cid="mc"[^>]*aria-busy="true"/.test(html)).toBe(true)
    expect(html).toContain('Waiting for a moderator&#x27;s device')
  })

  test('the menu is a button that opens a listbox, showing its placeholder or picks', () => {
    const closed = view()
    expect(/data-cid="more"[^>]*aria-haspopup="listbox"/.test(closed)).toBe(true)
    expect(/data-cid="more"[^>]*aria-expanded="false"/.test(closed)).toBe(true)
    expect(closed).toContain('Pick more...')
    expect(closed).not.toContain('role="listbox"')
    const picked = view({ picks: { more: ['osu', 'go'] } })
    expect(picked).toContain('Go, osu!')
    expect(picked).not.toContain('Pick more...')
  })

  test('the open listbox lists every option with its pick state and description', () => {
    const html = view({ picks: { more: ['go'] }, open: 'more' })
    expect(/data-cid="more"[^>]*aria-expanded="true"/.test(html)).toBe(true)
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-multiselectable="true"')
    expect(count(html, 'role="option"')).toBe(3)
    expect(count(html, 'aria-selected="true"')).toBe(1)
    expect(html).toContain('The board game')
    expect(html).toContain('>Done</button>')
    const single = renderToStaticMarkup(
      <ComponentsView
        rows={[[{ ...panel[1][0], max: 1 } as Component]]}
        open="more"
        onPress={noop}
        onPick={noop}
      />
    )
    expect(single).not.toContain('aria-multiselectable')
    expect(single).not.toContain('>Done</button>')
  })

  test('nothing in a label or an option is read as markup', () => {
    const html = renderToStaticMarkup(
      <ComponentsView
        rows={[
          [{ type: 'button', cid: 'x', label: '<img src=x>', style: 'plain', do: 'run' }],
          [
            {
              type: 'select',
              cid: 's',
              placeholder: '<i>pick</i>',
              min: 0,
              max: 1,
              options: [{ value: 'a', label: '<b>A</b>' }],
            },
          ],
        ]}
        open="s"
        onPress={noop}
        onPick={noop}
      />
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<i>')
    expect(html).not.toContain('href')
  })

  test('every valid vector of the crate renders, with one control per component', () => {
    const valid = vectors.cases.filter(c => c.problems.length === 0)
    expect(valid.length).toBeGreaterThanOrEqual(3)
    for (const c of valid) {
      const html = renderToStaticMarkup(
        <ComponentsView rows={c.components} onPress={noop} onPick={noop} />
      )
      expect([c.note, count(html, 'data-cid=')]).toEqual([c.note, c.components.flat().length])
    }
    expect(renderToStaticMarkup(<ComponentsView rows={[]} onPress={noop} onPick={noop} />)).toBe('')
  })
})

describe('menu picks', () => {
  const select = panel[1][0] as Extract<Component, { type: 'select' }>

  test('a pick toggles, in option order, and never passes the most', () => {
    expect(togglePick(select, [], 'osu')).toEqual(['osu'])
    expect(togglePick(select, ['osu'], 'go')).toEqual(['go', 'osu'])
    expect(togglePick(select, ['go', 'osu'], 'go')).toEqual(['osu'])
    expect(togglePick({ ...select, max: 2 }, ['go', 'osu'], 'tetris')).toEqual(['go', 'osu'])
    expect(togglePick(select, [], 'nope')).toEqual([])
    expect(togglePick(select, ['stale', 'go'], 'osu')).toEqual(['go', 'osu'])
  })

  test('a menu of one swaps its pick', () => {
    const one = { ...select, max: 1 }
    expect(togglePick(one, ['go'], 'osu')).toEqual(['osu'])
    expect(togglePick(one, ['go'], 'go')).toEqual([])
    expect(togglePick({ ...one, min: 1 }, ['go'], 'go')).toEqual(['go'])
  })

  test('picks can be sent only within the least and the most', () => {
    expect(picksOk(select, [])).toBe(true)
    expect(picksOk({ ...select, min: 1 }, [])).toBe(false)
    expect(picksOk({ ...select, min: 1 }, ['go'])).toBe(true)
    expect(picksOk({ ...select, max: 1 }, ['go', 'osu'])).toBe(false)
    expect(picksOk(select, ['nope'])).toBe(false)
  })

  test('the closed menu names its picks, else its placeholder, else a default', () => {
    expect(pickedLabel(select, ['osu', 'go'])).toBe('Go, osu!')
    expect(pickedLabel(select, [])).toBe('Pick more...')
    expect(pickedLabel(select, ['gone'])).toBe('Pick more...')
    expect(pickedLabel({ ...select, placeholder: undefined }, [])).toBe('Choose')
  })
})

describe('layering', () => {
  // The layout boxes take props only themselves.
  const BOXES = [
    'apps/web/app/components/layout/index.tsx',
    'apps/web/app/lib/controls.ts',
    'apps/web/app/lib/layout/index.ts',
  ]

  test('props only: no store, no API client, no other component than the layout boxes', () => {
    for (const name of ['components_view', 'only_you_row', 'automation_chip']) {
      const entry = `apps/web/app/components/automations/${name}.tsx`
      expect([name, [...importsOf(entry)].filter(f => !BOXES.includes(f))]).toEqual([name, []])
      const packages = [...packagesOf(entry)].filter(p => p !== 'react').sort()
      expect([name, packages]).toEqual([name, name === 'components_view' ? ['lucide-react'] : []])
    }
  })
})
