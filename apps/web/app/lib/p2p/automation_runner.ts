import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { isRecord } from '../bytes'
import { BAN, gt, KICK, P, type Rank, ROLES, SEND, VIEW } from './acl/rules'
import { type AutoDoc, type Ev, type Held, topoOrder, type Want } from './automation_docs'

// Runners of a P2P server's automations: the devices of members who carry out role changes,
// kicks and bans for the docs in `automation_docs.ts`, each within its own rights and the doc
// author's.

// A member's standing at an event's place in the ACL order.
export interface Standing {
  bits: number
  rank: Rank
}

// A runner carries out an action only when the doc's author and the runner each hold every
// needed bit and each outrank the target and, for a role change, the role. Neither lends rights.
export const mayRun = (
  author: Standing,
  runner: Standing,
  needs: number,
  target: { rank: Rank },
  role?: { rank: Rank }
) => {
  const ok = (s: Standing) =>
    (needs & ~s.bits) === 0 &&
    gt(s.rank, target.rank) &&
    (role === undefined || gt(s.rank, role.rank))
  return ok(author) && ok(runner)
}

// What a role may carry and still be given by a press, an answer or an auto-role: Mention
// everyone. Channel access comes only with the Member role at admission (`mayAdmit`).
export const SELF_SERVICE_OK = P.MentionEveryone

export type GrantRefusal = 'gives_permissions' | 'owner_cant_grant'

// Checked at every grant against the role's bits at that place, never only when the doc is
// saved. `mayGive`: the doc marks the role "May give permissions".
export const selfService = (
  roleBits: number,
  mayGive: boolean,
  giverBits: number
): GrantRefusal | null => {
  if ((roleBits & ~giverBits) !== 0) return 'owner_cant_grant'
  if (!mayGive && (roleBits & ~SELF_SERVICE_OK) !== 0) return 'gives_permissions'
  return null
}

export const mayGiveRole = (
  author: Standing,
  runner: Standing,
  target: { rank: Rank },
  role: { rank: Rank; bits: number; mayGive: boolean }
) =>
  mayRun(author, runner, ROLES, target, role) &&
  selfService(role.bits, role.mayGive, author.bits & runner.bits) === null

// What the configured Member role may carry when a runner admits someone.
export const MEMBER_OK = VIEW | SEND | P.MentionEveryone

// Admission gives the Member role within both authorities, and only if the role carries channel
// access and Mention everyone and nothing else.
export const mayAdmit = (
  author: Standing,
  runner: Standing,
  target: { rank: Rank },
  member: { rank: Rank; bits: number }
) =>
  mayRun(author, runner, ROLES, target, member) &&
  (member.bits & ~MEMBER_OK) === 0 &&
  (member.bits & ~(author.bits & runner.bits)) === 0

const NEEDS = new Map<string, number>([
  ['add_role', ROLES],
  ['remove_role', ROLES],
  ['toggle_role', ROLES],
  ['kick', KICK],
  ['ban', BAN],
])

// The bits an action needs, or null for one runners never carry out.
export const needsOf = (action: string) => NEEDS.get(action) ?? null

// Who is online, as far as this device knows.
export interface Presence {
  online: readonly string[]
}

export const candidates = ({ online }: Presence, mayRunHere: (ik: string) => boolean) =>
  [...new Set(online)].filter(mayRunHere).sort()

const digest = (text: string) => bytesToHex(sha256(utf8ToBytes(text)))

