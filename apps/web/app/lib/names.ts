import { isGuestName } from './guest_voice'
import type { Person } from './people'
import { isWebhookAuthor } from './webhooks'

// The names the app draws: people, servers, instances, accounts and P2P identities. A name is a
// value only the functions below make, and only the `Name` component draws one, so every name on
// screen gets streamer mode and the viewer's own filter the same way.

const minted: unique symbol = Symbol('name')
type Minted = typeof minted

export type Mask = (text: string) => string

// A person: a display name, and a username beside it when the two differ. `who` is what decides
// whether the name is the viewer's own (a username, or an identity key in a P2P place). `plain`
// text is the app's own (a guest's label) and is never masked.
export class PersonName {
  readonly kind = 'person' as const
  constructor(
    private readonly by: Minted,
    readonly display: string,
    readonly username: string | null,
    readonly who: string | null,
    readonly own: boolean | undefined,
    readonly plain: boolean
  ) {
    if (this.by !== minted) throw new TypeError('names come from the functions of this module')
  }
}

// A hosted server or a P2P room. `server` is the hosted server's key, which decides whether the
// viewer named it.
export class ServerName {
  readonly kind = 'server' as const
  constructor(
    private readonly by: Minted,
    readonly text: string,
    readonly server: string | null,
    readonly own: boolean | undefined
  ) {
    if (this.by !== minted) throw new TypeError('names come from the functions of this module')
  }
}

// An instance's label, or its address. An address is shown as written.
export class InstanceName {
  readonly kind = 'instance' as const
  constructor(
    private readonly by: Minted,
    readonly text: string,
    readonly address: boolean
  ) {
    if (this.by !== minted) throw new TypeError('names come from the functions of this module')
  }
}

// One of the viewer's own accounts, as the switcher and the settings call it.
export class AccountLabel {
  readonly kind = 'account' as const
  constructor(
    private readonly by: Minted,
    readonly text: string
  ) {
    if (this.by !== minted) throw new TypeError('names come from the functions of this module')
  }
}

// A P2P display name, or the fingerprint of a key. Only the viewer's own filter ever masks it.
export class P2pName {
  readonly kind = 'p2p' as const
  constructor(
    private readonly by: Minted,
    readonly text: string,
    readonly key: boolean,
    readonly own: boolean | undefined
  ) {
    if (this.by !== minted) throw new TypeError('names come from the functions of this module')
  }
}

export type NameValue = PersonName | ServerName | InstanceName | AccountLabel | P2pName
export type NameKind = NameValue['kind']

// A person by the name they are drawn under. `own` says whose name it is where the username is
// not an account here (a P2P identity); left out, the username decides.
export const personName = (person: Person, own?: boolean): PersonName => {
  const guest = isGuestName(person.username)
  const pair =
    !guest &&
    !isWebhookAuthor(person.username) &&
    person.display_name.toLowerCase() !== person.username
  return new PersonName(
    minted,
    person.display_name,
    pair ? person.username : null,
    own === undefined ? person.username : null,
    own,
    guest
  )
}

// A username alone, as a mention or a sign-in line writes it.
export const handleName = (username: string, own?: boolean): PersonName =>
  new PersonName(minted, username, null, own === undefined ? username : null, own, false)

// A person by a name alone. `who` is the username or identity key the name belongs to, which
// decides whether it is the viewer's own; `own` says it outright.
export const personCalled = (text: string, who?: string | null, own?: boolean): PersonName =>
  new PersonName(minted, text, null, own === undefined ? (who ?? null) : null, own, false)

export const serverName = (
  server: { name: string; display_name?: string | null },
  own?: boolean
): ServerName => new ServerName(minted, server.display_name || server.name, server.name, own)

// A hosted server by its shown name alone, where its record is not at hand.
export const serverCalled = (text: string, own?: boolean): ServerName =>
  new ServerName(minted, text, null, own)

// A P2P room by the name this device has for it.
export const roomName = (name: string, own?: boolean): ServerName =>
  new ServerName(minted, name, null, own)

export const instanceName = (label: string): InstanceName => new InstanceName(minted, label, false)

export const instanceAddress = (host: string): InstanceName => new InstanceName(minted, host, true)

export const accountLabel = (text: string): AccountLabel => new AccountLabel(minted, text)

export const p2pName = (text: string, own?: boolean): P2pName =>
  new P2pName(minted, text, false, own)

export const p2pKey = (fingerprint: string): P2pName =>
  new P2pName(minted, fingerprint, true, undefined)

// The two parts a name is drawn in: the name, and the username after it.
export const nameParts = (
  name: NameValue,
  withUsername: boolean
): { main: string; handle: string | null } =>
  name.kind === 'person'
    ? { main: name.display, handle: withUsername ? name.username : null }
    : { main: name.text, handle: null }

// The name as plain text, as written: "Display (username)" for a person shown with a username.
export const nameText = (name: NameValue, withUsername = false): string => {
  const { main, handle } = nameParts(name, withUsername)
  return handle === null ? main : `${main} (${handle})`
}

// Whether the viewer's filter applies: never to their own names, the app's own labels, addresses
// or key fingerprints.
export const masksName = (name: NameValue, own: boolean): boolean => {
  if (own) return false
  if (name.kind === 'person') return !name.plain
  if (name.kind === 'instance') return !name.address
  if (name.kind === 'account') return false
  if (name.kind === 'p2p') return !name.key
  return true
}

export interface NameView {
  streamer: boolean
  // The viewer's own filter, or the text as it is while the filter is off.
  mask: Mask
  own: boolean
}

// The name as the viewer's filter shows it, as plain text.
export const shownNameText = (name: NameValue, view: NameView, withUsername = false): string => {
  const text = nameText(name, withUsername)
  return masksName(name, view.own) ? view.mask(text) : text
}

// A tooltip for the name: none in streamer mode.
export const nameTitle = (
  name: NameValue,
  view: NameView,
  withUsername = false
): string | undefined => (view.streamer ? undefined : shownNameText(name, view, withUsername))

const GENERIC: Record<NameKind, string> = {
  person: 'Someone',
  server: 'Server',
  instance: 'Instance',
  account: 'Account',
  p2p: 'Contact',
}

// What a label or a tooltip says in place of the name: `generic` in streamer mode.
export const nameLabel = (
  name: NameValue,
  view: NameView,
  generic: string = GENERIC[name.kind],
  withUsername = false
): string => (view.streamer ? generic : shownNameText(name, view, withUsername))

// What the masked words of one name open under, so a reveal shows the whole of it.
export const revealKeyOf = (name: NameValue): string =>
  name.kind === 'person' ? `name:${name.username ?? name.display}` : `${name.kind}:${name.text}`
