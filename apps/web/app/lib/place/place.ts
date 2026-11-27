import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'

// Where a feature runs: a hosted server, a P2P room, a hosted DM or a P2P DM. A feature is
// written against these four handles and nothing else, so it reaches the account's store or the
// identity's runtime only through the place it was given.
export type PlaceKind = 'hostedServer' | 'p2pRoom' | 'hostedDm' | 'p2pDm'

declare const placeId: unique symbol
export type PlaceId = string & { readonly [placeId]: true }

const idOf = (kind: PlaceKind, key: string) => `${kind}:${key}` as PlaceId

export class HostedServer {
  readonly kind = 'hostedServer' as const
  readonly id: PlaceId
  private constructor(
    readonly account: AccountSession,
    // The server's name as the account's store keys it.
    readonly server: string
  ) {
    this.id = idOf(this.kind, server)
  }
  static open(account: AccountSession, server: string) {
    return held(account, idOf('hostedServer', server), () => new HostedServer(account, server))
  }
}

export class HostedDm {
  readonly kind = 'hostedDm' as const
  readonly id: PlaceId
  private constructor(
    readonly account: AccountSession,
    readonly dmId: number
  ) {
    this.id = idOf(this.kind, String(dmId))
  }
  static open(account: AccountSession, dmId: number) {
    return held(account, idOf('hostedDm', String(dmId)), () => new HostedDm(account, dmId))
  }
}

export class P2pRoom {
  readonly kind = 'p2pRoom' as const
  readonly id: PlaceId
  readonly account: AccountSession
  private constructor(
    readonly app: P2pApp,
    readonly room: string
  ) {
    this.id = idOf(this.kind, room)
    this.account = app.owner
  }
  static open(app: P2pApp, room: string) {
    return held(app, idOf('p2pRoom', room), () => new P2pRoom(app, room))
  }
}

export class P2pDm {
  readonly kind = 'p2pDm' as const
  readonly id: PlaceId
  readonly account: AccountSession
  private constructor(
    readonly app: P2pApp,
    // The conversation's key in the identity's store.
    readonly room: string
  ) {
    this.id = idOf(this.kind, room)
    this.account = app.owner
  }
  static open(app: P2pApp, room: string) {
    return held(app, idOf('p2pDm', room), () => new P2pDm(app, room))
  }
}

export type Place = HostedServer | P2pRoom | HostedDm | P2pDm
export type PlaceOf<K extends PlaceKind> = Extract<Place, { kind: K }>

// One handle per place of an account or identity, so what a feature builds for a place is built
// once. Handles go when their account or identity does.
const open = new WeakMap<object, Map<PlaceId, Place>>()
const HELD_MAX = 200

function held<P extends Place>(owner: object, id: PlaceId, make: () => P): P {
  let places = open.get(owner)
  if (!places) {
    places = new Map()
    open.set(owner, places)
  }
  const known = places.get(id)
  if (known) return known as P
  if (places.size >= HELD_MAX) places.clear()
  const made = make()
  places.set(id, made)
  return made
}

export const inDm = (place: Place): place is HostedDm | P2pDm =>
  place.kind === 'hostedDm' || place.kind === 'p2pDm'
export const isHosted = (place: Place): place is HostedServer | HostedDm =>
  place.kind === 'hostedServer' || place.kind === 'hostedDm'
