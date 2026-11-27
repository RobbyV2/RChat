import type { HostedDm, HostedServer, P2pDm, P2pRoom, Place } from './place'

// A feature a place does not have, with the line its turned-off control shows.
export class Unsupported {
  readonly supported = false as const
  constructor(
    readonly why: 'unsupported' | 'not_in_dms' | 'no_place',
    readonly line: string
  ) {}
}

// A feature without a DM form on either side.
export const notInDms = (line = 'Not available in direct messages') =>
  new Unsupported('not_in_dms', line)
export const unsupported = (line: string) => new Unsupported('unsupported', line)
const NO_PLACE = new Unsupported('no_place', 'Open a server or a conversation first')

export const isUnsupported = (value: unknown): value is Unsupported => value instanceof Unsupported

// The four sides of a feature. Every key is required: a feature that leaves a side out does not
// compile, and a side that cannot have it says so with a line.
export interface Sides<F> {
  hostedServer: (place: HostedServer) => F | Unsupported
  p2pRoom: (place: P2pRoom) => F | Unsupported
  hostedDm: (place: HostedDm) => F | Unsupported
  p2pDm: (place: P2pDm) => F | Unsupported
}

const sides = new WeakMap<object, Sides<unknown>>()
const built = new WeakMap<Place, Map<object, unknown>>()

export class Feature<F> {
  // Keeps features of different surfaces apart for the type checker.
  declare private readonly surface: F
  private constructor(readonly name: string) {}
  static define<F>(name: string, impl: Sides<F>): Feature<F> {
    const feature = new Feature<F>(name)
    sides.set(feature, impl)
    return feature
  }
}

export const defineFeature = <F>(name: string, impl: Sides<F>): Feature<F> =>
  Feature.define(name, impl)

const build = <F>(impl: Sides<F>, place: Place): F | Unsupported => {
  switch (place.kind) {
    case 'hostedServer':
      return impl.hostedServer(place)
    case 'p2pRoom':
      return impl.p2pRoom(place)
    case 'hostedDm':
      return impl.hostedDm(place)
    case 'p2pDm':
      return impl.p2pDm(place)
  }
}

// The feature as `place` has it, built once per place.
export function featureAt<F>(feature: Feature<F>, place: Place | null): F | Unsupported {
  if (place === null) return NO_PLACE
  let known = built.get(place)
  if (!known) {
    known = new Map()
    built.set(place, known)
  }
  if (known.has(feature)) return known.get(feature) as F | Unsupported
  const made = build(sides.get(feature) as Sides<F>, place)
  known.set(feature, made)
  return made
}
