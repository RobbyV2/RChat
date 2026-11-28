// Why a peer is struck. A session counts strikes and drops a peer that collects too many, so a
// strike needs a reason, and there are four: a known field that is malformed, a signature that
// does not verify, more of something than any honest client sends, and a request or answer the
// sender is not entitled to. A field, op or kind this version does not know is none of them: a
// reader answers `unknown` for it, which carries no strike.

const made = Symbol('strike')

export type StrikeKind = 'malformed' | 'signature' | 'volume' | 'unentitled'

export class Strike {
  constructor(
    key: typeof made,
    readonly kind: StrikeKind,
    // The field, frame, message or request it is about.
    readonly what: string
  ) {
    if (key !== made) throw new TypeError('a strike comes from its four reasons')
  }
}

export const malformed = (field: string) => new Strike(made, 'malformed', field)
export const badSignature = (of: string) => new Strike(made, 'signature', of)
export const volume = (of: string) => new Strike(made, 'volume', of)
export const unentitled = (request: string) => new Strike(made, 'unentitled', request)

// What a frame reader answers: the frame, `unknown` for a well-formed one this version does not
// know (dropped at no cost), or the strike its malformed known field earns.
export type Read<T> = { v: T } | { unknown: true } | { strike: Strike }

export const readAs = <T>(v: T): Read<T> => ({ v })
export const UNKNOWN: { unknown: true } = { unknown: true }
export const struck = (field: string): { strike: Strike } => ({ strike: malformed(field) })
