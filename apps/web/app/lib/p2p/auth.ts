import {
  can,
  CHANNEL_KINDS,
  channelOf,
  codeOf,
  createOf,
  isMembership,
  isOwner,
  isStateType,
  memberOf,
  membershipOf,
  P,
  permsOf,
  rankOf,
  roleIdsOf,
  roleOf,
  STATE_LIMITS,
  stateKey,
  type CodeContent,
  type CreateContent,
  type MemberContent,
  type RoleContent,
  type RolesContent,
  type StateEvent,
  type StateMap,
} from './state'

// The room auth rules of P2P servers (note section 6), as pure functions of an event and a
// state: the state its `auth` events form when it arrives, and the state accumulated so far when
// resolution replays it. Nothing here reads a clock or storage.

// The event under test. `content` is null for a redacted copy (messages only).
export interface Candidate {
  id: string
  type: string
  sender: string
  skey?: string
  content: Record<string, unknown> | null
  auth: string[]
}

// Why an event is refused, or null when it is allowed. Refusals that start with `unknown` are
// about values a newer version may have added (an enum value, a channel kind): such events are
// stored and synced without a strike, and are inert here (forward compatibility).
export type Refusal = string | null

export const isUnknownRefusal = (why: Refusal) => !!why && why.startsWith('unknown')

// Who may moderate (their state events and redactions are always stored, past every cap).
export const MOD_PERMS = P.Kick | P.Ban | P.ManageServer | P.ManageRoles | P.ManageMessages
export const isModerator = (s: StateMap, ik: string) =>
  membershipOf(s, ik) === 'join' && (isOwner(s, ik) || can(s, ik, MOD_PERMS))

const NON_STATE_ANY = new Set(['edit', 'react', 'redact', 'move', 'call'])

// What a check may know beyond the state: the event's effective time (its position in time:
// never before its parents), and counters resolution keeps alongside the state (without them
// the state is scanned, which is fine for the small state an event cites).
export interface CheckCtx {
  at?: number
  invites?: (ik: string) => number
  codeInvites?: (code: string) => number
  codes?: (ik: string) => number
}

export const check = (ev: Candidate, s: StateMap, ctx: CheckCtx = {}): Refusal => {
  const { type, sender } = ev
  const c = ev.content
  if (type === 'create') {
    if (createOf(s)) return 'second create'
    return c && (c as unknown as CreateContent).creator === sender ? null : 'creator'
  }
  const create = createOf(s)
  if (!create) return 'no create'
  const isState = ev.skey !== undefined
  if (isState && !c) return 'state without content'
  const mine = membershipOf(s, sender)
  const self = type === 'member' && ev.skey === sender ? (c as MemberContent | null)?.m : null
  if (type === 'member' && !isMembership((c as MemberContent | null)?.m))
    return 'unknown membership'
  // Joining: after an invite, again to refresh a device or profile, or the creator first.
  if (self === 'join') {
    if (mine === 'invite') {
      // An invite signed for someone who redeemed a code lapses.
      const exp = (memberOf(s, sender) as { exp?: unknown } | null)?.exp
      return typeof exp === 'number' && ctx.at !== undefined && ctx.at > exp
        ? 'invite lapsed'
        : null
    }
    if (mine === 'join') return refresh(c as unknown as MemberContent, s, sender)
    if (mine === null && sender === create.creator && !memberOf(s, sender)) return null
    return 'join without invite'
  }
  // Leaving, or turning an invite down.
  if (self === 'leave') return mine === 'invite' || mine === 'join' ? null : 'not in'
  if (mine !== 'join') return 'not joined'
  switch (type) {
    case 'member':
      return member(ev, c as unknown as MemberContent, s, ctx)
    case 'owner': {
      const target = (c as { ik: string }).ik
      if (!isOwner(s, sender)) return 'not owner'
      if (target === sender) return 'already owner'
      return membershipOf(s, target) === 'join' ? null : 'owner not joined'
    }
    case 'role':
      return role(ev, c as unknown as RoleContent, s)
    case 'roles':
      return roles(ev, c as unknown as RolesContent, s)
    case 'name':
    case 'history':
    case 'system':
      return can(s, sender, P.ManageServer) ? null : 'ManageServer'
    case 'code': {
      if (can(s, sender, P.ManageServer)) return null
      const old = codeOf(s, ev.skey as string)
      if (!can(s, sender, P.Invite) || (old && old.sender !== sender)) return 'code'
      // A member's live codes are capped (revoking one makes room).
      if ((c as unknown as CodeContent).revoked || (old && !old.revoked)) return null
      const live = ctx.codes ? ctx.codes(sender) : liveCodes(s, sender)
      return live < STATE_LIMITS.codesPerMember ? null : 'too many codes'
    }
    case 'channel':
      return can(s, sender, P.ManageChannels) ? null : 'ManageChannels'
    case 'msg': {
      // A redacted copy can't say its channel; it was checked where it was whole.
      if (!c) return null
      const ch = channelOf(s, String(c.ch))
      if (!ch || ch.gone) return 'no channel'
      if (!CHANNEL_KINDS.includes(ch.kind)) return 'unknown channel kind'
      return ch.kind === 'text' ? null : 'not a text channel'
    }
    case 'pin':
      return can(s, sender, P.ManageMessages) ? null : 'ManageMessages'
    default:
      // Edits, reactions and redactions are checked against their target too (targetOk). Types
      // from a newer version only need a member.
      return NON_STATE_ANY.has(type) || !isStateType(type) ? null : 'unknown'
  }
}

