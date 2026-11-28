// Permission masks cross the API as JSON numbers and live in the client as `bigint`s. Every
// response body and socket event is read by `readJson`, and every request body is written by
// `writeJson`.

const MASKS = new Set(['perms', 'my_perms', 'everyone_perms', 'allow', 'deny'])

export const readJson = (text: string): unknown =>
  JSON.parse(text, (key, value: unknown) =>
    MASKS.has(key) && typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : value
  )

export const writeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) => (typeof part === 'bigint' ? Number(part) : part))
