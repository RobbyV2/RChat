import { describe, expect, test } from 'bun:test'
import {
  NOTICE_MS,
  NOTICES_MAX,
  addNotice,
  alertBody,
  context,
  desktopText,
  headline,
  liveNotices,
  nextNoticeEnd,
  pauseNotices,
  pauseTimer,
  resumeTimer,
  timeLeft,
  type AlertInput,
  type Notice,
  type Piece,
} from '../notices'
import { user } from './fixtures'

const line = (pieces: Piece[]) => pieces.map(p => (p.blur ? `[${p.text}]` : p.text)).join('')

const alert = (over: Partial<AlertInput> = {}): AlertInput => ({
  key: 'c1',
  actor: user('alice', { display_name: 'Alice' }),
  action: '',
  body: 'hello',
  server: 'Club',
  channel: 'general',
  dm: false,
  message: true,
  name: 'Alice',
  generic: 'New message',
  go: () => {},
  ...over,
})

const fromCarol = { actor: user('carol', { display_name: 'Carol' }), name: 'Carol' }

const add = (list: Notice[], a: AlertInput, id: number, now = 0, paused = false) =>
  addNotice(list, a, id, now, paused)

describe('grouping', () => {
  test('alerts from one conversation stack into one toast that shows the newest', () => {
    let list = add([], alert(), 1, 0)
    expect(line(headline(list[0]))).toBe('[Alice]')
    expect(line(context(list[0]))).toBe('[Club] · [#general]')
    list = add(list, alert({ body: 'second' }), 2, 1000)
    list = add(list, alert({ body: 'third' }), 3, 2000)
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(1)
    expect(list[0].count).toBe(3)
    expect(list[0].body).toBe('third')
    expect(line(headline(list[0]))).toBe('3 new messages from [Alice]')
  })

  test('several authors count in the channel; DMs say Direct message', () => {
    let list = add([], alert(), 1)
    list = add(list, alert(fromCarol), 2)
    expect(line(headline(list[0]))).toBe('2 new messages in [#general]')
    const dm = add([], alert({ key: 'd4', dm: true, server: null, channel: null }), 3)
    expect(line(context(dm[0]))).toBe('Direct message')
    const two = add(dm, alert({ key: 'd4', dm: true, server: null, channel: null }), 4)
    expect(line(headline(two[0]))).toBe('2 new messages from [Alice]')
  })

  test('a reaction in the group makes it notifications; pings keep their action alone', () => {
    let list = add([], alert({ action: 'mentioned you' }), 1)
    expect(line(headline(list[0]))).toBe('[Alice] mentioned you')
    list = add(list, alert({ action: 'reacted 👍 to your message', message: false }), 2)
    expect(line(headline(list[0]))).toBe('2 new notifications from [Alice]')
  })

  test('the newest go wins, so clicking opens the newest alert', () => {
    const went: number[] = []
    let list = add([], alert({ go: () => went.push(1) }), 1)
    list = add(list, alert({ go: () => went.push(2) }), 2)
    list[0].go()
    expect(went).toEqual([2])
  })

  test('at most three toasts; a stacked one moves to the newest place', () => {
    let list: Notice[] = []
    for (const key of ['a', 'b', 'c']) list = add(list, alert({ key }), list.length + 1)
    list = add(list, alert({ key: 'a' }), 9)
    expect(list.map(n => n.key)).toEqual(['b', 'c', 'a'])
    list = add(list, alert({ key: 'd' }), 10)
    expect(list.length).toBe(NOTICES_MAX)
    expect(list.map(n => n.key)).toEqual(['c', 'a', 'd'])
  })

  test('system notices never stack', () => {
    const sys = alert({ key: '!', actor: null, lead: 'You were removed from', name: 'Club' })
    const list = add(add([], sys, 1), sys, 2)
    expect(list.map(n => n.id)).toEqual([1, 2])
    expect(line(headline(list[0]))).toBe('You were removed from [Club]')
    expect(context(list[0])).toEqual([])
  })
})

describe('timer', () => {
  test('runs for 5 s, restarts on a new alert, and bumps the bar generation', () => {
    let list = add([], alert(), 1, 0)
    expect(timeLeft(list[0].timer, 0)).toBe(NOTICE_MS)
    expect(timeLeft(list[0].timer, 4000)).toBe(1000)
    list = add(list, alert(), 2, 4000)
    expect(list[0].gen).toBe(1)
    expect(timeLeft(list[0].timer, 8000)).toBe(1000)
    expect(liveNotices(list, 8999)).toBe(list)
    expect(liveNotices(list, 9000)).toEqual([])
  })

  test('pausing freezes the time left; resuming continues from there', () => {
    const t = pauseTimer({ left: NOTICE_MS, since: 0 }, 2000)
    expect(t).toEqual({ left: 3000, since: null })
    expect(timeLeft(t, 60_000)).toBe(3000)
    const back = resumeTimer(t, 60_000)
    expect(timeLeft(back, 61_000)).toBe(2000)
    expect(pauseTimer(t, 99)).toBe(t)
    expect(resumeTimer(back, 99)).toBe(back)
  })

  test('paused stacks have no next end; alerts while paused start paused', () => {
    let list = add([], alert({ key: 'a' }), 1, 0)
    list = add(list, alert({ key: 'b' }), 2, 1000)
    expect(nextNoticeEnd(list, 2000)).toBe(3000)
    list = pauseNotices(list, true, 2000)
    expect(nextNoticeEnd(list, 50_000)).toBeNull()
    list = add(list, alert({ key: 'c' }), 3, 50_000, true)
    expect(list[2].timer).toEqual({ left: NOTICE_MS, since: null })
    expect(liveNotices(list, 999_999)).toBe(list)
    list = pauseNotices(list, false, 100_000)
    expect(nextNoticeEnd(list, 100_000)).toBe(3000)
  })
})

describe('text', () => {
  test('spoilers and markdown are masked, also a spoiler an excerpt cut open', () => {
    expect(alertBody('look ||the end|| **now**', false)).toBe('look ███████ now')
    expect(alertBody('cut ||secret plan goes on', false)).toBe('cut ████████')
    expect(alertBody('dangling ||', false)).toBe('dangling')
  })

  test('streamer mode: no body; the desktop title is generic', () => {
    const [n] = add([], alert({ body: 'private ||x||' }), 1)
    expect(alertBody(n.body, true)).toBe('')
    expect(desktopText(n, true)).toEqual({ title: 'New message', body: '' })
  })

  test('desktop text matches the toast and keeps the channel', () => {
    const [one] = add([], alert({ action: 'mentioned you', body: 'hi ||x||' }), 1)
    expect(desktopText(one, false)).toEqual({
      title: 'Alice mentioned you in #general',
      body: 'hi ███',
    })
    const two = add([one], alert({ body: 'again' }), 2)
    expect(desktopText(two[0], false)).toEqual({
      title: '2 new messages from Alice in #general',
      body: 'again',
    })
    const three = add(two, alert({ ...fromCarol, body: 'me too' }), 3)
    expect(desktopText(three[0], false).title).toBe('3 new messages in #general')
    const dm = add([], alert({ key: 'd1', server: null, channel: null, dm: true }), 4)
    expect(
      desktopText(add(dm, alert({ key: 'd1', server: null, channel: null, dm: true }), 5)[0], false)
        .title
    ).toBe('2 new messages from Alice')
  })
})
