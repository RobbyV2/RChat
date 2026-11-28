import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ConnectionNotice,
  ErrorNotice,
  FieldRefusal,
  Notice,
  Unavailable,
  UnavailableFor,
} from '../../components/notices'
import { ApiError } from '../api'
import { refusalOf } from '../api_errors'
import { ManualTime } from './helpers/test_clock'
import { setTime } from '../platform/time'

afterEach(() => setTime())

const html = renderToStaticMarkup
const refused = (message: string, status: number, reason?: Record<string, unknown>) =>
  refusalOf(new ApiError(message, status, reason ? { error: message, reason } : undefined))

describe('a notice', () => {
  test('says its line, and offers to ask again only when it can', () => {
    const quiet = html(<Notice line="Nothing to see." />)
    expect(quiet).toContain('role="status"')
    expect(quiet).toContain('Nothing to see.')
    expect(quiet.includes('<button')).toBe(false)
    expect(html(<Notice line="x" retry={() => {}} />)).toContain('Try again</button>')
  })

  test('counts down the wait on its button', () => {
    const clock = new ManualTime()
    setTime(clock)
    const waiting = html(<Notice line="x" retry={() => {}} retryAt={clock.elapsed() + 30_000} />)
    expect(waiting).toContain('disabled=""')
    expect(waiting).toContain('Try again in 30 s')
    clock.advance(30_000)
    const open = html(<Notice line="x" retry={() => {}} retryAt={30_000} />)
    expect(open.includes('disabled=""')).toBe(false)
    expect(open).toContain('Try again</button>')
  })
})

describe('an error notice', () => {
  test('is an alert with the line for the refusal, after what was being done', () => {
    const out = html(
      <ErrorNotice
        refusal={refused('Calls are full', 503, { kind: 'capacity', control: 'calls' })}
        lead="Could not start the call."
        retry={() => {}}
      />
    )
    expect(out).toContain('role="alert"')
    expect(out).toContain(
      'Could not start the call. This site is at capacity for calls right now. Try again in a moment.'
    )
    expect(out).toContain('Try again</button>')
  })

  test('offers no retry for what the person must change', () => {
    const out = html(<ErrorNotice refusal={refused('Too long', 400)} retry={() => {}} />)
    expect(out).toContain('Too long')
    expect(out.includes('<button')).toBe(false)
  })
})

describe('a field', () => {
  test('shows the line under the field the refusal names, and nothing under the others', () => {
    const r = refused('Name is too long', 400, { kind: 'invalid', field: 'name' })
    expect(html(<FieldRefusal refusal={r} field="name" />)).toContain('Name is too long')
    expect(html(<FieldRefusal refusal={r} field="bio" />)).toBe('')
    expect(html(<FieldRefusal refusal={null} field="name" />)).toBe('')
  })
})

describe('a turned off control', () => {
  test('stays where it was, cannot be used, and says why', () => {
    const out = html(
      <Unavailable line="Calls are turned off on this site.">
        <button>Call</button>
      </Unavailable>
    )
    expect(out).toContain('inert=""')
    expect(out).toContain('aria-disabled="true"')
    expect(out).toContain('<button>Call</button>')
    expect(out).toContain('Calls are turned off on this site.')
  })

  test('only a refusal about a switch or a permission turns the control off', () => {
    const off = refused('Off', 403, { kind: 'off_site', control: 'calls' })
    const on = html(
      <UnavailableFor refusal={off}>
        <button>Call</button>
      </UnavailableFor>
    )
    expect(on).toContain('Calls is turned off on this site.')
    const other = html(
      <UnavailableFor refusal={refused('Busy', 503)}>
        <button>Call</button>
      </UnavailableFor>
    )
    expect(other).toBe('<button>Call</button>')
    const none = html(
      <UnavailableFor refusal={null}>
        <button>Call</button>
      </UnavailableFor>
    )
    expect(none).toBe('<button>Call</button>')
  })
})

describe('waiting on a connection', () => {
  test('each reason has its line', () => {
    expect(html(<ConnectionNotice why="offline" />)).toContain('You are offline.')
    expect(html(<ConnectionNotice why="reconnecting" />)).toContain('Reconnecting.')
    expect(html(<ConnectionNotice why="no_peer" />)).toContain(
      'Nobody who has this is online right now.'
    )
  })
})
