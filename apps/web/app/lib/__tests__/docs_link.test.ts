import { describe, expect, test } from 'bun:test'
import { DOCS_PATH, docsPlace } from '../docs_link'

describe('where the docs open', () => {
  test('a copy the app carries always opens', () => {
    for (const served of [true, false, undefined])
      expect(docsPlace({ bundled: true, served, instance: 'Example' })).toEqual({
        kind: 'open',
        url: DOCS_PATH,
      })
  })

  test("the serving instance's switch decides for the web app it serves", () => {
    expect(docsPlace({ bundled: false, served: true, instance: 'Example' }).kind).toBe('open')
    expect(docsPlace({ bundled: false, served: undefined, instance: 'Example' }).kind).toBe('open')
    expect(docsPlace({ bundled: false, served: false, instance: 'Example' })).toEqual({
      kind: 'off',
      reason: 'Documentation is turned off on Example.',
    })
  })
})
