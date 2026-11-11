import { describe, expect, test } from 'bun:test'
import { createClicks, createKonami, eggFor } from '../fx/eggs'

describe('palette eggs', () => {
  test('exact phrase, command mode only', () => {
    expect(eggFor('Do a barrel roll!', 'commands', [])).toBe('barrel_roll')
    expect(eggFor('do a barrel', 'commands', [])).toBeNull()
    expect(eggFor('do a barrel roll', 'other', [])).toBeNull()
    expect(eggFor('1999', 'other', [])).toBeNull()
  })
  test('a listed action with the same title wins', () => {
    expect(eggFor('flip', 'commands', ['Flip'])).toBeNull()
    expect(eggFor('credits', 'commands', ['Open settings', 'Credits'])).toBeNull()
    expect(eggFor('credits', 'commands', ['Open settings'])).toBe('credits')
  })
  test('party mode, make it rain and let it snow are not eggs', () => {
    for (const q of ['party mode', 'make it rain', 'let it snow'])
      expect(eggFor(q, 'commands', [])).toBeNull()
  })
})

describe('Konami', () => {
  const seq = [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
    'b',
    'a',
  ]
  const run = (focus: Parameters<ReturnType<typeof createKonami>>[1], gap = 100) => {
    const k = createKonami()
    return seq.map((key, i) => k(key, focus, i * gap)).pop()
  }
  test('on the page or a plain element', () => {
    expect(run('body')).toBe(true)
    expect(run('plain')).toBe(true)
  })
  test('never while arrows drive a tree, menu, list or grid, or in text', () => {
    expect(run('composite')).toBe(false)
    expect(run('text')).toBe(false)
  })
  test('starts over after 2 s idle or a wrong key; a stray Up restarts it', () => {
    expect(run('body', 2100)).toBe(false)
    const k = createKonami()
    expect([...['ArrowUp', 'x'], ...seq].map((key, i) => k(key, 'body', i * 100)).pop()).toBe(true)
    const k2 = createKonami()
    expect(['ArrowUp', ...seq].map((key, i) => k2(key, 'body', i * 100)).pop()).toBe(true)
  })
  test('capital B and A count', () => {
    const k = createKonami()
    expect([...seq.slice(0, 8), 'B', 'A'].map((key, i) => k(key, 'body', i * 100)).pop()).toBe(true)
  })
})

describe('clicks', () => {
  test('7 in 3 s', () => {
    const c = createClicks(7, 3000)
    const hits = Array.from({ length: 7 }, (_, i) => c(i * 400))
    expect(hits.pop()).toBe(true)
    const slow = createClicks(7, 3000)
    expect(Array.from({ length: 7 }, (_, i) => slow(i * 600)).pop()).toBe(false)
  })
})
