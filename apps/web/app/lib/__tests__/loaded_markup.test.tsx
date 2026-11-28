import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Loaded } from '../../components/loaded'
import { ApiError } from '../api'
import { ManualTime } from '../clock'
import { LOAD_DEADLINE_MS, fromStore, type Load, type LoadMaker } from '../load'
import { setTime } from '../platform/time'

afterEach(() => setTime())

const clock = () => {
  const manual = new ManualTime()
  setTime(manual)
  return manual
}

// A load in the state `pick` says, as a store source makes it.
const load = <T,>(time: ManualTime, pick: (make: LoadMaker<T>) => Load<T>, retry?: () => void) => {
  const store = { getState: () => null, subscribe: () => () => {} }
  return fromStore<null, T>(time, store, (_s, make) => pick(make), retry ?? null).get()
}

const draw = <T,>(l: Load<T>, extra: { empty?: string; what?: string } = {}) =>
  renderToStaticMarkup(
    <Loaded load={l} {...extra}>
      {value => <b>{String(value)}</b>}
    </Loaded>
  )

describe('a load on screen', () => {
  test('the value, once it is here', () => {
    const time = clock()
    expect(draw(load<number>(time, make => make.ready(7)))).toBe('<b>7</b>')
  })

  test('a skeleton while it loads, held back at first', () => {
    const time = clock()
    const html = draw(
      load<number>(time, make => make.loading()),
      { what: 'pins' }
    )
    expect(html).toContain('data-skeleton="rows"')
    expect(html).toContain('aria-label="Loading pins"')
    expect(html.startsWith('<div hidden=""')).toBe(true)
    expect(html.includes('<b>')).toBe(false)
  })

  test('past the deadline, a line and a way to ask again', () => {
    const time = clock()
    const l = load<number>(
      time,
      make => make.loading(),
      () => {}
    )
    time.advance(LOAD_DEADLINE_MS)
    const html = draw(l, { what: 'pins' })
    expect(html).toContain('Still loading pins.')
    expect(html).toContain('>Try again</button>')
    expect(html.includes('data-skeleton')).toBe(false)
  })

  test('the empty line', () => {
    const time = clock()
    expect(
      draw(
        load<number>(time, make => make.empty()),
        { empty: 'No pins yet.' }
      )
    ).toContain(
      '<p data-load-empty="true" class="text-sm text-on-surface-variant">No pins yet.</p>'
    )
  })

  test('a refusal, said out loud, with a way to ask again', () => {
    const time = clock()
    const failed = load<number>(
      time,
      make => make.failed(new ApiError('The database is busy', 503)),
      () => {}
    )
    const html = draw(failed, { what: 'pins' })
    expect(html).toContain('role="alert"')
    expect(html).toContain(
      'Could not load pins. The server cannot do that right now. Try again in a moment.'
    )
    expect(html).toContain('>Try again</button>')
  })

  test('a load with no way to ask again shows no button', () => {
    const time = clock()
    const html = draw(load<number>(time, make => make.failed('no')))
    expect(html).toContain('role="alert"')
    expect(html.includes('<button')).toBe(false)
  })

  test('a refusal that asking again cannot change shows no button', () => {
    const time = clock()
    const html = draw(
      load<number>(
        time,
        make => make.failed(new ApiError('Not found', 404)),
        () => {}
      )
    )
    expect(html).toContain('This is not here, or you cannot open it.')
    expect(html.includes('<button')).toBe(false)
  })

  test('each reason for waiting has its line', () => {
    const time = clock()
    expect(draw(load<number>(time, make => make.waiting('offline')))).toContain('You are offline.')
    expect(draw(load<number>(time, make => make.waiting('reconnecting')))).toContain(
      'Reconnecting.'
    )
    expect(draw(load<number>(time, make => make.waiting('no_peer')))).toContain(
      'Nobody who has this is online right now.'
    )
  })

  test('no line has an em dash', () => {
    const time = clock()
    const all = [
      draw(load<number>(time, make => make.waiting('offline'))),
      draw(load<number>(time, make => make.waiting('reconnecting'))),
      draw(load<number>(time, make => make.waiting('no_peer'))),
      draw(load<number>(time, make => make.empty())),
      draw(load<number>(time, make => make.failed('no'))),
    ].join('')
    expect(all.includes('—')).toBe(false)
  })
})
