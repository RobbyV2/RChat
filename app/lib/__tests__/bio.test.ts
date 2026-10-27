import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cachedProfile, profileKey, rememberProfile } from '../profile'
import { BIO_MAX, bioAnnouncement, bioError, charCount, cleanBio } from '../rules'
import { useStore } from '../store'
import { me, user } from './fixtures'

const st = () => useStore.getState()
const realFetch = globalThis.fetch
let sent: unknown[] = []
let reply: () => Response = () => new Response('{}')

beforeEach(() => {
  sent = []
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? 'null')))
    return reply()
  }) as typeof fetch
  useStore.setState({ me: me('alice'), guest: false, profile: null, error: null })
})

afterEach(() => {
  globalThis.fetch = realFetch
  useStore.setState({ me: null, profile: null })
})

describe('bio text', () => {
  test('cleans like the server: control characters, trimming and blank lines', () => {
    expect(cleanBio('  hi\u0007 there \r\n')).toBe('hi there')
    expect(cleanBio('a\n\n\n\n\nb\n\nc\nd')).toBe('a\n\nb\n\nc\nd')
    expect(cleanBio('a\r\n\r\n\r\nb')).toBe('a\n\nb')
    expect(cleanBio(' \n\t ')).toBe('')
  })

  test('counts code points after cleaning and rejects over the limit', () => {
    const max = 'é'.repeat(BIO_MAX)
    expect(charCount(cleanBio(`  ${max}\n\n\n`))).toBe(BIO_MAX)
    expect(bioError(max)).toBeNull()
    expect(bioError(`${'😀'.repeat(BIO_MAX)}`)).toBeNull()
    expect(bioError(`${max}x`)).toBe(`Description must be at most ${BIO_MAX} characters`)
    expect(bioError(`${'a'.repeat(94)}\n\n\n\n${'b'.repeat(94)}`)).toBeNull()
  })

  test('trims only White_Space like the server, so BOM and zero-width edges count', () => {
    expect(cleanBio('\u00a0\u2003hi\u3000\u2029')).toBe('hi')
    expect(cleanBio('\ufeffhi\u200b')).toBe('\ufeffhi\u200b')
    expect(cleanBio(' \ufeff ')).toBe('\ufeff')
    const edged = `\ufeff${'a'.repeat(BIO_MAX - 2)}\u200b`
    expect(charCount(edged)).toBe(BIO_MAX)
    expect(cleanBio(` ${edged}\n`)).toBe(edged)
    expect(bioError(` ${edged}\n`)).toBeNull()
    expect(bioError(`\ufeff${edged}`)).toBe(`Description must be at most ${BIO_MAX} characters`)
    expect(bioError(`${edged}\u2060`)).toBe(`Description must be at most ${BIO_MAX} characters`)
  })

  test('announces only near the limit, over it, or on save', () => {
    expect(bioAnnouncement(0, false)).toBe('')
    expect(bioAnnouncement(BIO_MAX - 21, false)).toBe('')
    expect(bioAnnouncement(BIO_MAX - 20, false)).toBe('20 characters left')
    expect(bioAnnouncement(BIO_MAX - 1, false)).toBe('1 character left')
    expect(bioAnnouncement(BIO_MAX, false)).toBe('0 characters left')
    expect(bioAnnouncement(BIO_MAX + 1, false)).toBe('1 character over the limit')
    expect(bioAnnouncement(BIO_MAX + 5, false)).toBe('5 characters over the limit')
    expect(bioAnnouncement(3, true)).toBe('Description saved')
  })
})

describe('bio in the store', () => {
  test('saving updates me, and a blank text clears it', async () => {
    reply = () => new Response(JSON.stringify({ ...user('alice'), banner_color: null, bio: 'Hi' }))
    expect(await st().setBio('Hi')).toBeNull()
    expect(st().me?.bio).toBe('Hi')
    reply = () => new Response(JSON.stringify({ ...user('alice'), banner_color: null, bio: null }))
    expect(await st().setBio('   ')).toBeNull()
    expect(await st().setBio('\ufeff')).toBeNull()
    expect(sent).toEqual([{ bio: 'Hi' }, { bio: null }, { bio: '\ufeff' }])
    expect(st().me?.bio).toBeNull()
  })

  test('a rejected description returns the error and keeps the old one', async () => {
    useStore.setState({ me: me('alice', { bio: 'old' }) })
    reply = () =>
      new Response(JSON.stringify({ error: 'Content blocked by profanity filter' }), {
        status: 400,
      })
    expect(await st().setBio('bad')).toBe('Content blocked by profanity filter')
    expect(st().me?.bio).toBe('old')
    expect(st().error).toBeNull()
  })

  test('a deleted or banned user loses their cached profile and bio', () => {
    const profile = (name: string) => ({
      user: user(name),
      banner_color: null,
      bio: `${name} bio`,
      created_at: 1,
      member: null,
    })
    for (const key of [profileKey('bob', null), profileKey('bob', 's'), profileKey('bobby', 's')])
      rememberProfile(key, profile(key.startsWith('bobby') ? 'bobby' : 'bob'))
    st().applyWsEvent({ type: 'banned', username: 'bob' })
    expect(cachedProfile(profileKey('bob', null))).toBeNull()
    expect(cachedProfile(profileKey('bob', 's'))).toBeNull()
    expect(cachedProfile(profileKey('bobby', 's'))?.bio).toBe('bobby bio')
  })

  test('a user update for the open card asks it to refetch', () => {
    st().openProfile(user('bob'), 's', 1, 2)
    expect(st().profile?.rev).toBeUndefined()
    const bob = { ...user('bob'), display_name: 'Bob' }
    st().applyWsEvent({ type: 'user_updated', user: bob })
    expect(st().profile).toEqual({ user: bob, server: 's', x: 1, y: 2, rev: 1 })
    st().applyWsEvent({ type: 'user_updated', user: user('carol') })
    st().applyWsEvent({ type: 'user_updated', user: bob })
    expect(st().profile?.rev).toBe(2)
  })
})
