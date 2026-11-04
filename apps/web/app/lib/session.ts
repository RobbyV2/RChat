import { ApiError } from './api'
import { backoffDelay } from './backoff'

// Only a 401 means the server no longer knows the token. Server errors, network failures and
// every other answer keep the session.
export const endsSession = (e: unknown): boolean => e instanceof ApiError && e.status === 401

// After loading the account failed: null signs out, otherwise the wait before the next try.
export const meRetryIn = (
  e: unknown,
  attempt: number,
  rand: () => number = Math.random
): number | null => (endsSession(e) ? null : backoffDelay(attempt, rand))
