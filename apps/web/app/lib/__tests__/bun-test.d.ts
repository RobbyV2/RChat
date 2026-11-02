declare module 'bun:test' {
  interface Matchers<T> {
    toBe(expected: T): void
    toEqual(expected: T): void
    toBeNull(): void
    toBeUndefined(): void
    toHaveLength(length: number): void
    toContain(item: unknown): void
    toEndWith(suffix: string): void
    toBeGreaterThan(n: number): void
    toBeGreaterThanOrEqual(n: number): void
    toBeLessThan(n: number): void
    toBeLessThanOrEqual(n: number): void
    toMatchObject(expected: unknown): void
    toThrow(expected?: string | RegExp): void
    not: Matchers<T>
  }
  export function expect<T>(actual: T): Matchers<T>
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void
  export namespace test {
    function todo(name: string): void
  }
  export function describe(name: string, fn: () => void): void
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>, timeout?: number): void
  export function afterAll(fn: () => void | Promise<void>, timeout?: number): void
  export function setDefaultTimeout(ms: number): void
  export const jest: {
    useFakeTimers(): void
    useRealTimers(): void
    advanceTimersByTime(ms: number): void
    advanceTimersToNextTimer(): void
    clearAllTimers(): void
  }
}
