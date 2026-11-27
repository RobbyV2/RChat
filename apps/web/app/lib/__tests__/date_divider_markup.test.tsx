import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockedList } from '../../components/blocking'
import { DateDivider } from '../../components/date_divider'
import { useStore } from '../store'
import { msg, user } from './fixtures'

beforeEach(() => {
  process.env.TZ = 'America/New_York'
})
// Markup renders with the store's initial state.
const initial = useStore.getInitialState()
const blockedBefore = initial.blocked
afterEach(() => {
  initial.blocked = blockedBefore
})

const at = (d: number, h = 12) => new Date(2026, 10, d, h).getTime() / 1000

describe('the date line', () => {
  test('is a labelled separator with the full date', () => {
    const html = renderToStaticMarkup(<DateDivider at={at(24)} />)
    expect(html).toContain('role="separator"')
    expect(html).toContain('data-date-divider="2026-11-24"')
    expect(html).toContain('<time dateTime="2026-11-24"')
    expect(html).toContain('November 24, 2026')
  })

  test('a list draws one above the first row of each day, a folded run once above it', () => {
    const messages = [
      msg(1, { created_at: at(23, 22), author: user('carol') }),
      msg(2, { created_at: at(24, 9), author: user('bob') }),
      msg(3, { created_at: at(24, 10), author: user('bob') }),
      msg(4, { created_at: at(25, 9), author: user('bob') }),
      msg(5, { created_at: at(25, 10), author: user('carol') }),
    ]
    const render = (dayAbove: number | null = null) =>
      renderToStaticMarkup(
        <BlockedList
          messages={messages}
          focusId={null}
          dayAbove={dayAbove}
          row={m => <p data-row-id={m.id}>{m.id}</p>}
        />
      )
    expect(lines(render())).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(lines(render(at(23, 8)))).toEqual(['2026-11-24', '2026-11-25'])
    initial.blocked = { bob: true }
    const hidden = render()
    expect(hidden).not.toContain('data-row-id="2"')
    expect(lines(hidden)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(hidden.indexOf('2026-11-24')).toBeLessThan(hidden.indexOf('blocked'))
    expect(hidden.indexOf('2026-11-25')).toBeGreaterThan(hidden.indexOf('blocked'))
    expect(hidden.indexOf('2026-11-25')).toBeLessThan(hidden.indexOf('data-row-id="5"'))
  })

  test('the date line goes above the new messages line', () => {
    const messages = [
      msg(1, { created_at: at(24, 9), author: user('carol') }),
      msg(2, { created_at: at(25, 9), author: user('carol') }),
    ]
    const html = renderToStaticMarkup(
      <BlockedList
        messages={messages}
        focusId={null}
        dividerAt={1}
        row={(m, i) => (
          <div data-row-id={m.id}>
            {i === 1 && <div data-divider />}
            {m.id}
          </div>
        )}
      />
    )
    const date = html.indexOf('data-date-divider="2026-11-25"')
    expect(date).toBeGreaterThan(-1)
    expect(date).toBeLessThan(html.indexOf('data-divider'))
  })

  test('what follows the list goes on from the last row shown', () => {
    const messages = [
      msg(1, { created_at: at(24, 9), author: user('carol') }),
      msg(2, { created_at: at(24, 23), author: user('bob') }),
      msg(3, { created_at: at(25, 1), author: user('bob') }),
    ]
    const after: (number | null)[] = []
    const render = (list = messages, dayAbove: number | null = null) =>
      renderToStaticMarkup(
        <BlockedList
          messages={list}
          focusId={null}
          dayAbove={dayAbove}
          row={m => <p>{m.id}</p>}
          tail={t => {
            after.push(t)
            return <i data-tail />
          }}
        />
      )
    expect(render()).toContain('data-tail')
    initial.blocked = { bob: true }
    render()
    render([], at(20))
    expect(after).toEqual([at(25, 1), at(24, 23), at(20)])
  })
})

const lines = (html: string) => [...html.matchAll(/data-date-divider="([\d-]+)"/g)].map(x => x[1])
