import { describe, expect, test } from 'bun:test'
import {
  fetchedQuote,
  fillQuote,
  parseReplyMention,
  plainLine,
  quoteDeleted,
  quoteOf,
  replyMentionValue,
  repliesToMe,
  sendReply,
  snippetParts,
} from '../replies'
import type { ReplyRef } from '../types'
import { msg, user } from './fixtures'

const quote = (over: Partial<ReplyRef> = {}): ReplyRef => ({
  id: 1,
  author: user('alice'),
  content: 'hi',
  has_media: false,
  deleted: false,
  mention: true,
  ...over,
})

describe('reply mention preference', () => {
  test('defaults to on and survives bad data', () => {
    expect(parseReplyMention(null)).toBe(true)
    expect(parseReplyMention('{oops')).toBe(true)
    expect(parseReplyMention('[]')).toBe(true)
    expect(parseReplyMention(JSON.stringify({ v: 2, mention: false }))).toBe(true)
    expect(parseReplyMention(JSON.stringify({ v: 1, mention: 'no' }))).toBe(true)
    expect(parseReplyMention(replyMentionValue(false))).toBe(false)
    expect(parseReplyMention(replyMentionValue(true))).toBe(true)
  })
})

describe('plain snippets for replies being sent', () => {
  test('match the server rules', () => {
    expect(plainLine('hello\nworld')).toBe('hello')
    expect(plainLine('\n\n```rust\nlet x = 1;\n```')).toBe('let x = 1;')
    expect(plainLine('> **bold** _it_ ~~gone~~ `code` snake_case')).toBe(
      'bold it gone code snake_case'
    )
    expect(plainLine('## Title')).toBe('Title')
    expect(plainLine('-# small print')).toBe('small print')
    expect(plainLine('see [the docs](https://x.y/z) or <https://a.b>')).toBe(
      'see the docs or https://a.b'
    )
    expect(plainLine('a ||secret|| b')).toBe('a ||secret|| b')
    expect(plainLine('')).toBe('')
    expect([...plainLine('é'.repeat(300))].length).toBe(200)
    expect(plainLine('a\u202Eb\u200Fc\u2066d\u2069\u200Ee\u0007f\u202Ag')).toBe('abcdefg')
    expect(plainLine('x\ty\u000Bz\u001B[0m')).toBe('x y z[0m')
  })

  test('quoteOf never pings yourself', () => {
    const own = msg(5, { author: user('bob'), content: '**x**' })
    expect(quoteOf({ message: own, mention: true }, 'bob')).toEqual({
      id: 5,
      author: own.author,
      content: 'x',
      has_media: false,
      deleted: false,
      mention: false,
    })
    expect(quoteOf({ message: msg(6), mention: true }, 'bob').mention).toBe(true)
  })
})

describe('replies that ping you', () => {
  test('only with mention on, to your message, by someone else', () => {
    const reply = msg(2, { author: user('bob'), reply_to: quote() })
    expect(repliesToMe(reply, 'alice')).toBe(true)
    expect(repliesToMe(reply, 'carol')).toBe(false)
    expect(repliesToMe(reply, undefined)).toBe(false)
    expect(repliesToMe({ ...reply, reply_to: quote({ mention: false }) }, 'alice')).toBe(false)
    expect(repliesToMe(msg(3, { author: user('alice'), reply_to: quote() }), 'alice')).toBe(false)
    expect(repliesToMe(msg(4), 'alice')).toBe(false)
  })

  test('send options', () => {
    expect(sendReply(null)).toEqual({})
    expect(sendReply({ message: msg(7), mention: false })).toEqual({
      reply_to: 7,
      mention_reply: false,
    })
  })
})

describe('deleted originals', () => {
  test('quotes of the deleted message turn into placeholders, others stay', () => {
    const list = [msg(1), msg(2, { reply_to: quote() }), msg(3, { reply_to: quote({ id: 9 }) })]
    const next = quoteDeleted(list, 1)
    expect(next[1].reply_to).toEqual({
      id: 1,
      author: null,
      content: '',
      has_media: false,
      deleted: true,
      mention: true,
    })
    expect(next[2]).toBe(list[2])
    expect(quoteDeleted(next, 1)).toBe(next)
    expect(quoteDeleted(list, 42)).toBe(list)
  })
})

describe('spoilers in snippets', () => {
  test('every second part is hidden, an unclosed one too', () => {
    expect(snippetParts('a ||b|| c')).toEqual([
      { text: 'a ', spoiler: false },
      { text: 'b', spoiler: true },
      { text: ' c', spoiler: false },
    ])
    expect(snippetParts('||cut off')).toEqual([{ text: 'cut off', spoiler: true }])
    expect(snippetParts('plain')).toEqual([{ text: 'plain', spoiler: false }])
  })
})

describe('partial quotes from WebSocket events', () => {
  const partial = (over: Partial<ReplyRef> = {}): ReplyRef => ({
    id: 1,
    author: null,
    content: '',
    has_media: false,
    deleted: false,
    mention: true,
    partial: true,
    ...over,
  })
  const reply = msg(7, { author: user('bob'), reply_to: partial() })

  test('complete quotes pass through', () => {
    const full = msg(7, { reply_to: quote() })
    expect(fillQuote(full, undefined, undefined)).toBe(full)
    const plain = msg(8)
    expect(fillQuote(plain, undefined, undefined)).toBe(plain)
  })

  test('a quote already resolved for the reply is reused with the event mention', () => {
    expect(fillQuote(reply, quote({ mention: false }), undefined)?.reply_to).toEqual(quote())
    expect(fillQuote(reply, quote({ id: 2 }), undefined)).toBeNull()
    expect(fillQuote(reply, partial(), undefined)).toBeNull()
  })

  test('a loaded original in the same place fills it', () => {
    const original = msg(1, { author: user('alice'), content: '**lunch?**\nmore' })
    expect(fillQuote(reply, undefined, original)?.reply_to).toEqual({
      id: 1,
      author: original.author,
      content: 'lunch?',
      has_media: false,
      deleted: false,
      mention: true,
    })
    const copy = {
      ...original,
      forward: { author: null, created_at: 1, source_id: 9, origin: null, dropped: null },
    }
    expect(fillQuote(reply, undefined, copy)?.reply_to?.forwarded).toBe(true)
    expect(fillQuote(reply, undefined, { ...original, channel_id: 99 })).toBeNull()
    expect(fillQuote(reply, undefined, { ...original, id: 3 })).toBeNull()
  })

  test('the read result is used, or the placeholder when the reply is missing', () => {
    const read = [msg(7, { reply_to: quote({ deleted: true, author: null, content: '' }) })]
    expect(fetchedQuote(read, 7, partial())).toEqual(read[0].reply_to!)
    expect(fetchedQuote([msg(8, { reply_to: quote() })], 7, partial())).toEqual({
      id: 1,
      author: null,
      content: '',
      has_media: false,
      deleted: true,
      mention: true,
    })
  })

  test('a partial quote never counts as a reply to me', () => {
    expect(repliesToMe(msg(7, { author: user('bob'), reply_to: partial() }), 'alice')).toBe(false)
  })
})
