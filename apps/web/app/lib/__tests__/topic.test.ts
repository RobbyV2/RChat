import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  TOPIC_MAX,
  cleanTopic,
  topicAnnouncement,
  topicError,
  topicLine,
  topicParts,
} from '../topic'
import { useStore, resetSessionCaches } from '../store'
import type { Channel } from '../types'
import { me, serverDetail } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
let sent: unknown[] = []
let reply: () => Response = () => new Response('{}')

const general: Channel = { id: 7, name: 'general', kind: 'text', slowmode_seconds: 0 }

beforeEach(() => {
  sent = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? 'null')))
    return reply()
  }) as typeof fetch
  useStore.setState({
    me: me('alice'),
    guest: false,
    error: null,
    servers: { s: serverDetail('s', { channels: [general] }) },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  useStore.setState({ me: null, servers: {} })
})

describe('topic text', () => {
  test('cleans like the server and keeps newlines', () => {
    expect(cleanTopic('  rules\u0007 \r\n\n\n\nbe nice \t')).toBe('rules \n\nbe nice')
    expect(cleanTopic(' \n ')).toBe('')
  })

  test('counts code points against the limit', () => {
    expect(topicError('😀'.repeat(TOPIC_MAX))).toBeNull()
    expect(topicError('😀'.repeat(TOPIC_MAX + 1))).toBe('Topic must be at most 1024 characters')
    expect(topicAnnouncement(TOPIC_MAX - 3, false)).toBe('3 characters left')
    expect(topicAnnouncement(TOPIC_MAX + 1, false)).toBe('1 character over the limit')
    expect(topicAnnouncement(10, false)).toBe('')
    expect(topicAnnouncement(10, true)).toBe('Topic saved')
  })

  test('the header line turns newlines into spaces', () => {
    expect(topicLine('one\n\ntwo   three\n')).toBe('one two three')
  })

  test('links only http and https urls, without trailing punctuation', () => {
    expect(topicParts('see https://example.com/a?b=1, and (http://x.org).')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { text: ', and (' },
      { text: 'http://x.org', href: 'http://x.org' },
      { text: ').' },
    ])
    expect(topicParts('javascript:alert(1) ftp://a.b [x](https://e.com)')).toEqual([
      { text: 'javascript:alert(1) ftp://a.b [x](' },
      { text: 'https://e.com', href: 'https://e.com' },
      { text: ')' },
    ])
    expect(topicParts('**bold** https://')).toEqual([{ text: '**bold** https://' }])
    expect(topicParts('')).toEqual([])
  })
})

describe('setting a topic', () => {
  test('sends the cleaned topic and updates the cached channel', async () => {
    reply = () => new Response(JSON.stringify({ ...general, topic: 'hello\nworld' }))
    expect(await st().setChannelTopic('s', 7, '  hello\nworld\u0007 ')).toBeNull()
    expect(sent).toEqual([{ topic: 'hello\nworld' }])
    expect(st().servers.s.channels[0].topic).toBe('hello\nworld')
  })

  test('a blank topic clears it', async () => {
    reply = () => new Response(JSON.stringify({ ...general, topic: null }))
    expect(await st().setChannelTopic('s', 7, ' \n ')).toBeNull()
    expect(sent).toEqual([{ topic: null }])
    expect(st().servers.s.channels[0].topic).toBeNull()
  })

  test('returns the server error', async () => {
    reply = () =>
      new Response(JSON.stringify({ error: 'Content blocked by profanity filter' }), {
        status: 400,
      })
    expect(await st().setChannelTopic('s', 7, 'rude')).toBe('Content blocked by profanity filter')
    expect(st().servers.s.channels[0].topic).toBeUndefined()
  })

  test('channel_updated brings the topic to other clients', () => {
    st().applyWsEvent({
      type: 'channel_updated',
      server: 's',
      channel: { ...general, topic: 'live' },
    })
    expect(st().servers.s.channels[0].topic).toBe('live')
  })
})
