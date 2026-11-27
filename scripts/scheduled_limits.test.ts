import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFER_MAX_MS,
  RETRY_BACKOFF_MS,
  SCHEDULE_MAX_MS,
  SCHEDULE_MIN_MS,
} from '../apps/web/app/lib/scheduled'

const rust = readFileSync(
  join(import.meta.dir, '..', 'apps', 'server', 'src', 'api', 'scheduled.rs'),
  'utf8'
)

// The value of `pub const NAME: i64 = ...;` in seconds, products of numbers allowed.
const secs = (name: string) => {
  const hit = new RegExp(String.raw`pub const ${name}: i64 = ([\d_ *]+);`).exec(rust)
  if (!hit) throw new Error(`${name} is not in scheduled.rs`)
  return hit[1]
    .split('*')
    .map(p => Number(p.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1)
}

test('the client and the server schedule within the same limits', () => {
  expect(secs('SCHEDULE_MIN_SECS') * 1000).toBe(SCHEDULE_MIN_MS)
  expect(secs('SCHEDULE_MAX_SECS') * 1000).toBe(SCHEDULE_MAX_MS)
  expect(secs('DEFER_MAX_SECS') * 1000).toBe(DEFER_MAX_MS)
  const backoff = /pub const RETRY_BACKOFF_SECS: \[i64; \d+\] = \[([^\]]+)\];/.exec(rust)
  expect(backoff).not.toBeNull()
  const list = backoff![1].split(',').map(v => Number(v.trim()) * 1000)
  expect(list).toEqual(RETRY_BACKOFF_MS)
})