const member = (ev: Candidate, c: MemberContent, s: StateMap, ctx: CheckCtx): Refusal => {
  const actor = ev.sender
  const target = ev.skey as string
  const cur = membershipOf(s, target)
  switch (c.m) {
    case 'invite':
      if (target === actor) return 'self invite'
      if (!can(s, actor, P.Invite)) return 'Invite'
      if (cur === 'join' || cur === 'ban') return 'already in'
      // An invite signed for someone who redeemed a code: the code must be live where the
      // invite sits (not revoked, not expired by then, its issuer still in and allowed to
      // invite), the invite lapses with it, and only a few are pending per code.
      if (c.code !== undefined) {
        const code = codeOf(s, c.code)
        if (!code || code.revoked) return 'code revoked'
        const made = (s.get(stateKey('code', c.code)) as StateEvent).ts
        const exp = Math.min(code.exp, made + STATE_LIMITS.codeTtl)
        if (typeof c.exp !== 'number' || c.exp > exp) return 'invite outlives code'
        if (ctx.at !== undefined && ctx.at > exp) return 'code expired'
        if (
          membershipOf(s, code.sender) !== 'join' ||
          !(can(s, code.sender, P.Invite) || can(s, code.sender, P.ManageServer))
        )
          return 'code dead'
        const n = ctx.codeInvites ? ctx.codeInvites(c.code) : codeInvites(s, c.code)
        return cur === 'invite' || n < STATE_LIMITS.codeInvites ? null : 'code busy'
      }
      // Pending invites of members who can't moderate are capped.
      if (
        cur !== 'invite' &&
        !isModerator(s, actor) &&
        (ctx.invites ? ctx.invites(actor) : pendingInvites(s, actor)) >=
          STATE_LIMITS.invitesPerMember
      )
        return 'too many invites'
      return null
    case 'join':
      return 'join for someone else'
    case 'leave': {
      if (target === actor) return null
      // Lifting a ban: Ban, and not a ban someone above you put there.
      if (cur === 'ban') {
        if (!can(s, actor, P.Ban)) return 'Ban'
        const by = memberOf(s, target)?.sender as string
        return isOwner(s, actor) || rankOf(s, by) <= rankOf(s, actor) ? null : 'rank'
      }
      // A kick, or taking an invite back.
      if (cur !== 'join' && cur !== 'invite') return 'not in'
      if (!can(s, actor, P.Kick)) return 'Kick'
      return rankOf(s, target) < rankOf(s, actor) ? null : 'rank'
    }
    case 'ban':
      if (target === actor) return 'self ban'
      if (!can(s, actor, P.Ban)) return 'Ban'
      return rankOf(s, target) < rankOf(s, actor) ? null : 'rank'
    default:
      return 'unknown membership'
  }
}

// A join on top of a join only when it changes something: a new device, or a newer profile.
const refresh = (c: MemberContent, s: StateMap, ik: string): Refusal => {
  const cur = memberOf(s, ik)
  if (c.cert && c.cert.dk !== cur?.cert?.dk) return null
  if (c.profile && c.profile.updated > (cur?.profile?.updated ?? -1)) return null
  return 'no change'
}

const liveCodes = (s: StateMap, ik: string) => {
  let n = 0
  for (const e of s.values()) if (isLiveCode(e) && e.sender === ik) n += 1
  return n
}

