import { anything, parseJson } from '../schema'

// Permission masks cross the API as JSON numbers and live in the client as `bigint`s. Every
// response body and socket event is read by `readJson`, and every request body is written by
// `writeJson`.

export const MASKS = new Set(['perms', 'my_perms', 'everyone_perms', 'allow', 'deny'])

// Text that is not JSON throws, as a body that cannot be read.
export const readJson = (text: string): unknown => {
  const read = parseJson(text, anything, (key, value) =>
    MASKS.has(key) && typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : value
  )
  if (!read.ok) throw new SyntaxError('The answer is not JSON')
  return read.value
}

export const writeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) => (typeof part === 'bigint' ? Number(part) : part))
