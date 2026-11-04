import type { Card } from './card'
import {
  cleanName,
  liveCerts,
  verifyCert,
  verifyProfile,
  verifyRevocation,
  type Cert,
  type Profile,
  type Revocation,
  type Succession,
} from './keys'
import { LOCAL } from './limits'

// The contact roster (XMPP subscription model): adding someone's card makes them `outgoing`
// until they accept; an unknown identity that reaches us lands in Message requests as
// `incoming`; accepting makes both sides `mutual`. Pure functions over contact records; the node
// persists them.

export type ContactState = 'outgoing' | 'incoming' | 'mutual' | 'blocked'

export interface Contact {
  ik: string
  // The name they claim (card or signed profile); a petname always wins in the UI.
  name: string
  petname: string | null
  profile: Profile | null
  certs: Cert[]
  revocations: Revocation[]
  state: ContactState
  // Ignored requests stay hidden and don't come back.
  ignored: boolean
  intros: string[]
  verified: boolean
  verifiedAt: number | null
  // The identity this one may be impersonating or replacing: shown red until verified.
  warning: string | null
  // A one-line notice: they moved to a new device, or reset their identity.
  notice: { kind: 'moved' | 'reset'; at: number } | null
  host: string
  added: number
  lastSeen: number | null
}

export const INTRO_MAX = LOCAL.contacts.introMax
export const INTROS_MAX = LOCAL.contacts.introsMax
export const PETNAME_MAX = LOCAL.contacts.petnameMax
export const CERTS_KEPT = LOCAL.contacts.certsKept

export const displayName = (c: Pick<Contact, 'petname' | 'name'>) =>
  c.petname || c.name || 'Unknown'

// Common Cyrillic and Greek look-alikes of Latin letters, and digits that pass for letters.
const CONFUSABLE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  ɩ: 'i',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  '0': 'o',
  '1': 'l',
  '|': 'l',
  ı: 'i',
}

// A rough skeleton: compatibility forms, no accents, no invisible characters, lower case,
// look-alike letters folded.
export const fold = (s: string) =>
  [
    ...s
      .normalize('NFKD')
      .replace(/[\p{M}\p{Cf}\s]/gu, '')
      .toLowerCase(),
  ]
    .map(ch => CONFUSABLE[ch] ?? ch)
    .join('')

// Another contact whose name (claimed or petname) matches this one's: the new key may be that
// person after a reset, or someone pretending to be them.
export const findLookalike = (contacts: Contact[], c: Contact): string | null => {
  const names = [c.name, c.petname].map(n => fold(n ?? '')).filter(n => n !== '')
  if (names.length === 0) return null
  const hit = contacts.find(
    o =>
      o.ik !== c.ik &&
      o.state !== 'blocked' &&
      !o.ignored &&
      [o.name, o.petname].some(n => !!n && names.includes(fold(n)))
  )
  return hit?.ik ?? null
}

// A claimed name changed (profile, hello, succession): check it against the other contacts
// again. A warning, once raised, stays until the user verifies the contact.
export const recheckName = (contacts: Contact[], before: Contact | undefined, c: Contact) => {
  if (c.warning !== null) return c
  if (before && fold(before.name) === fold(c.name)) return c
  const others = contacts.filter(o => o.ik !== c.ik && o.ik !== before?.ik)
  const hit = findLookalike(others, c)
  return hit === null ? c : { ...c, warning: hit }
}

// Certs of revoked devices are never kept or merged back.
export const mergeCerts = (have: Cert[], add: Cert[], ik: string, revs: Revocation[] = []) => {
  const revoked = (dk: string) => revs.some(r => r.dk === dk)
  const out = have.filter(c => !revoked(c.dk))
  for (const c of add) {
    if (revoked(c.dk) || out.some(o => o.dk === c.dk) || !verifyCert(c, ik)) continue
    out.push(c)
  }
  return out.sort((a, b) => b.created - a.created).slice(0, CERTS_KEPT)
}

export const mergeRevocations = (have: Revocation[], add: Revocation[], ik: string) => {
  const out = [...have]
  // The first revocation of a device counts. A second one with another successor is kept as
  // evidence that two copies of the identity moved the same device (see identityConflict), and
  // one without a successor (lost or stolen) is kept next to a move.
  for (const r of add) {
    const same = out.filter(o => o.dk === r.dk)
    if (same.some(o => o.successor === r.successor)) continue
    if (r.successor !== undefined && same.filter(o => o.successor !== undefined).length >= 2)
      continue
    if (!verifyRevocation(r, ik)) continue
    out.push(r)
  }
  return out.slice(-CERTS_KEPT * 2)
}

