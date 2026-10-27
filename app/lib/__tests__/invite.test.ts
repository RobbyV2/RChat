import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  findInvites,
  findRemoteInvites,
  entryState,
  handoffFor,
  hostParts,
  inviteEntry,
  INVITE_GAP,
  INVITE_MAX_WAIT,
  INVITE_QUIET,
  inviteVersion,
  invitePath,
  inviteUrl,
  parseInvite,
  parseInviteAt,
  previewText,
  remoteInviteUrl,
  keepsPreview,
  refreshDelay,
  remoteKey,
  safeNext,
  staleInvites,
  watchInvites,
} from '../invite'

const ORIGIN = 'https://chat.example.com'

const renderedHrefs = (text: string) =>
  Array.from(
    renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text)).matchAll(
      /href="([^"]*)"/g
    ),
    m => m[1].replace(/&amp;/g, '&')
  )

describe('inviteUrl', () => {
  test('builds a path-encoded link without a password', () => {
    expect(inviteUrl('rchat', undefined, ORIGIN)).toBe('https://chat.example.com/invite/rchat/')
    expect(inviteUrl('café & co', null, ORIGIN)).toBe(
      'https://chat.example.com/invite/caf%C3%A9%20%26%20co/'
    )
  })

  test('adds a trimmed, encoded password and skips blank ones', () => {
    expect(inviteUrl('club', ' s3cret ', ORIGIN)).toBe(
      'https://chat.example.com/invite/club/?password=s3cret'
    )
    expect(inviteUrl('club', '   ', ORIGIN)).toBe('https://chat.example.com/invite/club/')
    expect(inviteUrl('club', 'a&b=c d', ORIGIN)).toBe(
      'https://chat.example.com/invite/club/?password=a%26b%3Dc%20d'
    )
  })

  test('encodes punctuation that chat text would trim', () => {
    expect(invitePath("it's (fun)!")).toBe('/invite/it%27s%20%28fun%29%21/')
    expect(inviteUrl('x', 'pw)', ORIGIN)).toBe('https://chat.example.com/invite/x/?password=pw%29')
    expect(inviteUrl('x', 'a.b_c-d~', ORIGIN)).toBe(
      'https://chat.example.com/invite/x/?password=a%2Eb%5Fc%2Dd%7E'
    )
  })

  test('passwords ending in any punctuation survive chat trimming and autolinking', () => {
    const marks = Array.from('.,;:!?*_~-|\'"`()[]{}<>&#%+=/\\@$^')
    for (const mark of marks) {
      for (const password of [`secret${mark}`, `x${mark}${mark}`, mark]) {
        const url = inviteUrl('vault', password, ORIGIN)
        expect(/[A-Za-z0-9]$/.test(url)).toBe(true)
        for (const text of [
          `join ${url}`,
          `join ${url}.`,
          `(${url})`,
          `**${url}**`,
          `${url}_`,
          `${url}?!`,
        ]) {
          expect(findInvites(text, ORIGIN).map(i => i.password)).toEqual([password])
          expect(renderedHrefs(text).map(h => parseInvite(h, ORIGIN)?.password)).toEqual([password])
        }
      }
    }
  })
})

describe('parseInvite', () => {
  test('round-trips links built by inviteUrl', () => {
    for (const [server, password] of [
      ['rchat', null],
      ['café & co', 'p@ss word'],
      ["it's (fun)!", 'pw)'],
      ['a/b?c#d', 'é'],
    ] as const) {
      expect(parseInvite(inviteUrl(server, password, ORIGIN), ORIGIN)).toEqual({
        server,
        password,
      })
    }
  })

  test('accepts same-origin paths and lowercases the server', () => {
    expect(parseInvite('/invite/Club/', ORIGIN)).toEqual({ server: 'club', password: null })
    expect(parseInvite('/invite/club', ORIGIN)).toEqual({ server: 'club', password: null })
    expect(parseInvite('/invite/club/?password=', ORIGIN)).toEqual({
      server: 'club',
      password: null,
    })
    expect(
      parseInvite('https://chat.example.com/invite/club/?x=1&password=pw#top', ORIGIN)
    ).toEqual({ server: 'club', password: 'pw' })
  })

  test('ignores other origins, schemes and paths', () => {
    for (const bad of [
      'https://evil.example.com/invite/club/',
      'http://chat.example.com/invite/club/',
      '//evil.example.com/invite/club/',
      'invite/club/',
      'javascript:alert(1)',
      '/invite/',
      '/invite/club/extra/',
      '/s/club/1/',
      '/invite/%E0%A4%A/',
      '/invite/%20/',
      'not a url',
    ]) {
      expect(parseInvite(bad, ORIGIN)).toBeNull()
    }
  })
})

