import { LOCAL } from '../limits'
import type { EvalResult } from './facts'
import type { Ix } from './reach'
import {
  EVERYONE,
  gt,
  permsQ,
  poster,
  rank,
  RULES_VERSION,
  type AclContent,
  type Rank,
} from './rules'

// The page's summary of one P2P server's current state: its types, its codec (stored form, diff,
// apply) and its builder. The page loads this without the evaluator; the evaluator's room
// (acl_room.ts) is a SummarySource.

// The shape of the page's summary: a cached one of another shape is not used.
export const SUM_SHAPE = 4

export type Membership = 'invite' | 'join' | 'leave' | 'ban'

export interface MemberSum {
  m: Membership
  rank: Rank
  perms: number
  roles: string[]
  devs: string[]
  profile: AclContent | null
  // The effective removal of someone who is out (kick, ban, leave), who made it, its type and
  // time.
  rem?: string
  by?: string
  remT?: string
  remTs?: number
  // Pending invites (add event ids), and who made them.
  adds?: string[]
  inviters?: string[]
  // The time of the live join (or genesis) that started a member's membership.
  joinTs?: number
  // The account binding a member posted last: its profile's, else its join's (badge.ts).
  binding?: string
  // Who let a member in: the author of the invite its live join used (for one out with no removal
  // of its own, its latest join), and the issuer of the code that invite named (removals that
  // reach invitees, spec 8.2).
  via?: string
  code?: string
  // The highest rank among the effective bans of a banned member (unban needs at least it).
  banRank?: Rank
  // An invitee whose invites are all a non-owner's that no third member acknowledged yet: its
  // join waits (spec 4.1 W3(e), 9 rule 14).
  waits?: true
}

export interface RoleSum {
  pos: number
  bits: number
  name?: string
  color?: number
}

// A channel overwrite (spec 1.4 `chperm`) that allows or denies something.
export interface OverSum {
  allow: number
  deny: number
}

export interface CodeSum {
  a: string
  h: string
  label?: string
  exp?: number
}

export interface Summary {
  // null: no genesis held yet; another number than RULES_VERSION: unknown rules (read-only).
  rules: number | null
  owners: string[]
  creator: string | null
  members: Record<string, MemberSum>
  roles: Record<string, RoleSum>
  everyone: number
  channels: Record<string, AclContent>
  // Overwrites by channel, then subject (`r:<role>`, `u:<ik>`).
  overwrites: Record<string, Record<string, OverSum>>
  settings: AclContent | null
  codes: Record<string, CodeSum>
  upgraded: boolean
  // Admitted upgrades (spec 3.8), and devices with a fork point (evidence against them).
  upgrades: string[]
  forks: string[]
  heads: string[]
  count: number
  // ACL events an owner posted (a new copy's members acknowledge its carry-over by them).
  ownerCount: number
}

// Records keyed by ids and strings members pick (channel ids, overwrite subjects, ban targets):
// without a prototype, so a key like `__proto__` is only a key.
export const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

type Keyed = 'members' | 'roles' | 'channels' | 'overwrites' | 'codes'
const KEYED: readonly Keyed[] = ['members', 'roles', 'channels', 'overwrites', 'codes']

export interface SumDelta {
  top?: Partial<Omit<Summary, Keyed>>
  put?: Partial<{ [K in Keyed]: Summary[K] }>
  del?: Partial<Record<Keyed, string[]>>
}

export const emptySummary = (): Summary => ({
  rules: null,
  owners: [],
  creator: null,
  members: dict(),
  roles: dict(),
  everyone: 0,
  channels: dict(),
  overwrites: dict(),
  settings: null,
  codes: dict(),
  upgraded: false,
  upgrades: [],
  forks: [],
  heads: [],
  count: 0,
  ownerCount: 0,
})

// Ranks hold the infinities of owners and non-members; what is stored (and exported as JSON)
// writes them as +-2^53, which no position (a safe integer) can be.
export const BIG = 2 ** 53
export const toStored = <T>(x: T): T =>
  JSON.parse(
    JSON.stringify(x, (_k, v: unknown) => (v === Infinity ? BIG : v === -Infinity ? -BIG : v))
  ) as T
export const fromStored = <T>(x: T): T =>
  JSON.parse(JSON.stringify(x), (_k, v: unknown) =>
    v === BIG ? Infinity : v === -BIG ? -Infinity : v
  ) as T

