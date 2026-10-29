import { describe, expect, test } from 'bun:test'
import { cardLabel, findMessageLinks, messageLinkUrl, parseMessageLink } from '../message_links'

const at = (
  over: Partial<{ channel_id: number | null; dm_id: number | null; thread_root_id: number | null }>
) => ({
  id: 90,
  channel_id: null,
  dm_id: null,
  thread_root_id: null,
  ...over,
})

const origin = 'https://chat.example'

describe('messageLinkUrl', () => {
  test('channel, thread and DM links', () => {
    expect(messageLinkUrl(at({ channel_id: 4 }), 'my server', origin)).toBe(
      'https://chat.example/s/my%20server/4/90/'
    )
    expect(messageLinkUrl(at({ channel_id: 4, thread_root_id: 88 }), 'rchat', origin)).toBe(
      'https://chat.example/s/rchat/4/t/88/90/'
    )
    expect(messageLinkUrl(at({ dm_id: 3 }), null, origin)).toBe('https://chat.example/dm/3/90/')
  })

  test('no link without a known place', () => {
    expect(messageLinkUrl(at({ channel_id: 4 }), null, origin)).toBeNull()
    expect(messageLinkUrl(at({}), 'rchat', origin)).toBeNull()
  })
})

describe('parseMessageLink', () => {
  const local = [origin, 'http://localhost:3000']

  test('links on this instance parse', () => {
    expect(parseMessageLink('https://chat.example/s/rchat/4/t/88/90', local)).toEqual({
      kind: 'message',
      place: { kind: 'channel', server: 'rchat', channelId: 4 },
      thread: 88,
      id: 90,
    })
    expect(parseMessageLink('http://localhost:3000/dm/3/91/', local)?.id).toBe(91)
  })

  test('other instances, credentials and other pages do not', () => {
    for (const href of [
      'https://other.example/s/rchat/4/90/',
      'https://u:p@chat.example/s/rchat/4/90/',
      'https://chat.example/s/rchat/4/',
      'https://chat.example/invite/rchat/',
      'javascript:alert(1)',
      '/s/rchat/4/90/',
      'not a url',
    ])
      expect(parseMessageLink(href, local)).toBeNull()
  })
})

describe('findMessageLinks', () => {
  test('skips code, dedupes and caps', () => {
    const text = [
      'see https://chat.example/s/rchat/4/90/.',
      'again https://chat.example/s/rchat/4/90',
      '`https://chat.example/dm/3/91/`',
      '```',
      'https://chat.example/dm/3/92/',
      '```',
      'https://chat.example/dm/3/93/ https://chat.example/dm/3/94/ https://chat.example/dm/3/95/',
    ].join('\n')
    expect(findMessageLinks(text, [origin]).map(l => l.id)).toEqual([90, 93, 94])
  })
})

describe('cardLabel', () => {
  const base = { kind: 'user', forwarded: false, content: 'hi', has_media: false }
  test('pin notices, calls and empty forwards get a label instead of a snippet', () => {
    expect(cardLabel({ ...base, kind: 'pin', content: '' })).toEqual({
      label: 'pin',
      text: 'Pinned a message',
    })
    expect(cardLabel({ ...base, kind: 'call', content: '' })).toEqual({
      label: 'call',
      text: 'Call',
    })
    expect(cardLabel({ ...base, forwarded: true, content: '' })).toEqual({
      label: 'forward',
      text: 'Forwarded message',
    })
  })

  test('messages with text or an attachment keep their snippet', () => {
    expect(cardLabel(base)).toEqual({ label: null, forwarded: false })
    expect(cardLabel({ ...base, forwarded: true })).toEqual({ label: null, forwarded: true })
    expect(cardLabel({ ...base, forwarded: true, content: '', has_media: true })).toEqual({
      label: null,
      forwarded: true,
    })
  })
})