// A pending invite, and whose cap it counts against: its sender's, or the code it was signed for.
export const inviteOf = (e: StateEvent): { by: string } | { code: string } | null => {
  if (e.type !== 'member' || e.skey === e.sender || e.content.m !== 'invite') return null
  const code = e.content.code
  return typeof code === 'string' ? { code } : { by: e.sender }
}

export const isLiveCode = (e: StateEvent) =>
  e.type === 'code' && !(e.content as { revoked?: unknown }).revoked

const pendingInvites = (s: StateMap, ik: string) => {
  let n = 0
  for (const e of s.values()) {
    const inv = inviteOf(e)
    if (inv && 'by' in inv && inv.by === ik) n += 1
  }
  return n
}

const codeInvites = (s: StateMap, code: string) => {
  let n = 0
  for (const e of s.values()) {
    const inv = inviteOf(e)
    if (inv && 'code' in inv && inv.code === code) n += 1
  }
  return n
}

const role = (ev: Candidate, c: RoleContent, s: StateMap): Refusal => {
  const actor = ev.sender
  if (!can(s, actor, P.ManageRoles)) return 'ManageRoles'
  const r = rankOf(s, actor)
  const old = roleOf(s, ev.skey as string)
  if (!(c.pos < r) || (old && !(old.pos < r))) return 'rank'
  // Only bits the actor has.
  if (!isOwner(s, actor) && (c.perms & ~permsOf(s, actor)) !== 0) return 'perms'
  return null
}

const roles = (ev: Candidate, c: RolesContent, s: StateMap): Refusal => {
  const actor = ev.sender
  const target = ev.skey as string
  if (!can(s, actor, P.ManageRoles)) return 'ManageRoles'
  const owner = isOwner(s, actor)
  // Nobody raises themselves; the owner is already above every role.
  if (target === actor ? !owner : !(rankOf(s, target) < rankOf(s, actor))) return 'rank'
  const r = rankOf(s, actor)
  const old = roleIdsOf(s, target)
  for (const id of c.ids) {
    if (old.includes(id)) continue
    const def = roleOf(s, id)
    if (!def || def.gone || !(def.pos < r)) return 'role'
  }
  for (const id of old) {
    if (c.ids.includes(id)) continue
    const def = roleOf(s, id)
    if (def && !def.gone && !(def.pos < r)) return 'role'
  }
  return null
}

export const authorize = (ev: Candidate, s: StateMap, ctx?: CheckCtx) => check(ev, s, ctx) === null

// ----- Auth references -----

// State types an event may cite.
const CITABLE = new Set(['create', 'owner', 'member', 'roles', 'role', 'channel', 'code'])

// The state keys an event's rules read in `s`, which its `auth` must cite (those that exist): the
// create and owner events, the sender's member and roles events with every role they name and
// @everyone, the target's member and roles events with their roles (membership and roles events
// about someone else), the new owner's member event, the roles a roles event hands out, the
// event's own key for role, code and channel events, and the channel of a message.
export const authKeys = (
  s: StateMap,
  ev: { type: string; sender: string; skey?: string; content?: Record<string, unknown> | null }
): string[] => {
  if (ev.type === 'create') return []
  const keys: string[] = []
  const add = (type: string, skey: string) => {
    const k = stateKey(type, skey)
    if (s.has(k) && !keys.includes(k)) keys.push(k)
  }
  const person = (ik: string) => {
    add('member', ik)
    add('roles', ik)
    for (const id of roleIdsOf(s, ik)) add('role', id)
  }
  add('create', '')
  add('owner', '')
  person(ev.sender)
  add('role', 'everyone')
  if ((ev.type === 'member' || ev.type === 'roles') && ev.skey && ev.skey !== ev.sender)
    person(ev.skey)
  // An ownership transfer: the new owner's membership.
  const to = ev.type === 'owner' ? (ev.content as { ik?: unknown } | null | undefined)?.ik : null
  if (typeof to === 'string') add('member', to)
  if (ev.type === 'roles') {
    const ids = (ev.content as RolesContent | null | undefined)?.ids
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') add('role', id)
  }
  if ((ev.type === 'role' || ev.type === 'code' || ev.type === 'channel') && ev.skey)
    add(ev.type, ev.skey)
  // An invite signed for someone who redeemed a code: that code.
  const code = ev.type === 'member' ? (ev.content as { code?: unknown } | null)?.code : null
  if (typeof code === 'string') add('code', code)
  const ch = ev.type === 'msg' ? (ev.content as { ch?: unknown } | null | undefined)?.ch : null
  if (typeof ch === 'string') add('channel', ch)
  return keys
}