// Whether two summaries hold the same state, whatever the order of their keys and of the lists
// that are sets (a member's roles and devices; a cache and a fresh replica list them apart).
const SETS = new Set(['roles', 'devs', 'adds', 'inviters', 'upgrades', 'forks', 'heads'])
const norm = (x: unknown, k = ''): unknown => {
  if (Array.isArray(x)) {
    const out = x.map(v => norm(v))
    return SETS.has(k) ? out.map(v => JSON.stringify(v)).sort() : out
  }
  if (x === null || typeof x !== 'object') return x
  const out = dict<unknown>()
  for (const key of Object.keys(x).sort()) out[key] = norm((x as Record<string, unknown>)[key], key)
  return out
}
export const sameSummary = (a: Summary, b: Summary) =>
  JSON.stringify(norm(toStored(a))) === JSON.stringify(norm(toStored(b)))

const json = (x: unknown) =>
  JSON.stringify(x, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v
  )

export const diffSummary = (a: Summary, b: Summary): SumDelta | null => {
  const out: SumDelta = {}
  const top: Record<string, unknown> = {}
  for (const k of Object.keys(b) as (keyof Summary)[]) {
    if ((KEYED as readonly string[]).includes(k)) continue
    if (json(a[k]) !== json(b[k])) top[k] = b[k]
  }
  if (Object.keys(top).length) out.top = top as SumDelta['top']
  for (const k of KEYED) {
    const x = a[k] as Record<string, unknown>
    const y = b[k] as Record<string, unknown>
    const put = dict<unknown>()
    // an entry the kept summary shares (the same object) is unchanged
    for (const [id, v] of Object.entries(y))
      if (!Object.hasOwn(x, id) || (x[id] !== v && json(x[id]) !== json(v))) put[id] = v
    const del = Object.keys(x).filter(id => !Object.hasOwn(y, id))
    if (Object.keys(put).length) (out.put ??= {})[k] = put as never
    if (del.length) (out.del ??= {})[k] = del
  }
  return out.top || out.put || out.del ? out : null
}

export const applySummary = (s: Summary, d: SumDelta | null | undefined): Summary => {
  if (!d) return s
  const next: Summary = { ...s, ...(d.top ?? {}) }
  for (const k of KEYED) {
    const put = d.put?.[k]
    const del = d.del?.[k]
    if (!put && !del) continue
    const m = Object.assign(dict<unknown>(), s[k] as Record<string, unknown>, put ?? {})
    for (const id of del ?? []) delete m[id]
    ;(next as unknown as Record<string, unknown>)[k] = m
  }
  return next
}

// The roles: position, bits, and the name and color of their latest `role_meta` (spec 1.5), else
// of their creation.
export const rolesOf = (F: EvalResult['facts'], ix: Ix) => {
  const roles = dict<RoleSum>()
  for (const R of F.roles) {
    const c = ix.ev[ix.roleCreate.get(R)!]?.c
    const m = F.roleMeta.get(R)
    const r: RoleSum = { pos: F.pos.get(R) ?? 0, bits: F.bits.get(R) ?? 0 }
    const name = typeof m?.name === 'string' ? m.name : c?.name
    const color = typeof m?.color === 'number' ? m.color : c?.color
    if (typeof name === 'string') r.name = name
    if (typeof color === 'number') r.color = color
    roles[R] = r
  }
  return roles
}

// The overwrites that allow or deny something, by channel and subject.
export const overwritesOf = (F: EvalResult['facts']) => {
  const out = dict<Record<string, OverSum>>()
  for (const [ch, ov] of F.overwrites)
    for (const [subj, c] of ov) {
      const allow = typeof c.allow === 'number' ? c.allow : 0
      const deny = typeof c.deny === 'number' ? c.deny : 0
      if (allow || deny) (out[ch] ??= dict<OverSum>())[subj] = { allow, deny }
    }
  return out
}

// What the builder reads of a room: its index and current state, the evaluation behind it, its
// heads, and the stored events it dropped. Read once per build; nothing here changes during one.
export interface SumEval {
  inS(i: number): boolean
  isVoidI(i: number): boolean
  isEffI(i: number): boolean
  readonly X: ArrayLike<number>
}
export interface SummarySource {
  readonly ix: Ix
  readonly unknownRules: number | undefined
  readonly unknownCount: number
  readonly gone: ReadonlyMap<string, boolean>
  state(): EvalResult
  evaluation(): SumEval
  heads(ok: (i: number) => boolean): string[]
}

// What a summary keeps for the next: an identity's entry is worked out again only when an event
// whose status changed (or a new one) touches it (its author, target or revoked device's identity;
// every holder of a role it writes; everyone for @everyone's bits or the genesis), or a code it
// was invited with changed. Roles, channels, codes and the rest are small and built each time.
export interface SumMemo {
  ix: Ix
  codes: Uint8Array
  members: Record<string, MemberSum>
  usable: string
}

