import { describe, expect, test } from 'bun:test'
import data from 'emojibase-data/en/data.json'
import github from 'emojibase-data/en/shortcodes/github.json'
import emojibase from 'emojibase-data/en/shortcodes/emojibase.json'
import {
  DEFAULT_TOP,
  EMPTY_PREFS,
  HALF_LIFE_MS,
  MAX_USED,
  findShortcode,
  frecency,
  frequent,
  fromEmojibase,
  gridMove,
  matchShortcodes,
  noteUse,
  parseEmojiPrefs,
  searchEmoji,
  sectionHeight,
  sections,
  setTone,
  shortcodeOf,
  topEmojis,
  withTone,
  type RawEmoji,
  type ShortcodeMap,
} from '../emoji'

const tones = (base: string) =>
  [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map((m, i) => ({
    emoji: base + String.fromCodePoint(m),
    tone: i + 1,
    version: 1,
  }))

const RAW: RawEmoji[] = [
  {
    emoji: '😀',
    label: 'grinning face',
    hexcode: '1F600',
    group: 0,
    order: 1,
    tags: ['face', 'grin'],
    version: 1,
  },
  {
    emoji: '😄',
    label: 'grinning face with smiling eyes',
    hexcode: '1F604',
    group: 0,
    order: 3,
    tags: ['happy', 'smile'],
    version: 0.6,
  },
  {
    emoji: '😃',
    label: 'grinning face with big eyes',
    hexcode: '1F603',
    group: 0,
    order: 2,
    tags: ['happy', 'mouth'],
    version: 0.6,
  },
  {
    emoji: '😏',
    label: 'smirking face',
    hexcode: '1F60F',
    group: 0,
    order: 4,
    tags: ['smirk'],
    version: 0.6,
  },
  {
    emoji: '👋',
    label: 'waving hand',
    hexcode: '1F44B',
    group: 1,
    order: 5,
    tags: ['hello', 'wave'],
    version: 0.6,
    skins: tones('👋'),
  },
  {
    emoji: '🐱',
    label: 'cat face',
    hexcode: '1F431',
    group: 3,
    order: 6,
    tags: ['cat', 'pet'],
    version: 0.6,
  },
  {
    emoji: '🫩',
    label: 'face with bags under eyes',
    hexcode: '1FAE9',
    group: 0,
    order: 7,
    tags: ['tired'],
    version: 16,
  },
  { emoji: '🏻', label: 'light skin tone', hexcode: '1F3FB', group: 2, order: 8, version: 1 },
  { emoji: '🇦', label: 'regional indicator A', hexcode: '1F1E6', version: 0 },
  {
    emoji: '🏁',
    label: 'chequered flag',
    hexcode: '1F3C1',
    group: 9,
    order: 9,
    tags: ['racing'],
    version: 0.6,
  },
]

const CODES: ShortcodeMap = {
  '1F600': 'grinning',
  '1F604': 'smile',
  '1F603': 'smiley',
  '1F60F': 'smirk',
  '1F44B': ['wave'],
  '1F431': ['cat', 'cat_face'],
  '1F3C1': 'checkered_flag',
}
const EXTRA: ShortcodeMap = {
  '1F604': ['grinning_face_with_closed_eyes', 'smile'],
  '1FAE9': 'tired_face',
}

const list = fromEmojibase(RAW, [CODES, EXTRA])
const real = fromEmojibase(data as unknown as RawEmoji[], [
  github as ShortcodeMap,
  emojibase as ShortcodeMap,
])
const glyphs = (l: { emoji: string }[]) => l.map(e => e.emoji)

describe('dataset', () => {
  test('keeps picker groups in order and drops components and regional letters', () => {
    expect(glyphs(list)).toEqual(['😀', '😃', '😄', '😏', '👋', '🐱', '🫩', '🏁'])
    expect([...sections(list).keys()]).toEqual(['people', 'nature', 'flags'])
    expect(list.find(e => e.emoji === '🐱')?.shortcodes).toEqual(['cat', 'cat_face'])
    expect(list.find(e => e.emoji === '😄')?.shortcodes).toEqual([
      'smile',
      'grinning_face_with_closed_eyes',
    ])
  })

  test('drops emoji newer than the platform renders', () => {
    expect(glyphs(fromEmojibase(RAW, [CODES], 15.1)).includes('🫩')).toBe(false)
  })

  test('real data covers every category with shortcodes and skins', () => {
    expect(real.length > 1800).toBe(true)
    expect([...sections(real).keys()].sort()).toEqual([
      'activities',
      'flags',
      'food',
      'nature',
      'objects',
      'people',
      'symbols',
      'travel',
    ])
    expect(real.every(e => e.shortcodes.length > 0)).toBe(true)
    const thumbs = real.find(e => e.emoji === '👍')
    expect(thumbs && shortcodeOf(thumbs)).toBe('thumbsup')
    expect(thumbs?.skins).toHaveLength(5)
    for (const d of DEFAULT_TOP) expect(real.some(e => e.emoji === d)).toBe(true)
  })
})

describe('search ranking', () => {
  test('exact shortcode beats prefix beats keyword beats substring', () => {
    expect(glyphs(searchEmoji(list, 'smile'))).toEqual(['😄', '😃'])
    expect(glyphs(searchEmoji(list, 'smi'))).toEqual(['😃', '😄', '😏'])
    expect(glyphs(searchEmoji(list, 'grin'))).toEqual(['😀', '😄', '😃'])
    expect(glyphs(searchEmoji(list, 'rinn'))).toEqual(['😀', '😃', '😄'])
    expect(glyphs(searchEmoji(list, 'happy'))).toEqual(['😃', '😄'])
  })

  test('every word must match and colons are ignored', () => {
    expect(glyphs(searchEmoji(list, 'grinning big'))).toEqual(['😃'])
    expect(glyphs(searchEmoji(list, ':wave:'))).toEqual(['👋'])
    expect(searchEmoji(list, 'nothing here')).toEqual([])
    expect(searchEmoji(list, '  ')).toEqual([])
  })

  test('pasting the emoji itself finds it, skin tones included', () => {
    expect(glyphs(searchEmoji(list, '👋🏽'))).toEqual(['👋'])
  })

  test('frecency breaks ties between equal matches', () => {
    const prefs = noteUse(EMPTY_PREFS, '😏', '😏', 1000)
    const boost = (e: { emoji: string }) => (prefs.used[e.emoji] ? 1 : 0)
    expect(glyphs(searchEmoji(list, 'face', boost))[0]).toBe('😏')
  })

  test('real data ranks the obvious emoji first', () => {
    expect(searchEmoji(real, 'thumbsup')[0].emoji).toBe('👍')
    expect(searchEmoji(real, 'heart')[0].emoji).toBe('❤️')
    expect(searchEmoji(real, 'cat')[0].emoji).toBe('🐱')
  })
})

describe('shortcodes', () => {
  test('prefix matches come before word and substring matches', () => {
    expect(matchShortcodes(list, 'sm').map(m => m.code)).toEqual(['smiley', 'smile', 'smirk'])
    expect(matchShortcodes(list, 'face').map(m => m.code)).toEqual([
      'grinning_face_with_closed_eyes',
      'cat_face',
      'tired_face',
    ])
    expect(matchShortcodes(list, 'sm', 2)).toHaveLength(2)
  })

  test('an exact code wins and frecency reorders the rest', () => {
    expect(matchShortcodes(list, 'smile')[0].code).toBe('smile')
    const boost = (e: { emoji: string }) => (e.emoji === '😏' ? 5 : 0)
    expect(matchShortcodes(list, 'sm', 10, boost).map(m => m.code)).toEqual([
      'smirk',
      'smiley',
      'smile',
    ])
  })

  test('findShortcode resolves every alias', () => {
    expect(findShortcode(list, 'cat_face')?.emoji).toBe('🐱')
    expect(findShortcode(list, 'Smile')?.emoji).toBe('😄')
    expect(findShortcode(list, 'nope')).toBeNull()
    expect(findShortcode(real, 'joy')?.emoji).toBe('😂')
    expect(matchShortcodes(real, 'sm').length).toBe(10)
  })
})

describe('skin tones', () => {
  test('applies a tone only to emoji that support it', () => {
    const wave = list.find(e => e.emoji === '👋')!
    const cat = list.find(e => e.emoji === '🐱')!
    expect(withTone(wave, 0)).toBe('👋')
    expect(withTone(wave, 3)).toBe('👋🏽')
    expect(withTone(wave, 9)).toBe('👋')
    expect(withTone(cat, 3)).toBe('🐱')
  })

  test('multi person emoji use the matching uniform tone', () => {
    const couple = real.find(e => e.name === 'people holding hands')!
    expect(couple.skins).toHaveLength(5)
    expect(withTone(couple, 5)).toBe('🧑🏿‍🤝‍🧑🏿')
  })

  test('setTone validates the value', () => {
    expect(setTone(EMPTY_PREFS, 2).tone).toBe(2)
    expect(setTone(EMPTY_PREFS, 7)).toBe(EMPTY_PREFS)
    expect(setTone(EMPTY_PREFS, 1.5)).toBe(EMPTY_PREFS)
  })
})

describe('frecency', () => {
  const day = 86_400_000

  test('counts uses and remembers the last variant', () => {
    let p = noteUse(EMPTY_PREFS, '👋', '👋', 0)
    p = noteUse(p, '👋', '👋🏽', day)
    expect(p.used['👋']).toEqual({ n: 2, at: day, last: '👋🏽' })
  })

  test('orders by count and decays with age', () => {
    let p = EMPTY_PREFS
    for (let i = 0; i < 4; i++) p = noteUse(p, '😀', '😀', 0)
    p = noteUse(p, '🐱', '🐱', 0)
    expect(frequent(p, 5, 0)).toEqual(['😀', '🐱'])
    p = noteUse(p, '🐱', '🐱', 30 * day)
    expect(frequent(p, 5, 30 * day)).toEqual(['🐱', '😀'])
    expect(Math.round(frecency({ n: 4, at: 0, last: 'x' }, HALF_LIFE_MS) * 1000)).toBe(2000)
    expect(frecency({ n: 4, at: 10, last: 'x' }, 0)).toBe(4)
  })

  test('a newer single use edges out an older one', () => {
    let p = noteUse(EMPTY_PREFS, '😀', '😀', 0)
    p = noteUse(p, '🐱', '🐱', day)
    expect(frequent(p, 1, day)).toEqual(['🐱'])
  })

  test('keeps at most MAX_USED entries, dropping the weakest', () => {
    let p = noteUse(EMPTY_PREFS, 'keep', 'keep', 0)
    p = noteUse(p, 'keep', 'keep', 0)
    for (let i = 0; i < MAX_USED; i++) p = noteUse(p, `e${i}`, `e${i}`, i)
    expect(Object.keys(p.used)).toHaveLength(MAX_USED)
    expect(p.used.keep === undefined).toBe(false)
    expect(p.used.e0).toBeUndefined()
    expect(p.used[`e${MAX_USED - 1}`] === undefined).toBe(false)
    for (let i = 0; i < 5; i++) p = noteUse(p, 'keep', 'keep', 100)
    p = noteUse(p, 'fresh', 'fresh', 100)
    expect(p.used.fresh === undefined).toBe(false)
  })

  test('topEmojis falls back to the defaults and returns the variant used', () => {
    expect(topEmojis(3)).toEqual(['👍', '😂', '❤️'])
    expect(topEmojis(2)).toEqual(['👍', '😂'])
    let p = noteUse(EMPTY_PREFS, '👋', '👋🏾', 0)
    p = noteUse(p, '👋', '👋🏾', 0)
    p = noteUse(p, '😂', '😂', 0)
    expect(topEmojis(3, p, 0)).toEqual(['👋🏾', '😂', '👍'])
    expect(topEmojis(1, p, 0)).toEqual(['👋🏾'])
  })
})

describe('stored prefs', () => {
  test('bad input falls back to defaults', () => {
    expect(parseEmojiPrefs(null)).toEqual(EMPTY_PREFS)
    expect(parseEmojiPrefs('{')).toEqual(EMPTY_PREFS)
    expect(parseEmojiPrefs('[]')).toEqual(EMPTY_PREFS)
    expect(parseEmojiPrefs('{"v":2,"tone":3}')).toEqual(EMPTY_PREFS)
  })

  test('keeps valid entries and drops broken ones', () => {
    const raw = JSON.stringify({
      v: 1,
      tone: 9,
      used: {
        '😀': { n: 3, at: 5, last: '😀' },
        '🐱': { n: 'x', at: 5, last: '🐱' },
        '👋': { n: 1, at: 5 },
        '': { n: 1, at: 5, last: 'x' },
      },
    })
    expect(parseEmojiPrefs(raw)).toEqual({
      v: 1,
      tone: 0,
      used: { '😀': { n: 3, at: 5, last: '😀' } },
    })
    expect(parseEmojiPrefs(JSON.stringify({ v: 1, tone: 4, used: [] })).tone).toBe(4)
  })

  test('round trips', () => {
    const p = setTone(noteUse(EMPTY_PREFS, '👋', '👋🏻', 7), 1)
    expect(parseEmojiPrefs(JSON.stringify(p))).toEqual(p)
  })
})

describe('grid keyboard movement', () => {
  const sizes = [3, 0, 10, 4]
  test('left and right walk across sections, skipping empty ones', () => {
    expect(gridMove(sizes, 4, { s: 0, i: 2 }, 'right')).toEqual({ s: 2, i: 0 })
    expect(gridMove(sizes, 4, { s: 2, i: 0 }, 'left')).toEqual({ s: 0, i: 2 })
    expect(gridMove(sizes, 4, { s: 0, i: 0 }, 'left')).toEqual({ s: 0, i: 0 })
    expect(gridMove(sizes, 4, { s: 3, i: 3 }, 'right')).toEqual({ s: 3, i: 3 })
  })

  test('up and down keep the column across section edges', () => {
    expect(gridMove(sizes, 4, { s: 2, i: 1 }, 'down')).toEqual({ s: 2, i: 5 })
    expect(gridMove(sizes, 4, { s: 2, i: 7 }, 'down')).toEqual({ s: 2, i: 9 })
    expect(gridMove(sizes, 4, { s: 2, i: 9 }, 'down')).toEqual({ s: 3, i: 1 })
    expect(gridMove(sizes, 4, { s: 3, i: 3 }, 'up')).toEqual({ s: 2, i: 9 })
    expect(gridMove(sizes, 4, { s: 3, i: 1 }, 'up')).toEqual({ s: 2, i: 9 })
    expect(gridMove(sizes, 4, { s: 2, i: 3 }, 'up')).toEqual({ s: 0, i: 2 })
    expect(gridMove(sizes, 4, { s: 0, i: 1 }, 'up')).toEqual({ s: 0, i: 1 })
    expect(gridMove(sizes, 4, { s: 3, i: 2 }, 'down')).toEqual({ s: 3, i: 2 })
  })
})

describe('section size', () => {
  test('rows round up and include the header', () => {
    expect(sectionHeight(3, 9, 40, 34)).toBe(74)
    expect(sectionHeight(9, 9, 40, 34)).toBe(74)
    expect(sectionHeight(10, 9, 40, 34)).toBe(114)
    expect(sectionHeight(10, 0, 40, 34)).toBe(434)
  })
})
