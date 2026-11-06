import { describe, expect, test } from 'bun:test'
import {
  deliveryText,
  embedColor,
  fieldRows,
  isWebhookAuthor,
  isWebhookMessage,
  nameProblem,
  outgoingReach,
  outgoingUrl,
  takesOver,
  takeoverUrlProblem,
  TAKEOVER_URL,
  safeLink,
  urlProblem,
  webhookIdOf,
  webhookUrl,
  type Delivery,
} from '../webhooks'
import { ALL_PERMS, Perm } from '../types'
import { PERM_ITEMS } from '../rules'

const author = (username: string) => ({
  username,
  display_name: 'x',
  avatar_kind: 'identicon' as const,
  avatar_color: null,
})

describe('webhooks', () => {
  test('author keys are recognised and never collide with usernames', () => {
    expect(isWebhookAuthor('@webhook:12')).toBe(true)
    expect(isWebhookAuthor('webhook:12')).toBe(false)
    expect(isWebhookAuthor('alice')).toBe(false)
    expect(isWebhookAuthor(undefined)).toBe(false)
    expect(webhookIdOf('@webhook:12')).toBe(12)
    expect(webhookIdOf('@webhook:x')).toBeNull()
    expect(webhookIdOf('alice')).toBeNull()
    expect(isWebhookMessage({ author: author('@webhook:3'), webhook: null })).toBe(true)
    expect(isWebhookMessage({ author: author('bob'), webhook: { id: 3, embeds: [] } })).toBe(true)
    expect(isWebhookMessage({ author: author('bob') })).toBe(false)
  })

  test('the permission bit follows timeouts', () => {
    expect(Perm.ManageWebhooks).toBe(256)
    expect(ALL_PERMS).toBe(1023)
    expect(PERM_ITEMS.some(p => p.bit === Perm.ManageWebhooks)).toBe(true)
  })

  test('names and urls are checked before sending', () => {
    expect(nameProblem('  ')).toBe('Name is required')
    expect(nameProblem('x'.repeat(81))).toContain('80')
    expect(nameProblem('Instance Staff')).toBe('Pick another name')
    expect(nameProblem('Deploys')).toBeNull()
    expect(nameProblem('Instance\u00a0staff')).toBe('Pick another name')
    expect(nameProblem('Instance  staff')).toBe('Pick another name')
    expect(nameProblem('al\u200bice')).toBe('Name has invalid characters')
    expect(nameProblem('\u202ealice')).toBe('Name has invalid characters')
    expect(nameProblem('Café ☕')).toBeNull()
    expect(urlProblem('')).toBe('URL is required')
    expect(urlProblem('example.com')).toContain('full URL')
    expect(urlProblem('ftp://example.com')).toBe('URL must use https')
    expect(urlProblem('https://a:b@example.com/')).toBe('URL must not contain credentials')
    expect(urlProblem('https://example.com/#x')).toBe('URL must not contain a fragment')
    expect(urlProblem('https://example.com/hook')).toBeNull()
    expect(webhookUrl('https://chat.example/', '/api/webhooks/1/t')).toBe(
      'https://chat.example/api/webhooks/1/t'
    )
  })

  test('embeds render only safe links and valid colors', () => {
    expect(embedColor(255)).toBe('#0000ff')
    expect(embedColor(0xffffff + 1)).toBeNull()
    expect(embedColor(-1)).toBeNull()
    expect(embedColor(null)).toBeNull()
    expect(safeLink('javascript:alert(1)')).toBeNull()
    expect(safeLink('data:text/html,x')).toBeNull()
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a')
    expect(safeLink('nope')).toBeNull()
  })

  test('inline fields share rows of three', () => {
    const f = (inline: boolean) => ({ name: 'n', value: 'v', inline })
    expect(
      fieldRows([f(true), f(true), f(true), f(true), f(false), f(true)]).map(r => r.length)
    ).toEqual([3, 1, 1, 1])
  })

  test('delivery log lines show codes and timings, never bodies', () => {
    const d = (over: Partial<Delivery>): Delivery => ({
      id: 1,
      event: 'message.created',
      status: 'delivered',
      attempts: 1,
      last_code: 200,
      last_ms: 42,
      last_error: null,
      created_at: 1,
      next_at: null,
      finished_at: 2,
      ...over,
    })
    expect(deliveryText(d({}))).toBe('HTTP 200, 42 ms')
    expect(
      deliveryText(d({ status: 'pending', attempts: 0, last_code: null, last_ms: null }))
    ).toBe('Waiting')
    expect(deliveryText(d({ status: 'pending', attempts: 2, last_error: 'HTTP 500' }))).toBe(
      'Retrying (2 tries): HTTP 500'
    )
    expect(deliveryText(d({ status: 'failed', attempts: 6, last_error: 'timed out' }))).toBe(
      'Failed after 6 tries: timed out'
    )
  })
})

describe('webhook owners', () => {
  test('changes by anyone but the owner take it over', () => {
    expect(takesOver(author('alice'), 'alice')).toBe(false)
    expect(takesOver(author('alice'), 'Alice')).toBe(false)
    expect(takesOver(author('alice'), 'bob')).toBe(true)
    expect(takesOver(null, 'bob')).toBe(true)
  })

  test('only the URL and the events change what an outgoing webhook receives', () => {
    const hook = { url: 'https://a.example/x', events: ['message.created', 'member.joined'] }
    expect(
      outgoingReach(hook, {
        url: ' https://a.example/x ',
        events: ['member.joined', 'message.created'],
      })
    ).toBe(false)
    expect(outgoingReach(hook, { url: 'https://b.example/x', events: hook.events })).toBe(true)
    expect(outgoingReach(hook, { url: hook.url, events: ['message.created'] })).toBe(true)
  })

  test('a URL only its owner sees stays unless a new one is typed', () => {
    const hook = { url: 'https://a.example/', url_hidden: true, events: ['message.created'] }
    expect(outgoingUrl(hook, '  ')).toBeUndefined()
    expect(outgoingReach(hook, { url: '', events: hook.events })).toBe(false)
    expect(outgoingUrl(hook, ' https://b.example/x ')).toBe('https://b.example/x')
    expect(outgoingReach(hook, { url: 'https://b.example/x', events: hook.events })).toBe(true)
    expect(outgoingUrl({ ...hook, url_hidden: false }, '')).toBe('')
  })

  test('taking a webhook over requires its whole URL', () => {
    expect(takeoverUrlProblem('')).toBe(TAKEOVER_URL)
    expect(takeoverUrlProblem('   ')).toBe(TAKEOVER_URL)
    expect(takeoverUrlProblem('http://a.example/x')).toBe(urlProblem('http://a.example/x'))
    expect(takeoverUrlProblem(' https://a.example/hooks/1 ')).toBeNull()
  })
})
