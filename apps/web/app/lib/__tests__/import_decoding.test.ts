import { describe, expect, test } from 'bun:test'
import { linksOf, suggestionsOf } from '../admin_brand'
import { argumentValue, readPreview } from '../apps/preview_definition'
import { decodeConfig, takeStashedConfig } from '../config_transfer'
import { registry } from '../perms'
import { memoryStorage } from './fixtures'

const message = (run: () => unknown) => {
  try {
    run()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return null
}

describe('app definitions', () => {
  test('text that is not JSON is refused with its own message', () => {
    expect(message(() => readPreview('{'))).toBe('This definition is not valid JSON.')
  })

  test('a quoted argument is its text; a broken quote is refused like any other argument', () => {
    expect(argumentValue('"a b"', {})).toBe('a b')
    expect(message(() => argumentValue('"a b', {}))).toBe(
      'Use a quoted string or a field, form or argument reference.'
    )
    expect(message(() => argumentValue('"a" 1', {}))).toBe(
      'Use a quoted string or a field, form or argument reference.'
    )
  })
})

describe('branding values', () => {
  test('links keep only entries with a label and an address', () => {
    expect(linksOf('[{"label":"Docs","url":"https://d.example","x":1},{"label":2},"no"]')).toEqual([
      { label: 'Docs', url: 'https://d.example' },
    ])
    expect(linksOf('{')).toEqual([])
    expect(linksOf('{"label":"a","url":"b"}')).toEqual([])
    expect(linksOf(null)).toEqual([])
  })

  test('suggestions default their mode and labels', () => {
    expect(
      suggestionsOf('{"mode":"replace","list":[{"url":"https://a.example"},{"label":"x"},7]}')
    ).toEqual({ mode: 'replace', list: [{ url: 'https://a.example', label: '' }] })
    expect(suggestionsOf('{"mode":"other","list":"no"}')).toEqual({ mode: 'add', list: [] })
    expect(suggestionsOf('[]')).toEqual({ mode: 'add', list: [] })
    expect(suggestionsOf(undefined)).toEqual({ mode: 'add', list: [] })
  })
})

describe('settings imports', () => {
  test('a stash that is not the stored shape is dropped and removed', () => {
    for (const raw of ['{', '[]', '{"at":"now","doc":{},"keys":[]}', '{"at":1,"doc":{}}']) {
      memoryStorage.setItem('rchat_config_stash', raw)
      const taken = takeStashedConfig(memoryStorage, 2)
      expect(taken).toBeNull()
    }
  })

  test('a blob that is not a settings export is refused', async () => {
    expect((await decodeConfig('hello')).ok).toBe(false)
  })
})

describe('permission registry', () => {
  test('every bit of the shared rules is read with its fields', () => {
    const bits = registry()
    expect(bits.length).toBeGreaterThan(10)
    for (const b of bits) {
      expect(typeof b.name).toBe('string')
      expect(typeof b.value).toBe('bigint')
      expect(['server', 'channel']).toContain(b.scope)
      expect(['live', 'reserved']).toContain(b.hosted)
    }
  })
})
