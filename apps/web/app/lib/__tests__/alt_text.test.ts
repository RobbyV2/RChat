import { describe, expect, test } from 'bun:test'
import {
  ALT_MAX,
  altError,
  altText,
  altToSend,
  altsEdit,
  describable,
  describableFile,
  editAlts,
  editAltsFor,
  withAlts,
} from '../alt_text'

describe('image descriptions', () => {
  test('a description is cleaned, cut at the limit, and blank is none', () => {
    expect(altText('  A cat\u0007 on a mat\n\n\n\nasleep  ')).toBe('A cat on a mat\n\nasleep')
    expect(altText('   ')).toBeNull()
    expect(altText(7)).toBeNull()
    expect(Array.from(altText('\u{1F431}'.repeat(ALT_MAX + 3))!).length).toBe(ALT_MAX)
    expect(altError('x'.repeat(ALT_MAX))).toBeNull()
    expect(altError('x'.repeat(ALT_MAX + 1))).toBe(
      'Image description must be at most 1000 characters'
    )
    expect(altToSend(' ')).toBeUndefined()
    expect(altToSend(undefined)).toBeUndefined()
    expect(altToSend(' cat ')).toBe('cat')
  })

  test('an edit sets or clears descriptions by root hash, and only text counts', () => {
    expect(editAlts({ alts: { a: ' new ', b: '', c: 3 } })).toEqual({ a: 'new', b: null })
    expect(editAlts({ alts: ['a'] })).toEqual({})
    expect(editAlts(null)).toEqual({})
    const att = [
      { h: 'a', name: 'a.png', alt: 'old a' },
      { h: 'b', name: 'b.png', alt: 'old b' },
      { h: 'c', name: 'c.png', alt: 9 },
      { h: 'd', name: 'd.png' },
    ]
    expect(withAlts(att, { alts: { a: 'new a', b: '' } })).toEqual([
      { h: 'a', name: 'a.png', alt: 'new a' },
      { h: 'b', name: 'b.png' },
      { h: 'c', name: 'c.png' },
      { h: 'd', name: 'd.png' },
    ])
    expect(withAlts(att, null)[0]).toEqual({ h: 'a', name: 'a.png', alt: 'old a' })
    expect(altsEdit('a', '  ')).toEqual({ a: '' })
    expect(altsEdit('a', ' dog ')).toEqual({ a: 'dog' })
  })
})

describe('which files take a description, and what an edit carries', () => {
  test('images that show inline, by type or name; nothing removed', () => {
    expect(describableFile('cat.png', 'image/png')).toBe(true)
    expect(describableFile('photo', 'image/webp')).toBe(true)
    expect(describableFile('logo.svg', '')).toBe(true)
    expect(describableFile('scan.tiff', 'image/tiff')).toBe(false)
    expect(describableFile('notes.txt', 'text/plain')).toBe(false)
    const media = { removed: false, mime: null, filename: 'cat.PNG' }
    expect(describable(media)).toBe(true)
    expect(describable({ ...media, removed: true })).toBe(false)
    expect(describable(null)).toBe(false)
  })

  test('every edit carries each image description as it shows, so none comes back later', () => {
    const att = [
      { h: 'a', name: 'a.png', mime: 'image/png', alt: 'A cat' },
      { h: 'b', name: 'b.png', mime: 'image/png' },
      { h: 'c', name: 'c.txt', mime: 'text/plain', alt: 'ignored' },
    ]
    expect(editAltsFor(att)).toEqual({ a: 'A cat', b: '' })
    expect(editAltsFor(att, { h: 'a', text: '  ' })).toEqual({ a: '', b: '' })
    expect(editAltsFor(att, { h: 'b', text: 'A dog' })).toEqual({ a: 'A cat', b: 'A dog' })
    expect(editAltsFor([{ h: 'c', name: 'c.txt', mime: 'text/plain' }])).toBeUndefined()
  })
})