// The summary of `src`, from scratch, or reusing the entries of `prev` (the memo of the build
// before, of the same index) that nothing touched since. `memo` is what the next build reuses;
// none when there is nothing to summarize yet.
export function buildSummary(
  src: SummarySource,
  prev?: SumMemo
): { summary: Summary; memo?: SumMemo } {
  const ix = src.ix
  if (src.unknownRules !== undefined)
    return { summary: { ...emptySummary(), rules: src.unknownRules, count: src.unknownCount } }
  if (ix.genesis < 0) return { summary: emptySummary() }
  const S = src.state()
  const F = S.facts
  const fe = src.evaluation()
  const codes = dict<CodeSum>()
  for (const [id, cf] of F.codes) {
    const c = ix.ev[ix.codeEv.get(id)!].c
    const x: CodeSum = { a: cf.a, h: c.h }
    if (typeof c.label === 'string') x.label = c.label
    if (typeof c.exp === 'number') x.exp = c.exp
    codes[id] = x
  }
  const usable = [...F.codeOk]
    .filter(c => !F.codeDead.has(c))
    .sort()
    .join(',')
  const status = new Uint8Array(ix.n)
  for (let i = 0; i < ix.n; i++)
    status[i] =
      (fe.inS(i) ? 1 : 0) | (fe.isVoidI(i) ? 2 : 0) | (fe.isEffI(i) ? 4 : 0) | (fe.X[i] ? 8 : 0)
  const memo = prev?.ix !== ix ? undefined : prev
  let all = !memo
  const touched = new Set<string>()
  const touch = (i: number) => {
    const e = ix.ev[i]
    const c = e.c
    touched.add(e.a)
    if (typeof c.to === 'string') touched.add(c.to)
    if (typeof c.ik === 'string') touched.add(c.ik)
    const R = e.t === 'role_create' ? e.id : typeof c.role === 'string' ? c.role : undefined
    if (e.t === 'genesis' || R === EVERYONE) all = true
    else if (R !== undefined && e.t.startsWith('role_'))
      for (const T of ix.heldBy.get(R) ?? []) touched.add(T)
  }
  if (memo) {
    let any = false
    for (let i = 0; i < ix.n && !all; i++)
      if (i >= memo.codes.length || status[i] !== memo.codes[i]) {
        touch(i)
        any = true
      }
    // Any event of a third member may vouch for a pending invite, or stop doing so (W3(e)).
    if (any) for (const ik of F.pending.keys()) touched.add(ik)
    if (memo.usable !== usable)
      for (const l of ix.codeAdds.values())
        for (const g of l) if (typeof ix.ev[g].c.to === 'string') touched.add(ix.ev[g].c.to)
  }
  const members = Object.assign(dict<MemberSum>(), all ? {} : memo!.members)
  const who = all
    ? new Set<string>([
        ...ix.byAuthor.keys(),
        ...ix.addEv.keys(),
        ...ix.banEv.keys(),
        ...ix.remEv.keys(),
      ])
    : touched
  for (const ik of who) {
    delete members[ik]
    const sum = memberSum(src, ik)
    if (sum) members[ik] = sum
  }
  const roles = rolesOf(F, ix)
  const channels = dict<AclContent>()
  for (const [id, c] of F.channels) channels[id] = c
  const overwrites = overwritesOf(F)
  const gone = src.gone
  return {
    summary: {
      rules: RULES_VERSION,
      owners: [...F.owners],
      creator: ix.ev[ix.genesis].a,
      members,
      roles,
      everyone: F.bits.get(EVERYONE) ?? 0,
      channels,
      overwrites,
      settings: F.setting ?? null,
      codes,
      upgraded: F.upgraded.length > 0,
      upgrades: [...F.upgraded],
      forks: [...S.F].filter(([, f]) => f < Infinity).map(([v]) => v),
      heads: src.heads(i => !gone.has(ix.ids[i])),
      count: ix.n - gone.size,
      ownerCount: [...F.owners].reduce((n, o) => n + (ix.byAuthor.get(o)?.length ?? 0), 0),
    },
    memo: { ix, codes: status, members, usable },
  }
}

