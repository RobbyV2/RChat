import type { StoreApi } from 'zustand/vanilla'

// A value that changes over time: what it is now, and a call when it changes. Features hand
// these out, so a component reads a hosted store and a P2P store the same way.
export interface Live<T> {
  get: () => T
  subscribe: (changed: () => void) => () => void
  // What a server render shows, where that differs from `get`.
  initial?: () => T
}

const never = () => () => {}

export const constant = <T>(value: T): Live<T> => ({ get: () => value, subscribe: never })

// `read`, keeping the value's identity until it differs.
const kept = <T>(read: () => T, same: (a: T, b: T) => boolean) => {
  let held: { value: T } | null = null
  return () => {
    const next = read()
    if (held === null || !same(held.value, next)) held = { value: next }
    return held.value
  }
}

// What `select` reads from a store. A selection that builds a new value on every read passes
// `same`.
export const fromStore = <S, T>(
  store: Pick<StoreApi<S>, 'getState' | 'getInitialState' | 'subscribe'>,
  select: (state: S) => T,
  same: (a: T, b: T) => boolean = Object.is
): Live<T> => ({
  get: kept(() => select(store.getState()), same),
  initial: kept(() => select(store.getInitialState()), same),
  subscribe: changed => store.subscribe(changed),
})

// `map` of a live value, computed again only when the value changes.
export const derived = <T, U>(source: Live<T>, map: (value: T) => U): Live<U> => {
  const mapped = (read: () => T) => {
    let held: { from: T; value: U } | null = null
    return () => {
      const from = read()
      if (held === null || !Object.is(held.from, from)) held = { from, value: map(from) }
      return held.value
    }
  }
  return {
    get: mapped(source.get),
    subscribe: source.subscribe,
    ...(source.initial ? { initial: mapped(source.initial) } : {}),
  }
}

const sameParts = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

// A value built from `parts`, again only when one of them changes.
export const built = <P extends readonly unknown[], T>(parts: () => P, build: (parts: P) => T) => {
  let held: { parts: P; value: T } | null = null
  return () => {
    const now = parts()
    if (held === null || !sameParts(held.parts, now)) held = { parts: now, value: build(now) }
    return held.value
  }
}
