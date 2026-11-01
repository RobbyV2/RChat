import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import {
  ballotBody,
  ballotReady,
  draftError,
  draftRequest,
  emptyDraft,
  mergePoll,
  moveRank,
  keepsCounts,
  percent,
  runoffRows,
  sameBallot,
  timeLeft,
  toggleChoice,
  toggleRank,
  type PollDraft,
} from '../polls'
import { POLL_FETCH_MS } from '../polls_store'
import { cardLabel } from '../message_links'
import { canForward } from '../forward'
import { canPin } from '../pins'
import { canQuote } from '../replies'
import type { Message, Poll, ServerDetail, WsEvent } from '../types'
import { canManagePoll } from '../../components/poll_card'
import { advance, me, msg, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

const poll = (over: Partial<Poll> = {}): Poll => ({
  kind: 'single',
  question: 'Lunch?',
  options: [
    { id: 1, text: 'Pizza', emoji: null },
    { id: 2, text: 'Soup', emoji: null },
    { id: 3, text: 'Tacos', emoji: null },
  ],
  anonymous: false,
  show_results: 'always',
  allow_change: true,
  allow_add: false,
  min_choices: 1,
  max_choices: 1,
  scale: null,
  closes_at: null,
  closed: false,
  voters: 0,
  results: {
    counts: [1, 2, 3].map(option_id => ({ option_id, count: 0 })),
    rounds: [],
    winner: null,
    distribution: [],
    average: null,
  },
  mine: null,
  ...over,
})

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  ...emptyDraft(),
  question: 'Lunch?',
  options: [
    { text: 'Pizza', emoji: '🍕' },
    { text: 'Soup', emoji: null },
  ],
  ...over,
})

describe('poll drafts', () => {
  test('errors', () => {
    expect(draftError(draft())).toBeNull()
    expect(draftError(draft({ question: '  ' }))).toBe('Add a question')
    expect(draftError(draft({ question: 'x'.repeat(301) }))).toContain('300')
    expect(draftError(draft({ options: [{ text: 'a', emoji: null }] }))).toBe(
      'Add at least 2 options'
    )
    expect(
      draftError(
        draft({
          options: [
            { text: 'a', emoji: null },
            { text: ' A ', emoji: null },
          ],
        })
      )
    ).toBe('Options must be different')
    expect(draftError(draft({ kind: 'multiple', minChoices: 3 }))).toBe(
      'Check the number of choices'
    )
    expect(draftError(draft({ kind: 'multiple', minChoices: 2, maxChoices: 1 }))).toBe(
      'Check the number of choices'
    )
    expect(draftError(draft({ kind: 'rating', options: [] }))).toBeNull()
    expect(draftError(draft({ kind: 'yes_no', options: [] }))).toBeNull()
    expect(draftError(draft({ duration: 30 }))).toContain('30 days')
    expect(draftError(draft({ duration: 31 * 86400 }))).toContain('30 days')
    expect(draftError(draft({ duration: null }))).toBeNull()
  })

  test('requests', () => {
    expect(
      draftRequest(draft({ options: [...draft().options, { text: ' ', emoji: null }] }))
    ).toEqual({
      question: 'Lunch?',
      kind: 'single',
      options: [{ text: 'Pizza', emoji: '🍕' }, { text: 'Soup' }],
      anonymous: false,
      show_results: 'always',
      allow_change: true,
      allow_add: false,
      duration_seconds: 86400,
    })
    const multi = draftRequest(draft({ kind: 'multiple', allowAdd: true }))
    expect([multi.min_choices, multi.max_choices, multi.allow_add]).toEqual([1, 2, true])
    const rating = draftRequest(draft({ kind: 'rating', scale: 10, allowAdd: true }))
    expect([rating.options, rating.scale, rating.allow_add]).toEqual([[], 10, false])
    expect(draftRequest(draft({ kind: 'yes_no', duration: null })).duration_seconds).toBeNull()
  })
})

