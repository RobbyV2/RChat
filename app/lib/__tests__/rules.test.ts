import { describe, expect, test } from 'bun:test'
import { canDeleteChannel, charCount, sameOriginImage, serverInitial } from '../rules'
import type { Channel } from '../types'

const ch = (id: number, kind: Channel['kind']): Channel => ({
  id,
  name: `c${id}`,
  kind,
  slowmode_seconds: 0,
})

describe('canDeleteChannel', () => {
  test('mirrors the server rule', () => {
    const text = ch(1, 'text')
    const voice = ch(2, 'voice')
    expect(canDeleteChannel([text], text)).toBe(false)
    expect(canDeleteChannel([text, voice], text)).toBe(false)
    expect(canDeleteChannel([text, voice], voice)).toBe(true)
    expect(canDeleteChannel([voice], voice)).toBe(false)
    expect(canDeleteChannel([text, ch(3, 'text')], text)).toBe(true)
  })
})

describe('serverInitial', () => {
  test('uses the first grapheme', () => {
    expect(serverInitial('  party')).toBe('P')
    expect(serverInitial('😀 party')).toBe('😀')
    expect(serverInitial('👩‍💻 devs')).toBe('👩‍💻')
    expect(serverInitial('éclair')).toBe('É')
    expect(serverInitial('   ')).toBe('?')
  })
})

describe('charCount', () => {
  test('counts code points, not UTF-16 units', () => {
    expect(charCount('😀😀')).toBe(2)
    expect(charCount('abc')).toBe(3)
  })
})

describe('sameOriginImage', () => {
  const base = 'https://chat.example/s/rchat/1/'
  const origins = ['https://chat.example']
  test('only same-origin http(s) sources load', () => {
    expect(sameOriginImage('/api/media/abc', base, origins)).toBe(true)
    expect(sameOriginImage('https://chat.example/x.png', base, origins)).toBe(true)
    expect(sameOriginImage('https://evil.example/x.png', base, origins)).toBe(false)
    expect(sameOriginImage('//evil.example/x.png', base, origins)).toBe(false)
    expect(sameOriginImage('data:image/png;base64,AAAA', base, origins)).toBe(false)
    expect(sameOriginImage(undefined, base, origins)).toBe(false)
    expect(sameOriginImage('http://[bad', base, origins)).toBe(false)
  })
})
