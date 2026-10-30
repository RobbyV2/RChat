import { describe, expect, test } from 'bun:test'
import { applyFormat, FORMATS, formatKey, keysLabel, type Format } from '../format'

// Applies `format` to the part of `marked` between « and » and shows the result with the new
// selection in « ».
const run = (marked: string, format: Format) => {
  const start = marked.indexOf('«')
  const end = marked.indexOf('»') - 1
  const text = marked.replace('«', '').replace('»', '')
  const out = applyFormat(text, start, end, format)
  return `${out.text.slice(0, out.start)}«${out.text.slice(out.start, out.end)}»${out.text.slice(out.end)}`
}

const key = (k: string, mods: { shift?: boolean; meta?: boolean; alt?: boolean } = {}) => ({
  key: k,
  ctrlKey: !mods.meta,
  metaKey: mods.meta === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
})

describe('wrapping', () => {
  test('each format wraps the selection', () => {
    expect(run('a «b» c', 'bold')).toBe('a **«b»** c')
    expect(run('a «b» c', 'italic')).toBe('a *«b»* c')
    expect(run('a «b» c', 'strike')).toBe('a ~~«b»~~ c')
    expect(run('a «b» c', 'code')).toBe('a `«b»` c')
    expect(run('a «b» c', 'spoiler')).toBe('a ||«b»|| c')
  })

  test('applying it again unwraps, inside or outside the selection', () => {
    expect(run('a **«b»** c', 'bold')).toBe('a «b» c')
    expect(run('a «**b**» c', 'bold')).toBe('a «b» c')
    expect(run('a ||«b»|| c', 'spoiler')).toBe('a «b» c')
    expect(run('a «||b||» c', 'spoiler')).toBe('a «b» c')
    expect(run('«~~x~~»', 'strike')).toBe('«x»')
    expect(run('`«x»`', 'code')).toBe('«x»')
    expect(run('«_x_»', 'italic')).toBe('«x»')
  })

  test('bold and italic share stars', () => {
    expect(run('**«b»**', 'italic')).toBe('***«b»***')
    expect(run('***«b»***', 'italic')).toBe('**«b»**')
    expect(run('***«b»***', 'bold')).toBe('*«b»*')
    expect(run('*«b»*', 'bold')).toBe('***«b»***')
  })

  test('spaces at the ends stay outside, an empty selection gets a pair', () => {
    expect(run('a« b »c', 'bold')).toBe('a **«b»** c')
    expect(run('a «»b', 'spoiler')).toBe('a ||«»||b')
    expect(run('a ||«»||b', 'spoiler')).toBe('a «»b')
  })

  test('multi-line code becomes a block; spoilers may span lines', () => {
    expect(run('x «a\nb» y', 'code')).toBe('x \n```\n«a\nb»\n```\n y')
    expect(run('```\n«a\nb»\n```', 'code')).toBe('«a\nb»')
    expect(run('«a\nb»', 'spoiler')).toBe('||«a\nb»||')
  })
})

describe('quotes and links', () => {
  test('quote toggles whole lines', () => {
    expect(run('one\nt«wo\nthr»ee', 'quote')).toBe('one\n«> two\n> three»')
    expect(run('«> two\n> three»', 'quote')).toBe('«two\nthree»')
    expect(run('«a\n\nb»', 'quote')).toBe('«> a\n\n> b»')
  })

  test('link wraps text or a url and unwraps a link', () => {
    expect(run('see «docs»', 'link')).toBe('see [docs](«https://»)')
    expect(run('«https://x.example»', 'link')).toBe('[«»](https://x.example)')
    expect(run('«[docs](https://x.example)»', 'link')).toBe('«docs»')
    expect(run('[«docs»](https://x.example)', 'link')).toBe('«docs»')
  })
})

describe('keys', () => {
  test('match the list and nothing else', () => {
    expect(formatKey(key('b'))).toBe('bold')
    expect(formatKey(key('i', { meta: true }))).toBe('italic')
    expect(formatKey(key('X', { shift: true }))).toBe('strike')
    expect(formatKey(key('e'))).toBe('code')
    expect(formatKey(key('H', { shift: true }))).toBe('spoiler')
    expect(formatKey(key('b', { alt: true }))).toBeNull()
    expect(formatKey(key('x'))).toBeNull()
    expect(formatKey(key('P', { shift: true }))).toBeNull()
    expect(formatKey(key('S', { shift: true }))).toBeNull()
    expect(formatKey({ ...key('b'), ctrlKey: false })).toBeNull()
  })

  test('labels and no clash with each other', () => {
    expect(keysLabel('Mod+Shift+H', true)).toBe('Cmd+Shift+H')
    expect(keysLabel('Mod+Shift+H', false)).toBe('Ctrl+Shift+H')
    const keys = FORMATS.flatMap(f => (f.keys ? [f.keys] : []))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.includes('Mod+Shift+S')).toBe(false)
    expect(keys.includes('Mod+Shift+P')).toBe(false)
  })
})