describe('findInvites', () => {
  test('pulls same-origin invite links out of message text', () => {
    const text = [
      'join us: https://chat.example.com/invite/club/?password=pw.',
      '(also https://chat.example.com/invite/Other/)',
      'and **https://chat.example.com/invite/bold/**',
      'not https://evil.example.com/invite/club/ or https://chat.example.com/s/club/1/',
    ].join('\n')
    expect(findInvites(text, ORIGIN).map(i => [i.server, i.password])).toEqual([
      ['club', 'pw'],
      ['other', null],
      ['bold', null],
    ])
  })

  test('dedupes by server and caps the count', () => {
    const link = (s: string) => `https://chat.example.com/invite/${s}/`
    const text = [link('a'), link('A'), link('b'), link('c'), link('d')].join(' ')
    expect(findInvites(text, ORIGIN).map(i => i.server)).toEqual(['a', 'b', 'c'])
    expect(findInvites(text, ORIGIN, 10).map(i => i.server)).toEqual(['a', 'b', 'c', 'd'])
    expect(findInvites('no links here', ORIGIN)).toEqual([])
  })

  test('markdown links keep their url intact', () => {
    expect(
      findInvites('[come](https://chat.example.com/invite/club/)', ORIGIN).map(i => i.url)
    ).toEqual(['https://chat.example.com/invite/club/'])
  })

  test('skips links inside code and spoilers', () => {
    const link = (s: string) => `https://chat.example.com/invite/${s}/`
    const text = [
      `inline \`${link('code')}\` and \`\` ${link('double')} \` \`\` but ${link('one')}`,
      '````sh',
      link('fenced'),
      '```',
      link('still'),
      '````',
      '> ~~~',
      `> ${link('quoted')}`,
      '> ~~~',
      '',
      `    ${link('indented')}`,
      '',
      `||${link('spoiler')}|| and || [x](${link('hidden')}) ||`,
      `||${link('a')}\n\n${link('two')}||`,
      '- item',
      '',
      `    ${link('listed')}`,
      `text\n    ${link('lazy')}`,
      '``` never closed',
      link('tail'),
    ].join('\n')
    expect(findInvites(text, ORIGIN, 10).map(i => i.server)).toEqual([
      'one',
      'a',
      'two',
      'listed',
      'lazy',
    ])
    expect(findInvites('`a` https://chat.example.com/invite/b/ `c`', ORIGIN)).toHaveLength(1)
  })
})

describe('safeNext', () => {
  test('keeps same-site paths', () => {
    expect(safeNext('/invite/club/')).toBe('/invite/club/')
    expect(safeNext('/s/rchat/1/?q=1')).toBe('/s/rchat/1/?q=1')
  })

  test('rejects anything that could leave the site', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'https://evil.example.com/',
      '//evil.example.com/',
      '/\\evil.example.com/',
      'javascript:alert(1)',
      '/ok\nbad',
    ]) {
      expect(safeNext(bad)).toBeNull()
    }
  })
})

describe('previewText', () => {
  test('flattens markdown into one line', () => {
    expect(previewText('# Title\n> quoted **bold** `code`\n\n  more ~~text~~')).toBe(
      'Title quoted bold code more text'
    )
  })

  test('masks spoilers', () => {
    expect(previewText('the end is ||a twist|| ok')).toBe(`the end is ${'█'.repeat(7)} ok`)
    expect(previewText('||x||')).toBe('█'.repeat(3))
  })
})

