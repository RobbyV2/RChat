import { useRef } from 'react'

// A text that is equal for two values with the same content, for dependency lists.
export const stableKey = (value: unknown): string => JSON.stringify(value) ?? ''

interface Held<T> {
  key: string
  value: T
}

// Keeps the first value seen for each run of equal content, so the typed value itself can be a
// dependency.
export const holder = <T>(): ((next: T) => T) => {
  let held: Held<T> | null = null
  return next => {
    const key = stableKey(next)
    if (held?.key !== key) held = { key, value: next }
    return held.value
  }
}

// The same object for as long as the value's content is unchanged.
export function useStable<T>(value: T): T {
  const hold = useRef<((next: T) => T) | null>(null)
  hold.current ??= holder<T>()
  return hold.current(value)
}

// A store selector whose result keeps its identity while its content is unchanged.
export function useStableSelector<S, T>(select: (state: S) => T): (state: S) => T {
  const hold = useRef<((next: T) => T) | null>(null)
  hold.current ??= holder<T>()
  const keep = hold.current
  return state => keep(select(state))
}

// A deep copy of plain data: lists, objects, text, numbers, flags and null. A field holding
// undefined is left out.
export const plainCopy = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => plainCopy(item)) as T
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value))
    if (field !== undefined) out[key] = plainCopy(field)
  return out as T
}