// The order in which candidates act on an event: ascending SHA-256 of the event id, a line
// feed and the identity key.
export const order = (event: string, among: readonly string[]) =>
  [...new Set(among)]
    .map(ik => ({ ik, h: digest(`${event}\n${ik}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.ik < b.ik ? -1 : 1))
    .map(c => c.ik)

export const STEP_MS = 2000
export const CAP_MS = 20_000
export const delayMs = (place: number) => Math.min(place * STEP_MS, CAP_MS)

// How long `me` waits before acting, or null when it is not a candidate. It acts only if the
// effect has not shown up by then.
export const waitFor = (event: string, among: readonly string[], me: string) => {
  const place = order(event, among).indexOf(me)
  return place === -1 ? null : delayMs(place)
}

// A post, as slot collapse reads it.
export interface Post {
  id: string
  author: string
  // The place in the reader's causal order; the author's time is never used.
  pos: number
  slot?: string
  via?: string
}

export const slotKey = (automation: string, event: string) => `${automation}:${event}`

// Posts with one slot key collapse to the first in causal order, but only among posts whose
// author is a valid runner there. A post from anyone else stays a plain message and never
// hides a real one.
export const collapse = <T extends Post>(posts: T[], valid: (p: T) => boolean) => {
  const best = new Map<string, T>()
  for (const p of posts) {
    if (p.slot === undefined || !valid(p)) continue
    const b = best.get(p.slot)
    if (!b || p.pos < b.pos || (p.pos === b.pos && p.id < b.id)) best.set(p.slot, p)
  }
  const shown = posts.filter(p => p.slot === undefined || !valid(p) || best.get(p.slot) === p)
  const labelled = new Set(shown.filter(p => p.via !== undefined && valid(p)).map(p => p.id))
  return { shown, labelled }
}

export interface Change {
  add: string[]
  remove: string[]
  refused?: 'not_in_panel' | 'too_many' | 'limit' | 'binding'
}

// A role panel's mode, as the crate's `panel::Mode` is stored.
export type PanelMode =
  | { kind: 'toggle' | 'unique' | 'verify' | 'drop' | 'reversed' | 'binding' }
  | { kind: 'limit'; n: number }

const refuse = (refused: NonNullable<Change['refused']>): Change => ({
  add: [],
  remove: [],
  refused,
})

// The change that brings what a member holds to what a press wants, within what the panel's
// buttons and menus can do in its mode: a unique panel holds one role, a limited one at most
// `n`, verify only gives, drop only takes, and a binding pick is never changed. Applying it
// twice changes nothing the second time.
export const applyWant = (
  want: Want,
  held: string[],
  panel: string[],
  role: string,
  mode: PanelMode
): Change => {
  const mine = held.filter(r => panel.includes(r))
  if (Array.isArray(want)) {
    const set = [...new Set(want.filter(r => panel.includes(r)))]
    const add = set.filter(r => !held.includes(r))
    const remove = mine.filter(r => !set.includes(r))
    if (mode.kind === 'unique' && set.length > 1) return refuse('too_many')
    if (mode.kind === 'limit' && set.length > mode.n) return refuse('limit')
    if (mode.kind === 'binding' && mine.length > 0 && add.length > 0) return refuse('binding')
    if (mode.kind === 'verify' || mode.kind === 'binding') return { add, remove: [] }
    if (mode.kind === 'drop') return { add: [], remove }
    return { add, remove }
  }
  if (!panel.includes(role)) return refuse('not_in_panel')
  const has = held.includes(role)
  if (want === 'off')
    return {
      add: [],
      remove: has && mode.kind !== 'verify' && mode.kind !== 'binding' ? [role] : [],
    }
  if (has || mode.kind === 'drop') return { add: [], remove: [] }
  if (mode.kind === 'limit' && mine.length >= mode.n) return refuse('limit')
  if (mode.kind === 'binding' && mine.length > 0) return refuse('binding')
  return { add: [role], remove: mode.kind === 'unique' ? mine : [] }
}

// A press of one identity on one panel control, with when this runner got it (for the
// stability rule only).
export interface Press extends Ev {
  want: Want
  at: number
}

// The latest press in the deterministic causal order; a device's own counter is never used.
export const latestPress = (presses: Press[]): Press | null => {
  const o = topoOrder(presses)
  const last = o[o.length - 1]
  return presses.find(p => p.id === last) ?? null
}

export const reconcile = (
  presses: Press[],
  held: string[],
  panel: string[],
  role: string,
  mode: PanelMode
) => {
  const p = latestPress(presses)
  return p === null ? { add: [], remove: [] } : applyWant(p.want, held, panel, role, mode)
}

// Whether a role op caused by press `cause` makes this runner reconcile: only when it knows
// that press and a later one.
export const counters = (presses: Press[], cause: string) => {
  const o = topoOrder(presses)
  const at = o.indexOf(cause)
  return at !== -1 && at < o.length - 1
}

export const STABLE_MS = 3000

export const stable = (presses: Press[], now: number) => {
  const p = latestPress(presses)
  return p !== null && now - p.at >= STABLE_MS
}

export const OPS_PER_HOUR = 10
const HOUR_MS = 3_600_000

// At most 10 role ops an hour per member and panel.
export const opCap = () => {
  const ops = new Map<string, number[]>()
  return {
    take: (member: string, panel: string, now: number) => {
      const key = JSON.stringify([member, panel])
      const recent = (ops.get(key) ?? []).filter(t => now - t < HOUR_MS)
      const room = recent.length < OPS_PER_HOUR
      ops.set(key, room ? [...recent, now] : recent)
      return room
    },
  }
}

export const PRESS_MAX_AGE_MS = 24 * HOUR_MS

// Whether a press this runner first saw at `seen` still counts.
export const pressLive = (seen: number, now: number) => now - seen <= PRESS_MAX_AGE_MS

// Runners keep half of their ACL rate for kicks and bans: whether a panel or reaction-role op
// fits in the other half, given the ops this runner made in the rate's window.
export const roomForPanelOp = (recent: number, rate: number) => (recent + 1) * 2 <= rate

// An ACL event about a member, as far as welcome and leave messages read it. `grandfathered`:
// an assign the onboarding wizard sent for a member already there. `held`: the member held the
// role before this assign (a second runner's duplicate).
export interface MemberEvent {
  t: 'join' | 'assign' | 'leave' | 'kick' | 'ban'
  member: string
  role?: string
  grandfathered?: boolean
  held?: boolean
}

export interface LocalCtx {
  // The Member role when the server's onboarding gates by one.
  memberRole: string | null
  // The shared rules' inert template rendering, with this reader's values.
  render: (template: string) => string
}

// A row a reader shows by itself; nothing is posted.
export interface LocalRow {
  auto: string
  kind: 'welcome' | 'leave'
  name: string
  channel: string
  text: string
  savedBy: string
}

const kindOf = (e: MemberEvent, memberRole: string | null): LocalRow['kind'] | null => {
  switch (e.t) {
    case 'join':
      return memberRole === null ? 'welcome' : null
    case 'assign':
      return memberRole !== null && e.role === memberRole && !e.grandfathered && !e.held
        ? 'welcome'
        : null
    case 'leave':
    case 'kick':
    case 'ban':
      return 'leave'
  }
}

const TRIGGER = { welcome: 'member_admitted', leave: 'member_left' } as const

// Whether a `member_left` trigger's `kicked` and `banned` let this leave through: each, when set,
// must match the event.
const LEFT = { leave: [false, false], kick: [true, false], ban: [false, true] } as const
const leftMatches = (trigger: Record<string, unknown>, t: MemberEvent['t']) => {
  if (t !== 'leave' && t !== 'kick' && t !== 'ban') return true
  const [kicked, banned] = LEFT[t]
  const fits = (want: unknown, is: boolean) => want === undefined || want === null || want === is
  return fits(trigger.kicked, kicked) && fits(trigger.banned, banned)
}

// The welcome or leave rows of an ACL event, from the resolved docs whose only action is a
// message and that have no conditions.
export const localRows = (e: MemberEvent, autos: Held<AutoDoc>[], ctx: LocalCtx): LocalRow[] => {
  const kind = kindOf(e, ctx.memberRole)
  if (kind === null) return []
  return autos.flatMap(({ doc, author, channel }): LocalRow[] => {
    const { name, enabled, trigger, actions, conditions } = doc.body
    const [action] = Array.isArray(actions) ? (actions as unknown[]) : []
    if (!isRecord(trigger) || trigger.type !== TRIGGER[kind] || enabled === false) return []
    if (!leftMatches(trigger, e.t)) return []
    if (!Array.isArray(actions) || actions.length !== 1 || !isRecord(action)) return []
    if (action.type !== 'send_message' || typeof action.text !== 'string') return []
    if (Array.isArray(conditions) && conditions.length > 0) return []
    const named = isRecord(action.channel) ? action.channel.channel : undefined
    const where = typeof named === 'string' && named ? named : channel
    if (!where) return []
    try {
      const text = ctx.render(action.text)
      return [
        {
          auto: doc.id,
          kind,
          name: typeof name === 'string' && name ? name : doc.id,
          channel: where,
          text,
          savedBy: author,
        },
      ]
    } catch {
      return []
    }
  })
}