describe('handoffFor', () => {
  const raw = (o: object) => JSON.stringify(o)
  const saved = raw({ server: 'vault', password: 'pw', at: 1000 })

  test('returns a fresh handoff for the same server', () => {
    expect(handoffFor(saved, 'vault', 1000)).toEqual({ server: 'vault', password: 'pw' })
    expect(handoffFor(raw({ server: 'vault', password: null, at: 0 }), 'vault', 5000)).toEqual({
      server: 'vault',
      password: null,
    })
  })

  test('ignores stale, future, foreign or malformed handoffs', () => {
    expect(handoffFor(saved, 'vault', 1000 + 10 * 60 * 1000)).toBeNull()
    expect(handoffFor(saved, 'vault', 999)).toBeNull()
    expect(handoffFor(saved, 'club', 1000)).toBeNull()
    expect(handoffFor(raw({ server: 'vault', password: 'pw', join: true }), 'vault', 0)).toBeNull()
    expect(handoffFor('{', 'vault', 1000)).toBeNull()
    expect(handoffFor(null, 'vault', 1000)).toBeNull()
  })
})

describe('inviteEntry', () => {
  test('reads the invite saved on a history entry', () => {
    const entry = { server: 'vault', password: 'pw', pushed: true }
    const state = { __NA: true, ...entryState(entry) }
    expect(inviteEntry(state, 'vault')).toEqual(entry)
    expect(inviteEntry(entryState({ ...entry, password: null, pushed: false }), 'vault')).toEqual({
      server: 'vault',
      password: null,
      pushed: false,
    })
  })

  test('ignores other servers and foreign state', () => {
    const state = entryState({ server: 'vault', password: 'pw', pushed: true })
    expect(inviteEntry(state, 'club')).toBeNull()
    for (const other of [null, undefined, {}, { __NA: true }, 'x', { rchatInvite: 'vault' }]) {
      expect(inviteEntry(other, 'vault')).toBeNull()
    }
    expect(
      inviteEntry({ rchatInvite: { server: 'vault', password: 3, pushed: 'yes' } }, 'vault')
    ).toEqual({ server: 'vault', password: null, pushed: false })
  })
})

describe('remote invites', () => {
  const LOCAL = [ORIGIN, 'http://127.0.0.1:3821']

  test('parseInviteAt keeps the origin of any http(s) invite link', () => {
    expect(parseInviteAt('http://127.0.0.1:3831/invite/Club/?password=pw', ORIGIN)).toEqual({
      origin: 'http://127.0.0.1:3831',
      server: 'club',
      password: 'pw',
      url: 'http://127.0.0.1:3831/invite/Club/?password=pw',
    })
    expect(parseInviteAt('/invite/club/', ORIGIN)?.origin).toBe(ORIGIN)
    expect(parseInviteAt('ftp://x.example/invite/club/', ORIGIN)).toBeNull()
    expect(parseInviteAt('https://u:p@x.example/invite/club/', ORIGIN)).toBeNull()
    expect(parseInviteAt('https://x.example/invite/club/more', ORIGIN)).toBeNull()
  })

  test('finds invite links to other origins, skipping local ones and duplicates', () => {
    const text = [
      'local https://chat.example.com/invite/a/',
      'home http://127.0.0.1:3821/invite/b/',
      'remote http://127.0.0.1:3831/invite/c/?password=x.',
      'again http://127.0.0.1:3831/invite/C/',
      'other https://b.example/invite/c/',
      '`https://code.example/invite/z/`',
    ].join('\n')
    const any = () => true
    const found = findRemoteInvites(text, LOCAL, any)
    expect(found.map(remoteKey)).toEqual(['http://127.0.0.1:3831\nc', 'https://b.example\nc'])
    expect(found[0].password).toBe('x')
    expect(found[0].url).toBe('http://127.0.0.1:3831/invite/c/?password=x')
    expect(remoteInviteUrl(found[0])).toBe('http://127.0.0.1:3831/invite/c/?password=x')
    expect(findRemoteInvites('no links here', LOCAL, any)).toEqual([])
    const many = Array.from({ length: 5 }, (_, i) => `https://h${i}.example/invite/s/`).join(' ')
    expect(findRemoteInvites(many, LOCAL, any)).toHaveLength(3)
    const httpsOnly = (o: string) => o.startsWith('https:')
    expect(findRemoteInvites(text, LOCAL, httpsOnly).map(remoteKey)).toEqual([
      'https://b.example\nc',
    ])
  })
})

