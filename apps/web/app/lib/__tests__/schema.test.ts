import { describe, expect, test } from 'bun:test'
import {
  anything,
  arr,
  base64,
  bool,
  bytes,
  choice,
  type Infer,
  int,
  issueText,
  lazy,
  lit,
  nullable,
  num,
  obj,
  opt,
  parseJson,
  type Parsed,
  record,
  Schema,
  str,
  tagged,
  union,
} from '../schema'

const value = <T>(r: Parsed<T>) => {
  if (!r.ok) throw new Error('expected a value')
  return r.value
}
const issue = <T>(r: Parsed<T>) => {
  if (r.ok || r.unknown) throw new Error('expected an issue')
  return issueText(r.issue)
}
const newer = <T>(r: Parsed<T>) => !r.ok && r.unknown

describe('scalars', () => {
  test('a string within its limits is kept', () => {
    expect(value(str({ max: 3 }).parse('abc'))).toBe('abc')
    expect(issue(str({ max: 3 }).parse('abcd'))).toBe('expected at most 3 characters')
    expect(issue(str({ min: 1 }).parse(''))).toBe('expected at least 1 characters')
    expect(issue(str().parse(7))).toBe('expected a string')
  })

  test('a whole number is safe and within its range', () => {
    expect(value(int({ min: 0, max: 9 }).parse(9))).toBe(9)
    expect(issue(int().parse(1.5))).toBe('expected a whole number')
    expect(issue(int().parse(2 ** 53))).toBe('expected a whole number')
    expect(issue(int({ min: 0 }).parse(-1))).toBe('expected at least 0')
    expect(issue(int({ max: 9 }).parse(10))).toBe('expected at most 9')
    expect(issue(int().parse('1'))).toBe('expected a whole number')
  })

  test('a number is finite', () => {
    expect(value(num().parse(1.5))).toBe(1.5)
    expect(issue(num().parse(Number.NaN))).toBe('expected a number')
    expect(issue(num().parse(Number.POSITIVE_INFINITY))).toBe('expected a number')
  })

  test('a boolean is only true or false', () => {
    expect(value(bool.parse(false))).toBe(false)
    expect(issue(bool.parse(0))).toBe('expected true or false')
  })

  test('a literal matches exactly', () => {
    expect(value(lit(2).parse(2))).toBe(2)
    expect(issue(lit('v1').parse('v2'))).toBe('expected "v1"')
  })

  test('anything passes a value through unread', () => {
    const raw = { a: [1, { b: null }] }
    expect(value(anything.parse(raw))).toBe(raw)
  })
})

describe('choice', () => {
  const kind = choice('text', 'voice')

  test('a listed name is kept', () => {
    expect(value(kind.parse('voice'))).toBe('voice')
  })

  test('a name outside the list is unknown, not an issue', () => {
    expect(newer(kind.parse('stage'))).toBe(true)
  })

  test('a value that is not a string is an issue', () => {
    expect(issue(kind.parse(3))).toBe('expected a string')
  })
})

describe('obj', () => {
  const person = obj({ id: str(), age: opt(int()), nick: nullable(str()) })

  test('fields outside the shape are dropped', () => {
    const got = value(person.parse({ id: 'a', nick: null, extra: 1, __proto__: { x: 1 } }))
    expect(got).toEqual({ id: 'a', nick: null })
    expect(Object.keys(got)).toEqual(['id', 'nick'])
  })

  test('an optional field may be absent or undefined and stays absent', () => {
    expect('age' in value(person.parse({ id: 'a', nick: 'n', age: undefined }))).toBe(false)
    expect(value(person.parse({ id: 'a', nick: 'n', age: 4 })).age).toBe(4)
  })

  test('a missing required field is an issue at its path', () => {
    expect(issue(person.parse({ nick: null }))).toBe('id: expected a string')
    expect(issue(person.parse({ id: 'a' }))).toBe('nick: expected a string')
  })

  test('an inherited field does not count as present', () => {
    expect(issue(person.parse(Object.create({ id: 'a', nick: null })))).toBe(
      'id: expected a string'
    )
  })

  test('a list or null is not an object', () => {
    expect(issue(person.parse([]))).toBe('expected an object')
    expect(issue(person.parse(null))).toBe('expected an object')
  })

  test('nested issues carry the full path', () => {
    const outer = obj({ people: arr(obj({ tags: arr(str()) })) })
    expect(issue(outer.parse({ people: [{ tags: [] }, { tags: ['a', 2] }] }))).toBe(
      'people[1].tags[1]: expected a string'
    )
  })

  test('an unknown value in a field makes the whole object unknown', () => {
    const channel = obj({ id: str(), kind: choice('text') })
    expect(newer(channel.parse({ id: 'c', kind: 'stage' }))).toBe(true)
  })

  test('extend adds and replaces fields', () => {
    const more = person.extend({ age: int(), color: str() })
    expect(issue(more.parse({ id: 'a', nick: null, color: 'red' }))).toBe(
      'age: expected a whole number'
    )
    const got: { id: string; nick: string | null; age: number; color: string } = value(
      more.parse({ id: 'a', nick: null, color: 'red', age: 3 })
    )
    expect(got.color).toBe('red')
  })
})

