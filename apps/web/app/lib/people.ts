import type { P2pPic } from './p2p/pictures'
import type { MemberLook, UserRef } from './types'

// The people the app draws. A name or a picture is drawn only from one of these two values, so
// each place that draws someone has said how: as the place on screen shows them (its server
// profile over the account's), or as their account or identity has them, with the reason.

const minted: unique symbol = Symbol('person')
type Minted = typeof minted

// Someone as a place shows them. `avatar_image` is null unless they have a picture on an
// instance. `avatar_pic` is the P2P picture a room settled for them (its look says: null for
// none), and is left out where the picture of their identity shows.
export class ShownPerson implements UserRef {
  declare private readonly shown: true
  declare readonly avatar_image: string | null
  declare readonly avatar_pic?: P2pPic | null
  constructor(
    by: Minted,
    readonly username: string,
    readonly display_name: string,
    readonly avatar_kind: UserRef['avatar_kind'],
    readonly avatar_color: string | null
  ) {
    if (by !== minted) throw new TypeError('people come from the functions of this module')
  }
}

// Why someone is drawn as their account or identity has them, outside any server profile.
export type AccountWhy =
  // Your own accounts and identities.
  | 'own'
  // Site administration lists accounts.
  | 'administration'
  // The choices of an avatar editor, and the preview of a profile being edited.
  | 'editor'
  // Blocks and friends are between accounts.
  | 'block'
  | 'friend'
  // Hosted DMs, and where they are named.
  | 'dm'
  // P2P contacts, the people of P2P DMs and requests from identities outside a server.
  | 'contact'
  | 'request'
  // A forward names its author as the place it came from had them.
  | 'forward'
  // An invite or a widget shows people outside their server.
  | 'invite'
  | 'widget'
  // A webhook keeps its own name and picture; a guest has only a label.
  | 'webhook'
  | 'guest'
  // A notice or a call names the person it was built with.
  | 'notice'
  | 'call'
  // Someone a place has no profile for: gone from it, or not loaded and never a member.
  | 'unknown'

// Someone as their account or identity has them.
export class AccountPerson implements UserRef {
  declare private readonly account: true
  declare readonly avatar_image: string | null
  declare readonly avatar_pic?: P2pPic | null
  constructor(
    by: Minted,
    readonly why: AccountWhy,
    readonly username: string,
    readonly display_name: string,
    readonly avatar_kind: UserRef['avatar_kind'],
    readonly avatar_color: string | null
  ) {
    if (by !== minted) throw new TypeError('people come from the functions of this module')
  }
}

export type Person = ShownPerson | AccountPerson

const pictureOf = (image: string | null | undefined) => ({ avatar_image: image || null })

const plain = new WeakMap<UserRef, ShownPerson>()
const looked = new WeakMap<UserRef, WeakMap<MemberLook, ShownPerson>>()

// `ref` as a place shows it: the name and avatar of the look over the account's. An explicit
// avatar kind replaces the whole account avatar, color and picture included; a picture of the
// look shows over either. The username never changes, so the identicon keeps its seed. The other fields of `ref` come along. The same `ref` and
// `look` give the same person, so a list row that takes one renders again only when they change.
export function shownUser<T extends UserRef>(
  ref: T,
  look: MemberLook | null | undefined
): T & ShownPerson {
  const known = look ? looked.get(ref)?.get(look) : plain.get(ref)
  if (known) return known as T & ShownPerson
  const built =
    !look || look.avatar_kind === null
      ? { avatar_kind: ref.avatar_kind, avatar_color: ref.avatar_color }
      : { avatar_kind: look.avatar_kind, avatar_color: look.avatar_color }
  const { avatar_image: account = null, avatar_pic: own, ...rest } = ref
  const image = look ? (look.avatar_image ?? (look.avatar_kind === null ? account : null)) : account
  const pic = look && look.avatar_pic !== undefined ? look.avatar_pic : own
  const avatar = {
    ...built,
    ...pictureOf(image),
    ...(pic === undefined ? {} : { avatar_pic: pic }),
  }
  const name = look && look.name !== null ? look.name : ref.display_name
  const person = Object.assign(
    new ShownPerson(minted, ref.username, name, avatar.avatar_kind, avatar.avatar_color),
    { ...rest, display_name: name, ...avatar }
  ) as T & ShownPerson
  if (!look) plain.set(ref, person)
  else {
    const byLook = looked.get(ref) ?? new WeakMap<MemberLook, ShownPerson>()
    looked.set(ref, byLook)
    byLook.set(look, person)
  }
  return person
}

const accounts = new WeakMap<UserRef, Map<AccountWhy, AccountPerson>>()

// `user` as their account or identity has them, for the reason given.
export function asAccount<T extends UserRef>(user: T, why: AccountWhy): T & AccountPerson {
  let known = accounts.get(user)
  const before = known?.get(why)
  if (before) return before as T & AccountPerson
  const { avatar_image: image, ...rest } = user
  const person = Object.assign(
    new AccountPerson(
      minted,
      why,
      user.username,
      user.display_name,
      user.avatar_kind,
      user.avatar_color
    ),
    { ...rest, ...pictureOf(image) }
  ) as T & AccountPerson
  if (!known) accounts.set(user, (known = new Map()))
  known.set(why, person)
  return person
}

// An account known only by what its picture needs.
export const pictured = (
  username: string,
  avatar:
    | { kind: UserRef['avatar_kind']; color: string | null; image?: string | null }
    | null
    | undefined,
  why: AccountWhy
): AccountPerson =>
  Object.assign(
    new AccountPerson(
      minted,
      why,
      username,
      '',
      avatar?.kind ?? 'identicon',
      avatar?.color ?? null
    ),
    pictureOf(avatar?.image)
  )

const identities = new Map<string, UserRef>()

// A P2P identity known only by its key: its picture comes from the key, and it has no name here.
export function identityPerson(ik: string, why: AccountWhy): AccountPerson {
  let ref = identities.get(ik)
  if (!ref) {
    ref = {
      username: ik,
      display_name: '',
      avatar_kind: 'identicon',
      avatar_color: null,
      avatar_image: null,
    }
    identities.set(ik, ref)
  }
  return asAccount(ref, why)
}