describe('invite preview freshness', () => {
  test('a server bump changes only that server, a global bump changes all', () => {
    const a = inviteVersion('a')
    const b = inviteVersion('b')
    let calls = 0
    const stop = watchInvites(() => (calls += 1))
    staleInvites('a')
    expect(inviteVersion('a') > a).toBe(true)
    expect(inviteVersion('b')).toBe(b)
    const a2 = inviteVersion('a')
    staleInvites(null)
    expect(inviteVersion('a') > a2).toBe(true)
    expect(inviteVersion('b') > b).toBe(true)
    stop()
    staleInvites('a')
    expect(calls).toBe(2)
  })
})

describe('host parts', () => {
  test('splits out every host so it can be blurred', () => {
    expect(hostParts('x.co claims to be another site', 'x.co')).toEqual([
      { text: 'x.co', host: true },
      { text: ' claims to be another site', host: false },
    ])
    expect(hostParts("Can't reach x.co", 'x.co')).toEqual([
      { text: "Can't reach ", host: false },
      { text: 'x.co', host: true },
    ])
    expect(hostParts('plain', '')).toEqual([{ text: 'plain', host: false }])
  })
})

describe('invite refresh pacing', () => {
  test('waits for a quiet spell after the last change', () => {
    expect(refreshDelay(0, 0, -INVITE_GAP, 0)).toBe(INVITE_QUIET)
    expect(refreshDelay(0, 1_500, -INVITE_GAP, 2_000)).toBe(INVITE_QUIET - 500)
  })

  test('a steady stream of changes still refreshes after the max wait', () => {
    const since = 0
    const bump = INVITE_MAX_WAIT - 100
    expect(refreshDelay(since, bump, -INVITE_GAP, bump)).toBe(100)
    expect(refreshDelay(since, INVITE_MAX_WAIT + 5_000, -INVITE_GAP, INVITE_MAX_WAIT + 5_000)).toBe(
      0
    )
  })

  test('never refetches sooner than the gap after the last fetch', () => {
    expect(refreshDelay(1_000, 1_000, 0, 1_000)).toBe(INVITE_GAP - 1_000)
    expect(refreshDelay(30_000, 30_000, 0, 30_000)).toBe(INVITE_QUIET)
  })

  test('a burst of 100 changes costs at most one fetch per gap', () => {
    let fetchedAt = -INVITE_GAP
    let fetches = 0
    let since: number | null = null
    let bump = 0
    for (let now = 0; now < 60_000; now += 100) {
      if (now % 600 === 0) {
        since ??= now
        bump = now
      }
      if (since !== null && refreshDelay(since, bump, fetchedAt, now) === 0) {
        fetches += 1
        fetchedAt = now
        since = null
      }
    }
    expect(fetches <= Math.ceil(60_000 / INVITE_GAP) + 1).toBe(true)
    expect(fetches > 0).toBe(true)
  })
})

test('a failed refresh keeps the last preview unless the invite is gone', () => {
  expect(keepsPreview(null)).toBe(true)
  expect(keepsPreview(429)).toBe(true)
  expect(keepsPreview(503)).toBe(true)
  expect(keepsPreview(404)).toBe(false)
  expect(keepsPreview(403)).toBe(false)
})