// The state an event's `auth` events form, or a refusal when they aren't a valid citation: state
// events of the room, of citable types, each (type, state key) once, the create event always, the
// sender's member event unless it is the creator's first join, and every role a cited roles event
// names (so a citation can't leave out the roles that rank someone). Whether the citation is
// complete and accepted is checked again where the event sits in the state DAG (resolve.ts).
export const authStateOf = (
  ev: Candidate,
  authEvents: StateEvent[]
): { ok: true; state: Map<string, StateEvent> } | { ok: false; why: string } => {
  if (ev.type === 'create')
    return authEvents.length ? { ok: false, why: 'create cites' } : { ok: true, state: new Map() }
  if (authEvents.length > STATE_LIMITS.auth || authEvents.length !== ev.auth.length)
    return { ok: false, why: 'auth count' }
  const state = new Map<string, StateEvent>()
  for (const e of authEvents) {
    // A state type from a newer version: ignored here (its rules are that version's business),
    // never refused, or newer peers would be struck for citing it.
    if (!CITABLE.has(e.type)) {
      if (isStateType(e.type)) return { ok: false, why: 'auth type' }
      continue
    }
    const key = stateKey(e.type, e.skey)
    if (state.has(key)) return { ok: false, why: 'auth twice' }
    state.set(key, e)
  }
  const create = state.get(stateKey('create', ''))
  if (!create) return { ok: false, why: 'auth create' }
  const creatorFirst =
    ev.type === 'member' &&
    ev.skey === ev.sender &&
    ev.sender === (create.content as unknown as CreateContent).creator
  if (!state.has(stateKey('member', ev.sender)) && !creatorFirst)
    return { ok: false, why: 'auth member' }
  for (const e of state.values())
    if (e.type === 'roles')
      for (const id of roleIdsOf(state, e.skey))
        if (!state.has(stateKey('role', id))) return { ok: false, why: 'auth roles' }
  return { ok: true, state }
}

// Whether `auth` cites every key `authKeys` asks for in `s` with an accepted event (`bad` holds
// the rejected ones). Stale citations are fine: the rules run against `s` itself.
export const citesAll = (
  s: StateMap,
  ev: Candidate,
  byId: (id: string) => StateEvent | undefined,
  bad: (id: string) => boolean
) => {
  const cited = new Set<string>()
  for (const id of ev.auth) {
    const e = byId(id)
    if (e && !bad(id)) cited.add(stateKey(e.type, e.skey))
  }
  return authKeys(s, ev).every(k => cited.has(k))
}

// What a new event of `sender` cites from the current state: everything `authKeys` asks for,
// and the code used for a membership event when there is room.
export const authRefs = (
  s: StateMap,
  ev: {
    type: string
    sender: string
    skey?: string
    content?: Record<string, unknown> | null
    code?: string
  }
): string[] => {
  const keys = authKeys(s, ev)
  const used = ev.code ? stateKey('code', ev.code) : null
  if (ev.type === 'member' && used && s.has(used) && !keys.includes(used)) keys.push(used)
  return keys.slice(0, STATE_LIMITS.auth).map(k => (s.get(k) as StateEvent).id)
}

// Rules that need the target event, with the state the actor is checked in. A redaction of
// someone else's message needs Manage messages and a higher rank (the owner may remove anything).
export const targetOk = (
  ev: { type: string; sender: string },
  target: { type: string; sender: string; skey?: string; fwd: boolean } | undefined,
  s: StateMap
): boolean => {
  if (!target) return true
  switch (ev.type) {
    case 'edit':
      return target.type === 'msg' && target.sender === ev.sender && !target.fwd
    case 'redact':
      if (target.skey !== undefined || target.type === 'create') return false
      return target.sender === ev.sender || mayModerate(s, ev.sender, target.sender)
    case 'react':
    case 'pin':
      return target.type === 'msg'
    default:
      return true
  }
}

// Whether `actor` may remove `author`'s messages.
export const mayModerate = (s: StateMap, actor: string, author: string) =>
  isOwner(s, actor) || (can(s, actor, P.ManageMessages) && rankOf(s, author) < rankOf(s, actor))
