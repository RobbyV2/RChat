import { describe, expect, test } from 'bun:test'
import { instanceLabel, labelParts } from '../instance_label'

describe('instanceLabel', () => {
  test('an instance with its own name is called by it', () => {
    expect(instanceLabel({ name: 'Alpha' }, 'chat.a.com')).toBe('Alpha')
  })

  test('the default name says nothing, so the host stands in', () => {
    expect(instanceLabel({ name: 'RChat' }, 'chat.a.com')).toBe('chat.a.com')
  })

  test('no name, an empty one or one of spaces gives the host', () => {
    expect(instanceLabel(null, 'chat.a.com')).toBe('chat.a.com')
    expect(instanceLabel(undefined, 'chat.a.com')).toBe('chat.a.com')
    expect(instanceLabel({}, 'chat.a.com')).toBe('chat.a.com')
    expect(instanceLabel({ name: '' }, 'chat.a.com')).toBe('chat.a.com')
    expect(instanceLabel({ name: '   ' }, 'chat.a.com')).toBe('chat.a.com')
  })

  test('a name another instance in view also has gives the host, in any case', () => {
    const others = [{ name: 'alpha', host: 'chat.b.com' }]
    expect(instanceLabel({ name: 'Alpha' }, 'chat.a.com', others)).toBe('chat.a.com')
  })

  test('the instance itself in the list does not count as a clash', () => {
    const others = [
      { name: 'Alpha', host: 'chat.a.com' },
      { name: 'Beta', host: 'chat.b.com' },
    ]
    expect(instanceLabel({ name: 'Alpha' }, 'chat.a.com', others)).toBe('Alpha')
  })

  test('a name unique among the others stays', () => {
    expect(instanceLabel({ name: 'Alpha' }, 'chat.a.com', [{ name: 'Beta', host: 'b.io' }])).toBe(
      'Alpha'
    )
  })

  test('the name is trimmed', () => {
    expect(instanceLabel({ name: '  Alpha ' }, 'chat.a.com')).toBe('Alpha')
  })
})

describe('labelParts', () => {
  test('splits text around the instance label', () => {
    expect(labelParts('Attachments are turned off on Alpha.', 'Alpha')).toEqual([
      { text: 'Attachments are turned off on ', label: false },
      { text: 'Alpha', label: true },
      { text: '.', label: false },
    ])
  })

  test('every time the label appears, at either end', () => {
    expect(labelParts('Alpha and Alpha', 'Alpha')).toEqual([
      { text: 'Alpha', label: true },
      { text: ' and ', label: false },
      { text: 'Alpha', label: true },
    ])
  })

  test('text without the label, or an empty label, stays whole', () => {
    expect(labelParts('Nothing named here.', 'Alpha')).toEqual([
      { text: 'Nothing named here.', label: false },
    ])
    expect(labelParts('Alpha', '')).toEqual([{ text: 'Alpha', label: false }])
    expect(labelParts('', 'Alpha')).toEqual([])
  })
})