export const blank = (ik: string, now: number, host = ''): Contact => ({
  ik,
  name: '',
  petname: null,
  profile: null,
  certs: [],
  revocations: [],
  state: 'outgoing',
  ignored: false,
  intros: [],
  verified: false,
  verifiedAt: null,
  warning: null,
  notice: null,
  host,
  added: now,
  lastSeen: null,
})

export type AddResult =
  { ok: true; contact: Contact; created: boolean } | { ok: false; error: string }

export const SELF_CARD = "That's your own contact code"
export const BLOCKED = 'You blocked this contact. Remove the block first.'

// Adding a card: a new contact is `outgoing`; one that asked us first becomes `mutual`.
export const addFromCard = (
  contacts: Contact[],
  card: Card,
  me: string,
  now: number
): AddResult => {
  if (card.ik === me) return { ok: false, error: SELF_CARD }
  const have = contacts.find(c => c.ik === card.ik)
  if (have?.state === 'blocked') return { ok: false, error: BLOCKED }
  const base = have ?? blank(card.ik, now, card.sig_host)
  const next: Contact = {
    ...base,
    name: base.profile ? base.name : card.name,
    certs: mergeCerts(base.certs, card.certs, card.ik, base.revocations),
    // Only a hint: nothing on the card besides the certs is signed.
    host: card.sig_host,
    ignored: false,
    state: base.state === 'incoming' && have ? 'mutual' : base.state,
    intros: base.state === 'incoming' && have ? [] : base.intros,
  }
  return { ok: true, contact: recheckName(contacts, have, next), created: !have }
}

export type RequestResult =
  | { kind: 'new'; contact: Contact }
  | { kind: 'updated'; contact: Contact }
  | { kind: 'mutual'; contact: Contact }
  | { kind: 'dropped'; why: 'blocked' | 'ignored' | 'limit' }

export const cleanIntro = (raw: unknown) =>
  typeof raw === 'string' ? [...cleanText(raw)].slice(0, INTRO_MAX).join('') : ''

const cleanText = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')

export interface Hello {
  ik: string
  certs: Cert[]
  profile: Profile | null
  intro: string
}

// Someone asked to be our contact. Unknown identities become a request with their intro (at most
// INTROS_MAX distinct intros are kept); one we added ourselves becomes mutual.
export const receiveRequest = (contacts: Contact[], h: Hello, now: number): RequestResult => {
  const have = contacts.find(c => c.ik === h.ik)
  if (have?.state === 'blocked') return { kind: 'dropped', why: 'blocked' }
  if (have?.ignored) return { kind: 'dropped', why: 'ignored' }
  const intro = cleanIntro(h.intro).trim()
  if (!have) {
    const c: Contact = {
      ...withProfile(blank(h.ik, now), h.profile),
      certs: mergeCerts([], h.certs, h.ik),
      state: 'incoming',
      intros: intro ? [intro] : [],
    }
    c.warning = findLookalike(contacts, c)
    return { kind: 'new', contact: c }
  }
  const merged = withProfile(
    { ...have, certs: mergeCerts(have.certs, h.certs, h.ik, have.revocations) },
    h.profile
  )
  if (have.state === 'outgoing')
    return { kind: 'mutual', contact: { ...merged, state: 'mutual', intros: [] } }
  if (have.state === 'mutual') return { kind: 'updated', contact: merged }
  if (!intro || have.intros.includes(intro)) return { kind: 'updated', contact: merged }
  if (have.intros.length >= INTROS_MAX) return { kind: 'dropped', why: 'limit' }
  return { kind: 'updated', contact: { ...merged, intros: [...have.intros, intro] } }
}

// A newer valid signed profile replaces the claimed name.
export const withProfile = (c: Contact, p: Profile | null): Contact => {
  if (!p || !verifyProfile(p, c.ik)) return c
  if (c.profile && c.profile.updated >= p.updated) return c
  return { ...c, profile: p, name: p.name }
}

export const accept = (c: Contact): Contact =>
  c.state === 'incoming' ? { ...c, state: 'mutual', intros: [], ignored: false } : c

export const ignore = (c: Contact): Contact => ({ ...c, ignored: true, intros: [] })

export const block = (c: Contact): Contact => ({ ...c, state: 'blocked', intros: [] })

