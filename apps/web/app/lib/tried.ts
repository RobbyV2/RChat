import { background, refusalOf, type Refusal } from './api_errors'
import { Ended } from './slices/ctx'

// What a store action that asks the instance answers: its value, or the refusal. A caller reads
// the value only after it looked at `ok`, so a failure cannot pass for an empty answer.
export type Tried<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: Refusal; readonly error: unknown }

export const came = <T>(value: T): Tried<T> => ({ ok: true, value })

export const refused = (error: unknown): Tried<never> => ({
  ok: false,
  refusal: refusalOf(error),
  error,
})

// For a caller nobody is waiting on: a refusal is recorded as `background` records one. An
// answer that came after its session ended is dropped, as everywhere.
export const recorded =
  <const W extends string>(what: string extends W ? never : W) =>
  (tried: Tried<unknown>): void => {
    if (!tried.ok && !(tried.error instanceof Ended)) background(what)(tried.error)
  }
