import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Loaded } from '../../components/loaded'
import { FEED_RETRY_MS, announcementSource, type AnnouncementFeed } from '../announcements'
import { ApiError } from '../api'
import type { AccountSession } from '../client/session'
import { ManualTime } from '../clock'
import { SUGGEST_DEBOUNCE } from '../mention_suggest'
import { hostedPeople } from '../place/mention_people'
import { setTime } from '../platform/time'
import type { UserRef } from '../types'

afterEach(() => setTime())

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const pass = async (clock: ManualTime, ms: number, step = 250) => {
  for (let at = 0; at < ms; at += step) {
    clock.advance(step)
    await settle()
  }
}

const notice = { id: 'a', message: 'Maintenance at noon', starts_at: 0, ends_at: 1_000 }

const feedOf = (over: Partial<AnnouncementFeed> = {}): AnnouncementFeed => ({
  server_time: 100,
  next_change: null,
  announcements: [notice],
  ...over,
})

const instance = (answers: (() => Promise<AnnouncementFeed>)[]) => {
  const clock = new ManualTime(0)
  setTime(clock)
  let asked = 0
  const dismissed: string[] = []
  const account = {
    time: clock,
    lifetime: { sessionMark: () => 'session' },
    api: {
      announcements: () => answers[Math.min(asked++, answers.length - 1)](),
      dismissAnnouncement: (id: string) => {
        dismissed.push(id)
        return Promise.resolve()
      },
    },
  } as unknown as AccountSession
  const source = announcementSource(account, false, 'unused')
  const draw = () =>
    renderToStaticMarkup(
      <Loaded load={source.get()} skeleton={null} empty={null} what="announcements">
        {feed => <b>{feed.announcements.map(a => a.message).join('|')}</b>}
      </Loaded>
    )
  return { clock, source, draw, asked: () => asked, dismissed }
}

const down = () => Promise.reject(new ApiError('Busy', 503))

describe('the announcements feed', () => {
  test('shows what the instance announces and asks again when a change is due', async () => {
    const { clock, source, draw, asked } = instance([() => Promise.resolve(feedOf())])
    const stop = source.subscribe(() => {})
    await settle()
    expect(draw()).toBe('<b>Maintenance at noon</b>')
    expect(asked()).toBe(1)
    await pass(clock, 30_000, 1_000)
    expect(asked()).toBe(2)
    stop()
    expect(clock.pending).toBe(0)
  })

  test('draws nothing while it has nothing, and for an instance without announcements', async () => {
    const empty = instance([() => Promise.resolve(feedOf({ announcements: [] }))])
    expect(empty.draw()).toBe('')
    empty.source.subscribe(() => {})
    await settle()
    expect(empty.draw()).toBe('')
    const without = instance([() => Promise.reject(new ApiError('Not found', 404))])
    without.source.subscribe(() => {})
    await settle()
    expect(without.source.get().status).toBe('empty')
  })

  test('a failure is tried again quietly before it is said', async () => {
    const { clock, source, draw, asked } = instance([down, down, () => Promise.resolve(feedOf())])
    source.subscribe(() => {})
    await settle()
    await pass(clock, 5_000)
    expect(asked()).toBe(2)
    expect(draw()).toBe('')
    await pass(clock, 10_000)
    expect(draw()).toBe('<b>Maintenance at noon</b>')
  })

  test('a failure that stays is said, with a way to ask again, and asked again later', async () => {
    const { clock, source, draw, asked } = instance([
      down,
      down,
      down,
      () => Promise.resolve(feedOf()),
    ])
    source.subscribe(() => {})
    await pass(clock, 16_000)
    expect(asked()).toBe(3)
    const html = draw()
    expect(html).toContain('Could not load announcements.')
    expect(html).toContain('Try again')
    await pass(clock, FEED_RETRY_MS, 1_000)
    expect(draw()).toBe('<b>Maintenance at noon</b>')
  })

  test('an announcement leaves when it ends, and when the viewer dismisses it', async () => {
    const later = { ...notice, id: 'b', message: 'New rules', ends_at: 5_000 }
    const { clock, source, draw, dismissed } = instance([
      () => Promise.resolve(feedOf({ server_time: 990, announcements: [notice, later] })),
    ])
    source.subscribe(() => {})
    await settle()
    expect(draw()).toBe('<b>Maintenance at noon|New rules</b>')
    await pass(clock, 10_000, 1_000)
    expect(draw()).toBe('<b>New rules</b>')
    await source.dismiss(later)
    expect(dismissed).toEqual(['b'])
    expect(source.get().status).toBe('empty')
  })
})

describe('people a mention looks up on the instance', () => {
  const place = (answer: () => Promise<UserRef[]>) => {
    const clock = new ManualTime(0)
    setTime(clock)
    const account = {
      store: { getState: () => ({}), subscribe: () => () => {} },
      api: { suggestMembers: answer },
    } as unknown as AccountSession
    return { clock, people: hostedPeople(account, { server: 'club' }, 'main') }
  }

  test('a lookup that fails is said until one answers or nothing is typed', async () => {
    let up = false
    const { clock, people } = place(() =>
      up ? Promise.resolve([]) : Promise.reject(new ApiError('Busy', 503))
    )
    let changes = 0
    people.trouble.subscribe(() => (changes += 1))
    expect(people.trouble.get()).toBe(null)
    people.ask('al')
    await pass(clock, SUGGEST_DEBOUNCE + 250)
    expect(people.trouble.get()?.kind).toBe('unavailable')
    expect(changes).toBe(1)
    up = true
    people.ask('ali')
    await pass(clock, SUGGEST_DEBOUNCE + 250)
    expect(people.trouble.get()).toBe(null)
    up = false
    people.ask('bo')
    await pass(clock, SUGGEST_DEBOUNCE + 250)
    expect(people.trouble.get()?.kind).toBe('unavailable')
    people.ask(null)
    expect(people.trouble.get()).toBe(null)
  })

  test('an answer for text that was replaced changes nothing', async () => {
    const { clock, people } = place(() => Promise.reject(new ApiError('Busy', 503)))
    people.ask('al')
    clock.advance(SUGGEST_DEBOUNCE)
    people.ask(null)
    await settle()
    expect(people.trouble.get()).toBe(null)
  })
})