// They told us they don't have us (removed us): we are back to asking.
export const unfriended = (c: Contact): Contact =>
  c.state === 'mutual' ? { ...c, state: 'outgoing' } : c

export const rename = (c: Contact, petname: string): Contact => {
  const p = cleanName(petname).slice(0, PETNAME_MAX)
  return { ...c, petname: p || null }
}

export const markVerified = (c: Contact, now: number): Contact => ({
  ...c,
  verified: true,
  verifiedAt: now,
  warning: null,
})

// Shield colors: red while a warning stands, green once verified, grey otherwise.
export type Shield = 'warning' | 'verified' | 'unverified'

export const shieldOf = (c: Pick<Contact, 'warning' | 'verified'>): Shield =>
  c.warning !== null ? 'warning' : c.verified ? 'verified' : 'unverified'

export const warningText = (name: string) =>
  `This contact uses a new key. It may be ${name} after a reset, or someone else.`

export const isRevoked = (c: Pick<Contact, 'revocations'>, dk: string) =>
  c.revocations.some(r => r.dk === dk)

// Pending requests past `max`: the oldest unverified ones, which make room for newer ones.
export const overflowRequests = (all: Contact[], max: number) => {
  const pending = all
    .filter(c => c.state === 'incoming' && !c.ignored && !c.verified)
    .sort((a, b) => a.added - b.added)
  return pending.slice(0, Math.max(0, pending.length - max)).map(c => c.ik)
}

// Devices we may dial: certified and not revoked.
export const dialable = (c: Contact) =>
  c.state === 'blocked' || c.state === 'incoming' || c.ignored
    ? []
    : liveCerts(c.certs, c.revocations)

// New certs and revocations from the contact. A new device of the same identity is a move,
// not a key change: verification is kept and a notice is shown.
export const updateDevices = (
  c: Contact,
  certs: Cert[],
  revocations: Revocation[],
  now: number
): Contact => {
  const revs = mergeRevocations(c.revocations, revocations, c.ik)
  const all = mergeCerts(c.certs, certs, c.ik, revs)
  const moved = revs.some(r => r.successor && !c.revocations.some(o => o.dk === r.dk))
  return {
    ...c,
    certs: all,
    revocations: revs,
    notice: moved ? { kind: 'moved', at: now } : c.notice,
  }
}

// An identity reset signed by both keys moves the contact to the new identity. Verification
// drops, since the key changed.
export const applySuccession = (
  contacts: Contact[],
  s: Succession,
  certs: Cert[],
  profile: Profile | null,
  now: number
): Contact | null => {
  const old = contacts.find(c => c.ik === s.old)
  if (!old || old.state === 'blocked' || contacts.some(c => c.ik === s.new && !c.ignored))
    return null
  const moved: Contact = {
    ...old,
    ik: s.new,
    profile: null,
    certs: mergeCerts([], certs, s.new),
    revocations: [],
    verified: false,
    verifiedAt: null,
    warning: null,
    notice: { kind: 'reset', at: now },
  }
  return withProfile(moved, profile)
}

// The same contact from another copy of this identity (a device import): devices and profile
// merge, a block or a mutual subscription on either side wins, local names and marks stay.
export const mergeContact = (local: Contact, other: Contact, now: number): Contact => {
  const c = withProfile(updateDevices(local, other.certs, other.revocations, now), other.profile)
  const state: ContactState =
    local.state === 'blocked' || other.state === 'blocked'
      ? 'blocked'
      : local.state === 'mutual' || other.state === 'mutual'
        ? 'mutual'
        : local.state
  return {
    ...c,
    state,
    ignored: state === 'incoming' && local.ignored,
    intros: state === 'incoming' ? local.intros : [],
    petname: local.petname ?? other.petname,
    verified: local.verified || other.verified,
    verifiedAt: local.verifiedAt ?? other.verifiedAt,
    warning: local.warning ?? other.warning,
    lastSeen: Math.max(local.lastSeen ?? 0, other.lastSeen ?? 0) || null,
  }
}

export const visibleContacts = (all: Contact[]) =>
  all
    .filter(c => c.state !== 'incoming' && c.state !== 'blocked' && !c.ignored)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))

export const requests = (all: Contact[]) =>
  all.filter(c => c.state === 'incoming' && !c.ignored).sort((a, b) => b.added - a.added)

export const blocked = (all: Contact[]) => all.filter(c => c.state === 'blocked')