describe('ballots and counts', () => {
  test('choices', () => {
    const multi = poll({ kind: 'multiple', min_choices: 1, max_choices: 2 })
    expect(toggleChoice([1], 2, poll())).toEqual([2])
    expect(toggleChoice([1], 2, multi)).toEqual([1, 2])
    expect(toggleChoice([1, 2], 3, multi)).toEqual([1, 2])
    expect(toggleChoice([1, 2], 1, multi)).toEqual([2])
    expect(ballotReady(multi, [])).toBe(false)
    expect(ballotReady(multi, [1, 3])).toBe(true)
    expect(ballotReady(poll({ kind: 'rating', scale: 5 }), [6])).toBe(false)
    expect(ballotBody(poll({ kind: 'rating', scale: 5 }), [4])).toEqual({ value: 4 })
    expect(ballotBody(poll(), [2])).toEqual({ options: [2] })
    expect(sameBallot(null, [1])).toBe(false)
    expect(sameBallot([1, 2], [1, 2])).toBe(true)
    expect(sameBallot([2, 1], [1, 2])).toBe(false)
  })

  test('ranking', () => {
    expect(toggleRank([], 2)).toEqual([2])
    expect(toggleRank([2, 3], 2)).toEqual([3])
    expect(moveRank([1, 2, 3], 3, -1)).toEqual([1, 3, 2])
    expect(moveRank([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
    expect(ballotReady(poll({ kind: 'ranked' }), [3])).toBe(true)
  })

  test('percentages, time left and rounds', () => {
    expect(percent(1, 3)).toBe(33)
    expect(percent(0, 0)).toBe(0)
    expect(timeLeft(null, 0)).toBeNull()
    expect(timeLeft(100, 100)).toBe('Closing')
    expect(timeLeft(130, 100)).toBe('Less than a minute left')
    expect(timeLeft(100 + 120, 100)).toBe('2 minutes left')
    expect(timeLeft(100 + 3600, 100)).toBe('1 hour left')
    expect(timeLeft(100 + 3 * 86400, 100)).toBe('3 days left')
    const ranked = poll({
      kind: 'ranked',
      results: {
        counts: [],
        rounds: [
          {
            counts: [
              { option_id: 1, count: 2 },
              { option_id: 2, count: 1 },
              { option_id: 3, count: 1 },
            ],
            exhausted: 0,
            eliminated: 3,
          },
          {
            counts: [
              { option_id: 1, count: 2 },
              { option_id: 2, count: 1 },
            ],
            exhausted: 1,
            eliminated: null,
          },
        ],
        winner: 1,
        distribution: [],
        average: null,
      },
    })
    const rows = runoffRows(ranked)
    expect(rows.map(r => [r.n, r.counted, r.exhausted, r.eliminated])).toEqual([
      [1, 4, 0, 3],
      [2, 3, 1, null],
    ])
    expect(rows[1].rows.map(r => [r.option?.text, r.share])).toEqual([
      ['Pizza', 67],
      ['Soup', 33],
    ])
  })
})

describe('live updates', () => {
  test('merging keeps my vote and counts the event leaves out', () => {
    const local = poll({ show_results: 'after_vote', mine: [2] })
    const hidden = poll({ show_results: 'after_vote', results: null, voters: 4 })
    const merged = mergePoll(local, hidden)
    expect(merged.mine).toEqual([2])
    expect(merged.results).toEqual(local.results)
    expect(merged.voters).toBe(4)
    expect(keepsCounts(local, hidden)).toBe(true)
    expect(keepsCounts(poll({ show_results: 'after_vote' }), hidden)).toBe(false)
    expect(keepsCounts(local, { ...hidden, closed: true })).toBe(false)
    const closeHidden = poll({ show_results: 'after_close', results: null })
    expect(
      mergePoll(poll({ show_results: 'after_close', mine: [1], results: null }), closeHidden)
        .results
    ).toBeNull()
    expect(mergePoll(undefined, hidden)).toEqual(hidden)
  })

  test('message helpers treat polls like user messages', () => {
    const m = msg(5, { kind: 'poll', poll: poll() })
    expect([canQuote(m), canForward(m), canPin(m)]).toEqual([true, true, true])
    expect(
      cardLabel({ kind: 'poll', forwarded: false, content: 'Lunch?', has_media: false })
    ).toEqual({ label: 'poll', text: 'Poll: Lunch?' })
  })
})

describe('poll store', () => {
  const st = () => useStore.getState()
  const realFetch = globalThis.fetch
  const realWindow = (globalThis as { window?: unknown }).window
  let requests: { method: string; url: string; body: unknown }[] = []
  let respond: (method: string, url: string) => Response = () =>
    new Response(JSON.stringify({}), { status: 200 })
  const pollMsg = (p: Poll): Message => msg(10, { kind: 'poll', content: p.question, poll: p })
  const event = (p: Poll): WsEvent => ({
    type: 'poll_updated',
    server: 's',
    channel_id: 1,
    dm_id: null,
    dm_users: null,
    message_id: 10,
    thread_root_id: null,
    created_at: 1,
    poll: p,
  })
  const shown = () => st().messages.c1?.find(m => m.id === 10)?.poll

  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = {
      location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
      history: { state: null, pushState: () => {}, replaceState: () => {} },
    }
    requests = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return respond(method, url)
    }) as typeof fetch
    useStore.setState({
      me: me('bob'),
      token: 't',
      guest: false,
      error: null,
      view: { kind: 'channel', server: 's', channelId: 1 },
      servers: { s: serverDetail('s') },
      messages: { c1: [msg(9), pollMsg(poll({ mine: [1] }))] },
      panel: null,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    globalThis.fetch = realFetch
    ;(globalThis as { window?: unknown }).window = realWindow
  })

  test('poll_updated replaces counts and keeps my vote', () => {
    const counts = [1, 2, 3].map(option_id => ({ option_id, count: option_id }))
    st().applyWsEvent(
      event(poll({ voters: 6, results: { ...poll().results!, counts }, mine: null }))
    )
    expect(shown()?.voters).toBe(6)
    expect(shown()?.mine).toEqual([1])
    expect(shown()?.results?.counts).toEqual(counts)
  })

  test('updates never make a voter fetch the poll', async () => {
    jest.useFakeTimers()
    useStore.setState({
      messages: { c1: [pollMsg(poll({ show_results: 'after_vote', mine: [2] }))] },
    })
    const hidden = poll({ show_results: 'after_vote', results: null, voters: 9 })
    for (let i = 0; i < 5; i++) st().applyWsEvent(event(hidden))
    expect(shown()?.results === null).toBe(false)
    expect(shown()?.voters).toBe(9)
    const counts = [1, 2, 3].map(option_id => ({ option_id, count: 3 }))
    st().applyWsEvent(
      event(
        poll({ show_results: 'after_vote', voters: 10, results: { ...poll().results!, counts } })
      )
    )
    expect(shown()?.results?.counts).toEqual(counts)
    expect(shown()?.mine).toEqual([2])
    await advance(POLL_FETCH_MS + 50)
    expect(requests).toHaveLength(0)
  })

  test('nobody closes or reopens a channel poll while timed out in its server', () => {
    const channels = [{ id: 1, name: 'general' }] as unknown as ServerDetail['channels']
    const mine = msg(11, { kind: 'poll', author: me('bob'), poll: poll() })
    const inDm = { ...mine, channel_id: null, dm_id: 4 }
    const timedOut = (until: number | undefined) =>
      useStore.setState({
        servers: { s: serverDetail('s', { channels }) },
        me: me('bob', {
          servers: [
            {
              name: 's',
              display_name: 's',
              creator: null,
              is_admin: false,
              timed_out_until: until,
            },
          ],
        }),
      })
    timedOut(undefined)
    expect(canManagePoll(mine)).toBe(true)
    timedOut(Math.floor(Date.now() / 1000) + 600)
    expect(canManagePoll(mine)).toBe(false)
    expect(canManagePoll(inDm)).toBe(true)
    timedOut(Math.floor(Date.now() / 1000) - 1)
    expect(canManagePoll(mine)).toBe(true)
  })

  test('a replaced message keeps my vote and counts', () => {
    useStore.setState({
      messages: { c1: [pollMsg(poll({ show_results: 'after_vote', mine: [2] }))] },
    })
    const bare = pollMsg(poll({ show_results: 'after_vote', results: null, mine: null }))
    st().applyWsEvent({ type: 'message_updated', message: { ...bare, pinned_at: 5 } })
    expect(shown()?.mine).toEqual([2])
    expect(shown()?.results === null).toBe(false)
  })

  test('my vote from another tab reloads the poll', async () => {
    jest.useFakeTimers()
    respond = () => new Response(JSON.stringify(poll({ mine: [2], voters: 1 })), { status: 200 })
    st().applyWsEvent({ type: 'poll_voted', username: 'carol', message_id: 10 })
    st().applyWsEvent({ type: 'poll_voted', username: 'bob', message_id: 99 })
    st().applyWsEvent({ type: 'poll_voted', username: 'bob', message_id: 10 })
    await advance(POLL_FETCH_MS + 50)
    expect(requests.map(r => new URL(r.url, 'http://x').pathname)).toEqual(['/api/polls/10'])
    expect(shown()?.mine).toEqual([2])
  })

  test('votes, options and closing patch the message', async () => {
    const voted = poll({ mine: [3], voters: 1 })
    respond = (method, url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/close')
            ? { ...voted, closed: true }
            : url.endsWith('/options')
              ? { ...voted, options: [...voted.options, { id: 4, text: 'Rice', emoji: null }] }
              : voted
        ),
        { status: 200 }
      )
    await st().votePoll(10, { options: [3] })
    expect([requests.at(-1)?.method, requests.at(-1)?.body]).toEqual(['PUT', { options: [3] }])
    expect(shown()?.mine).toEqual([3])
    expect(await st().addPollOption(10, 'Rice', null)).toBeNull()
    expect(shown()?.options).toHaveLength(4)
    await st().closePoll(10)
    expect(shown()?.closed).toBe(true)
    respond = () => new Response(JSON.stringify({ error: 'This poll is closed' }), { status: 400 })
    expect(await st().addPollOption(10, 'Late', null)).toBe('This poll is closed')
  })

  test('creating a poll posts it as a message', async () => {
    respond = () => new Response(JSON.stringify(msg(11, { kind: 'poll' })), { status: 200 })
    const req = draftRequest(draft())
    expect(await st().createPoll({ kind: 'channel', id: 1 }, req)).toBeNull()
    expect(await st().createPoll({ kind: 'dm', id: 4 }, req)).toBeNull()
    expect(await st().createPoll({ kind: 'thread', id: 9 }, req)).toBeNull()
    expect(requests.map(r => `${r.method} ${new URL(r.url, 'http://x').pathname}`)).toEqual([
      'POST /api/channels/1/messages',
      'POST /api/dms/4/messages',
      'POST /api/messages/9/thread',
    ])
    const sent = requests[0].body as { content: string; poll: { question: string } }
    expect([sent.content, sent.poll.question]).toEqual(['', 'Lunch?'])
    respond = () =>
      new Response(JSON.stringify({ error: 'A poll needs 2 to 20 options' }), { status: 400 })
    expect(await st().createPoll({ kind: 'channel', id: 1 }, req)).toBe(
      'A poll needs 2 to 20 options'
    )
  })
})