// One identity's entry of the summary (none for someone who was never let in).
function memberSum(src: SummarySource, ik: string): MemberSum | undefined {
  const ix = src.ix
  const F = src.state().facts
  const fe = src.evaluation()
  const m: Membership = F.mem.has(ik)
    ? 'join'
    : F.ban.has(ik)
      ? 'ban'
      : F.pending.has(ik)
        ? 'invite'
        : 'leave'
  if (m === 'leave' && !(ix.memEv.get(ik)?.length || ix.addEv.get(ik)?.length)) return undefined
  if (!ix.byAuthor.has(ik) && !ix.addEv.has(ik) && !ix.banEv.has(ik) && !ix.remEv.has(ik))
    return undefined
  const sum: MemberSum = {
    m,
    rank: rank(F, ik),
    perms: m === 'join' ? permsQ(F, ik) : 0,
    roles: [...(F.holds.get(ik) ?? [])],
    devs: [...(F.devs.get(ik) ?? [])],
    profile: F.profile.get(ik) ?? null,
  }
  if (m === 'leave' || m === 'ban') {
    let last = -1
    for (const d of ix.remEv.get(ik) ?? []) if (fe.isEffI(d) && d > last) last = d
    if (last >= 0) {
      sum.rem = ix.ids[last]
      sum.by = ix.ev[last].a
      sum.remT = ix.ev[last].t
      sum.remTs = ix.ev[last].ts
    }
  }
  // Out with no removal of their own: who let them in, read from their latest join (cut).
  if (m === 'leave' && !sum.rem) {
    let j = -1
    for (const g of ix.memEv.get(ik) ?? []) if (g > j && fe.inS(g) && ix.ev[g].t === 'join') j = g
    if (j >= 0) letIn(src, sum, ik, j)
  }
  if (m === 'invite') {
    sum.adds = (F.pending.get(ik) ?? []).map(p => p.id)
    sum.inviters = [...new Set((F.pending.get(ik) ?? []).map(p => p.a))]
    if (!sum.adds.some(id => vouched(src, id, ik))) sum.waits = true
  }
  if (m === 'ban') {
    let k: Rank | undefined
    for (const r of F.effBanK.get(ik) ?? []) if (!k || gt(r, k)) k = r
    if (k) sum.banRank = k
  }
  if (m === 'join') {
    let j = -1
    for (const g of ix.memEv.get(ik) ?? []) if (fe.inS(g) && !fe.isVoidI(g) && g > j) j = g
    if (j >= 0) sum.joinTs = ix.ev[j].ts
    if (j >= 0 && ix.ev[j].t === 'join') letIn(src, sum, ik, j)
    const b = sum.profile?.binding ?? (j >= 0 ? ix.ev[j].c.binding : undefined)
    if (typeof b === 'string') sum.binding = b
  }
  return sum
}

// Who let `ik` in by its join `j`: the author of the latest invite of it in j's past, and the
// issuer of the code that invite named.
function letIn(src: SummarySource, sum: MemberSum, ik: string, j: number) {
  const inv = inviteOf(src.ix, src.evaluation(), ik, j)
  if (!inv) return
  const ix = src.ix
  sum.via = poster(ix.ev[inv.add])
  if (inv.code !== undefined) sum.code = ix.ev[inv.code].a
}

// The invite join `j` of `ik` used (the latest admitted `add` of `ik` in its past), and the
// `code` event that invite names.
export function inviteOf(
  ix: Ix,
  fe: Pick<SumEval, 'inS'>,
  ik: string,
  j: number
): { add: number; code: number | undefined } | null {
  let add = -1
  for (const a of ix.addEv.get(ik) ?? []) if (a > add && fe.inS(a) && ix.has(j, a)) add = a
  if (add < 0) return null
  const code = ix.ev[add].c.code
  return { add, code: code === undefined ? undefined : ix.codeEv.get(code) }
}

// Whether the invite `add` of `to` lets a join in by W3(e): an owner's, or one that an admitted
// ACL event of a third identity has in its past (looked for among its descendants).
function vouched(src: SummarySource, add: string, to: string) {
  const ix = src.ix
  const fe = src.evaluation()
  const p = ix.at.get(add)
  if (p === undefined) return true
  const by = poster(ix.ev[p])
  if (src.state().facts.owners.has(by)) return true
  const seen = new Set<number>([p])
  const queue = [...ix.kids[p]]
  const walk = LOCAL.acl.vouchWalk
  for (let at = 0; at < queue.length && seen.size < walk; at++) {
    const q = queue[at]
    if (seen.has(q)) continue
    seen.add(q)
    const a = poster(ix.ev[q])
    if (fe.inS(q) && !fe.X[q] && a !== by && a !== to) return true
    for (const k of ix.kids[q]) if (!seen.has(k)) queue.push(k)
  }
  return seen.size >= walk
}
