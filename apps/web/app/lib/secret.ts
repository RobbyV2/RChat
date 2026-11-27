const made: unique symbol = Symbol('secret')

// Where a secret may be unwrapped: a request to its own instance, the device's storage, a
// cryptographic operation, or the screen of the person it belongs to.
export class Sink {
  constructor(
    key: typeof made,
    readonly name: 'request' | 'store' | 'crypto' | 'screen'
  ) {
    if (key !== made) throw new TypeError('sinks are fixed')
  }
}

export const TO_REQUEST = new Sink(made, 'request')
export const TO_STORE = new Sink(made, 'store')
export const TO_CRYPTO = new Sink(made, 'crypto')
export const TO_SCREEN = new Sink(made, 'screen')

const SHOWN = '[secret]'

// A token, grant, key, phrase or code. It cannot be written into JSON, a string or a log line:
// only `reveal` with a sink gives the value back.
export class Secret<T extends string | Uint8Array = string> {
  readonly #value: T

  constructor(key: typeof made, value: T) {
    if (key !== made) throw new TypeError('secrets come from Secret.of')
    this.#value = value
  }

  static of(value: string): Secret<string>
  static of(value: Uint8Array): Secret<Uint8Array>
  static of(value: string | Uint8Array): Secret<string | Uint8Array> {
    return new Secret(made, value)
  }

  // Wraps a value that may be absent; an empty one counts as absent.
  static from(value: string | null | undefined): Secret<string> | null
  static from(value: Uint8Array | null | undefined): Secret<Uint8Array> | null
  static from(value: string | Uint8Array | null | undefined): Secret<string | Uint8Array> | null {
    return value === null || value === undefined || value.length === 0
      ? null
      : new Secret(made, value)
  }

  reveal(sink: Sink): T {
    if (!(sink instanceof Sink)) throw new TypeError('a secret is revealed to a sink')
    return this.#value
  }

  same(other: Secret<T> | null | undefined): boolean {
    if (!other) return false
    const a = this.#value
    const b = other.#value
    if (typeof a === 'string' || typeof b === 'string') return a === b
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
    return diff === 0
  }

  toJSON(): never {
    throw new TypeError('a secret cannot be serialized')
  }

  toString(): string {
    return SHOWN
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return SHOWN
  }
}

export const sameSecret = <T extends string | Uint8Array>(
  a: Secret<T> | null | undefined,
  b: Secret<T> | null | undefined
): boolean => (a ? a.same(b) : !b)
