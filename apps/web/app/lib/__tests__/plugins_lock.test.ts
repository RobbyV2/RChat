import { describe, expect, test } from 'bun:test'
import { classifyChange, type Change, type PointLock, type Schema } from '../plugins/lock'

type Props = Record<string, Schema>
const object = (properties: Props, required: string[]): Schema => ({
  type: 'object',
  properties,
  required,
})

describe('hook lock', () => {
  const input: Props = {
    id: { type: 'string' },
    text: { type: 'string' },
    kind: { type: 'string', enum: ['channel', 'dm'] },
  }
  const output: Props = {
    text: { type: 'string' },
    mark: { type: 'string', enum: ['changed', 'hidden'] },
  }
  const base: PointLock = {
    kinds: ['before', 'after'],
    lane: 'sync',
    perms: ['hook:render'],
    input: object(input, ['id', 'text']),
    output: object(output, ['text']),
  }
  const withIn = (p: Props, required = ['id', 'text']): PointLock => ({
    ...base,
    input: object({ ...input, ...p }, required),
  })
  const withOut = (p: Props, required = ['text']): PointLock => ({
    ...base,
    output: object({ ...output, ...p }, required),
  })

  const CASES: [string, PointLock, Change][] = [
    ['same', base, 'same'],
    ['new optional input field', withIn({ edited: { type: 'number' } }), 'additive'],
    [
      'new required input field',
      withIn({ edited: { type: 'number' } }, ['id', 'text', 'edited']),
      'additive',
    ],
    [
      'new enum value in input',
      withIn({ kind: { type: 'string', enum: ['channel', 'dm', 'forum'] } }),
      'additive',
    ],
    [
      'input field removed',
      { ...base, input: object({ id: { type: 'string' } }, ['id']) },
      'breaking',
    ],
    ['input type changed', withIn({ id: { type: 'number' } }), 'breaking'],
    ['input required became optional', withIn({}, ['id']), 'breaking'],
    ['new optional output field', withOut({ note: { type: 'string' } }), 'additive'],
    [
      'new required output field',
      withOut({ note: { type: 'string' } }, ['text', 'note']),
      'breaking',
    ],
    [
      'new enum value in output',
      withOut({ mark: { type: 'string', enum: ['changed', 'hidden', 'spoiler'] } }),
      'additive',
    ],
    [
      'output enum value removed',
      withOut({ mark: { type: 'string', enum: ['changed'] } }),
      'breaking',
    ],
    ['kind added', { ...base, kinds: ['before', 'after', 'around'] }, 'additive'],
    ['kind removed', { ...base, kinds: ['before'] }, 'breaking'],
    ['lane changed', { ...base, lane: 'async' }, 'breaking'],
    ['permission added', { ...base, perms: ['hook:render', 'read:messages'] }, 'breaking'],
    ['permission removed', { ...base, perms: [] }, 'additive'],
  ]
  for (const [name, next, want] of CASES)
    test(name, () => expect(classifyChange(base, next)).toBe(want))
})

describe('hook lock: nullable fields and maps', () => {
  const input: Props = {
    edited_at: { type: 'number' },
    kind: { type: 'string' },
    reactions: { type: 'map', values: { type: 'number' } },
  }
  const base: PointLock = {
    kinds: ['before'],
    lane: 'sync',
    perms: ['hook:render'],
    input: object(input, ['kind']),
    output: object({ text: { type: 'string' } }, ['text']),
  }
  const inProp = (k: string, v: Schema): PointLock => ({
    ...base,
    input: object({ ...input, [k]: v }, ['kind']),
  })
  const outProp = (k: string, v: Schema): PointLock => ({
    ...base,
    output: object({ text: { type: 'string' }, [k]: v }, ['text']),
  })

  const CASES: [string, PointLock, Change][] = [
    [
      'input field becomes nullable',
      inProp('edited_at', { type: 'number', nullable: true }),
      'breaking',
    ],
    [
      'output field becomes nullable',
      outProp('text', { type: 'string', nullable: true }),
      'additive',
    ],
    [
      'map value type changes',
      inProp('reactions', { type: 'map', values: { type: 'string' } }),
      'breaking',
    ],
    ['input enum closes', inProp('kind', { type: 'string', enum: ['channel', 'dm'] }), 'additive'],
  ]
  for (const [name, next, want] of CASES)
    test(name, () => expect(classifyChange(base, next)).toBe(want))

  const MORE: [string, PointLock, Change][] = [
    ['input field stops being nullable', inProp('edited_at', { type: 'number' }), 'additive'],
    ['output field stops being nullable', outProp('text', { type: 'string' }), 'breaking'],
    ['output enum opens', outProp('text', { type: 'string' }), 'additive'],
    ['output string closes to a set', outProp('text', { type: 'string', enum: ['a'] }), 'breaking'],
    ['input enum opens', inProp('kind', { type: 'string' }), 'additive'],
    [
      'array items change type',
      inProp('tags', { type: 'array', items: { type: 'number' } }),
      'breaking',
    ],
    [
      'a field inside an array item is added',
      inProp('tags', {
        type: 'array',
        items: object({ a: { type: 'string' }, b: { type: 'string' } }, []),
      }),
      'additive',
    ],
    [
      'a map value becomes nullable in the output',
      outProp('counts', { type: 'map', values: { type: 'number', nullable: true } }),
      'additive',
    ],
    ['output field removed', { ...base, output: object({}, []) }, 'breaking'],
    [
      'output required became optional',
      { ...base, output: object({ text: { type: 'string' } }, []) },
      'additive',
    ],
    [
      'object became an array',
      inProp('reactions', { type: 'array', items: { type: 'number' } }),
      'breaking',
    ],
  ]
  const from: Record<string, PointLock> = {
    'input field stops being nullable': inProp('edited_at', { type: 'number', nullable: true }),
    'output field stops being nullable': outProp('text', { type: 'string', nullable: true }),
    'output enum opens': outProp('text', { type: 'string', enum: ['a'] }),
    'input enum opens': inProp('kind', { type: 'string', enum: ['channel'] }),
    'array items change type': inProp('tags', { type: 'array', items: { type: 'string' } }),
    'a field inside an array item is added': inProp('tags', {
      type: 'array',
      items: object({ a: { type: 'string' } }, []),
    }),
    'a map value becomes nullable in the output': outProp('counts', {
      type: 'map',
      values: { type: 'number' },
    }),
  }
  for (const [name, next, want] of MORE)
    test(name, () => expect(classifyChange(from[name] ?? base, next)).toBe(want))

  test('the worst change of a point decides', () => {
    const next: PointLock = {
      ...inProp('edited', { type: 'number' }),
      kinds: ['before', 'after'],
      perms: [],
    }
    expect(classifyChange(base, next)).toBe('additive')
    expect(classifyChange(base, { ...next, lane: 'async' })).toBe('breaking')
    expect(classifyChange(base, { ...next, output: object({}, []) })).toBe('breaking')
  })
})