describe('arr and record', () => {
  test('a list over its limit is an issue', () => {
    expect(issue(arr(int(), { max: 2 }).parse([1, 2, 3]))).toBe('expected at most 2 items')
    expect(issue(int().array().parse('x'))).toBe('expected a list')
  })

  test('items this build cannot name are left out of a list', () => {
    expect(value(arr(choice('a', 'b')).parse(['a', 'z', 'b']))).toEqual(['a', 'b'])
  })

  test('a malformed item is an issue', () => {
    expect(issue(arr(int()).parse([1, 'x']))).toBe('[1]: expected a whole number')
  })

  test('a record keeps its keys as own fields', () => {
    const got = value(record(int()).parse(JSON.parse('{"a":1,"__proto__":2}')))
    expect(Object.keys(got).sort()).toEqual(['__proto__', 'a'])
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype)
  })

  test('a record checks its size and values', () => {
    expect(issue(record(int(), { max: 1 }).parse({ a: 1, b: 2 }))).toBe(
      'expected at most 1 entries'
    )
    expect(issue(record(int()).parse({ a: 'x' }))).toBe('a: expected a whole number')
    expect(value(record(choice('a')).parse({ x: 'a', y: 'q' }))).toEqual({ x: 'a' })
  })
})

describe('tagged', () => {
  const event = tagged('type', {
    joined: obj({ user: str() }),
    left: obj({ user: str(), why: opt(str()) }),
  })

  test('the tag picks the shape and stays on the value', () => {
    const got = value(event.parse({ type: 'left', user: 'u', why: 'kick', more: 1 }))
    expect(got).toEqual({ type: 'left', user: 'u', why: 'kick' })
    if (got.type === 'left') expect(got.why).toBe('kick')
  })

  test('a tag outside the table is unknown', () => {
    expect(newer(event.parse({ type: 'renamed', user: 'u' }))).toBe(true)
    expect(newer(event.parse({ type: 'toString', user: 'u' }))).toBe(true)
  })

  test('a missing tag or a malformed known shape is an issue', () => {
    expect(issue(event.parse({ user: 'u' }))).toBe('type: expected a string')
    expect(issue(event.parse({ type: 'joined' }))).toBe('user: expected a string')
    expect(issue(event.parse('joined'))).toBe('expected an object')
  })
})

describe('union, lazy and methods', () => {
  test('the first fitting shape wins', () => {
    const id = union(str(), int())
    expect(value(id.parse(4))).toBe(4)
    expect(issue(id.parse(true))).toBe('expected one of 2 shapes')
  })

  test('a union is unknown when a shape met a newer value', () => {
    expect(newer(union(int(), choice('a')).parse('b'))).toBe(true)
  })

  test('lazy allows a shape to contain itself', () => {
    interface Node {
      kids: Node[]
    }
    const node: Schema<Node> = obj({ kids: lazy(() => node).array() })
    expect(value(node.parse({ kids: [{ kids: [] }] }))).toEqual({ kids: [{ kids: [] }] })
    expect(issue(node.parse({ kids: [{ kids: 1 }] }))).toBe('kids[0].kids: expected a list')
  })

  test('refine adds a check and map changes the value', () => {
    const even = int().refine(n => n % 2 === 0, 'an even number')
    expect(issue(even.parse(3))).toBe('expected an even number')
    expect(value(even.map(n => n / 2).parse(8))).toBe(4)
    expect(value(str().nullable().parse(null))).toBeNull()
  })

  test('a brand is a type-level mark on the parsed value', () => {
    const userId = str({ max: 64 }).brand<'UserId'>()
    type UserId = Infer<typeof userId>
    const id: UserId = value(userId.parse('u1'))
    const plain: string = id
    expect(plain).toBe('u1')
  })

  test('a schema cannot be built outside the combinators', () => {
    const Raw = Schema as unknown as new (key: symbol, run: () => unknown) => unknown
    expect(() => new Raw(Symbol('schema'), () => null)).toThrow()
  })
})

describe('bytes', () => {
  test('bytes are a Uint8Array within the limit', () => {
    expect(value(bytes({ max: 2 }).parse(new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]))
    expect(issue(bytes({ max: 1 }).parse(new Uint8Array(2)))).toBe('expected at most 1 bytes')
    expect(issue(bytes().parse([1, 2]))).toBe('expected bytes')
  })

  test('base64 text decodes in either alphabet, padded or not', () => {
    expect(value(base64().parse('+/8='))).toEqual(new Uint8Array([251, 255]))
    expect(value(base64().parse('-_8'))).toEqual(new Uint8Array([251, 255]))
    expect(value(base64().parse(''))).toEqual(new Uint8Array())
  })

  test('text that is not base64, or decodes past the limit, is an issue', () => {
    expect(issue(base64().parse('a'))).toBe('expected base64 text')
    expect(issue(base64().parse('ab c'))).toBe('expected base64 text')
    expect(issue(base64().parse(5))).toBe('expected base64 text')
    expect(issue(base64({ max: 1 }).parse('+/8='))).toBe('expected at most 1 bytes')
  })
})

describe('parseJson', () => {
  test('text that is not JSON is an issue', () => {
    expect(issue(parseJson('{', obj({})))).toBe('expected JSON')
  })

  test('JSON is checked against the schema', () => {
    const s = obj({ v: lit(1), items: arr(str(), { max: 2 }) })
    expect(value(parseJson('{"v":1,"items":["a"],"x":true}', s))).toEqual({ v: 1, items: ['a'] })
    expect(issue(parseJson('{"v":2,"items":[]}', s))).toBe('v: expected 1')
  })
})
