import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EMBEDS_MAX,
  embedFallback,
  embedOfDraft,
  embedsProblem,
  emptyDraft,
  embField,
  movedField,
  readEmbeds,
  sentBody,
  shownBody,
  shownEmbeds,
  withoutCard,
  cardsOf,
} from '../rich_embeds'
import { legibleAccent, previewAccent, siteColor, CARD_SURFACE } from '../embed_colors'
import { contrast, MIN_NON_TEXT } from '../server_colors'
import { formatKey } from '../format'
import type { Message, RichEmbed } from '../types'

const cases = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      '..',
      'assets',
      'rich_embed_cases.json'
    ),
    'utf8'
  )
) as { max: number; cases: { name: string; embeds: RichEmbed[]; error: string | null }[] }

describe('rich embeds are checked as the server checks them', () => {
  test('the shared cases give the same answer', () => {
    expect(cases.max).toBe(EMBEDS_MAX)
    expect(cases.cases.length).toBeGreaterThan(20)
    for (const c of cases.cases)
      expect([c.name, embedsProblem(c.embeds, cases.max)]).toEqual([c.name, c.error])
  })
})

describe('the embeds a P2P message carries', () => {
  const card: RichEmbed = { title: 'Release', color: 0xff0000 }

  test('malformed ones are left out without failing the rest', () => {
    const read = readEmbeds([
      card,
      { title: 7 },
      { fields: [{ name: 'x' }] },
      'text',
      { description: 'kept', future: { anything: true } },
    ])
    expect(read).toEqual([card, { description: 'kept' }])
    expect(readEmbeds('nope')).toEqual([])
    expect(readEmbeds(undefined)).toEqual([])
  })

  test('only as many as a message may have are read', () => {
    expect(readEmbeds(Array.from({ length: 9 }, () => card)).length).toBe(EMBEDS_MAX)
  })

  test('a message of embeds alone carries the fallback text, which is not shown again', () => {
    const body = sentBody('  ', [card])
    expect(body).toBe('Release')
    expect(shownBody(body, [card])).toBe('')
    expect(shownBody('own words', [card])).toBe('own words')
    expect(sentBody('own words', [card])).toBe('own words')
    expect(embedFallback([{ fields: [{ name: 'Name', value: 'v' }] }])).toBe('Name')
  })

  test("an edit's embeds win over the message's, and an edit without them keeps them", () => {
    const msg = { body: 'Release', ...embField([card]) }
    expect(shownEmbeds(msg, null)).toEqual([card])
    expect(shownEmbeds(msg, { target: 'x', body: 'Release' })).toEqual([card])
    expect(shownEmbeds(msg, { target: 'x', body: 'a', emb: [] })).toEqual([])
    expect(embField([])).toEqual({})
  })
})

describe('the builder', () => {
  test('an empty draft is an empty embed, and blank parts are left out', () => {
    expect(embedsProblem([embedOfDraft(emptyDraft(), 10)])).toBe('Embed is empty')
    const e = embedOfDraft(
      { ...emptyDraft(), title: ' T ', author: ' ', footer: 'f', stamped: true, color: '#00ff00' },
      42
    )
    expect(e).toEqual({ title: 'T', color: 0x00ff00, footer: { text: 'f' }, timestamp: 42 })
  })

  test('fields move within the list', () => {
    expect(movedField(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(movedField(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })

  test('a card is taken off a message by its index', () => {
    const m = { rich_embeds: [{ title: 'a' }, { title: 'b' }], webhook: null } as Pick<
      Message,
      'rich_embeds' | 'webhook'
    >
    expect(cardsOf(withoutCard(m, 0))).toEqual([{ title: 'b' }])
  })
})

describe('the bar color of a card', () => {
  test("a page's own color comes first, then a known site's", () => {
    expect(previewAccent({ url: 'https://example.com', color: '#123456' }, 'dark')).not.toBeNull()
    expect(siteColor('https://www.youtube.com/watch?v=1', 'dark')).toBe('#ff0000')
    expect(siteColor('https://x.com/a', 'light')).toBe('#0f1419')
    expect(siteColor('https://example.com', 'dark')).toBeNull()
    expect(previewAccent({ url: 'https://example.com', color: null }, 'dark')).toBeNull()
  })

  test('a bar always stands out from the card in both themes', () => {
    for (const theme of ['dark', 'light'] as const)
      for (const color of ['#ffffff', '#000000', '#211f26', '#f3edf7', '#ff0000'])
        expect(contrast(legibleAccent(color, theme), CARD_SURFACE[theme])).toBeGreaterThanOrEqual(
          MIN_NON_TEXT
        )
  })
})

test('Mod+Shift+K makes a link', () => {
  expect(
    formatKey({ key: 'K', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false)
  ).toBe('link')
})
