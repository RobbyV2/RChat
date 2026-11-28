import { timeoutWrite, type EvalResult } from './facts'
import type { Ix } from './reach'
import { roomMode } from '../../profile_fields'
import type { ResetFact } from '../../profile_reset'
import type { CategoryStyle, ProfilesMode, SeparatorStyle } from '../../types'
import { CATEGORY_STYLES, SEPARATOR_STYLES } from '../../categories'
import {
  banEnd,
  banReason,
  banTerms,
  cmp,
  EVERYONE,
  gt,
  permsQ,
  poster,
  rank,
  evalLimits,
  timeoutEnd,
  timeoutReason,
  type AclContent,
  type Rank,
} from './rules'

// The page's summary of one P2P server's current state: its types, its codec (stored form, diff,
// apply) and its builder. The page loads this without the evaluator; the evaluator's room
// (acl_room.ts) is a SummarySource.

// The shape of the page's summary: a cached one of another shape is not used.
export const SUM_SHAPE = 9

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
  // The time and id of the live join (or genesis) that started a member's membership.
  joinTs?: number
  joinId?: string
  // The resets of their room profile that count: what they hide, and the lock.
  reset?: ResetFact
  // The account binding a member posted last: its profile's, else its join's (badge.ts).
  binding?: string
  // Who let a member in: the author of the invite its live join used (for one out with no removal
  // of its own, its latest join), and the issuer of the code that invite named (removals that
  // reach invitees).
  via?: string
  code?: string
  // The code that invite named (its id) and the label the code was made with.
  codeId?: string
  codeLabel?: string
  // The highest rank among the effective bans of a banned member (unban needs at least it).
  banRank?: Rank
  // A ban that ends by itself: when the last of the standing bans ends (ms) and who made that
  // ban. Absent while any standing ban has no end.
  banUntil?: number
  banBy?: string
  // The reason the standing bans give (`banReason`).
  banReason?: string
  // A member timed out: when it ends (ms), who made it and the reason given.
  timeoutUntil?: number
  timeoutBy?: string
  timeoutReason?: string
  // An invitee whose invites are all a non-owner's that no third member acknowledged yet: its
  // join waits (W3(e)).
  waits?: true
}

export interface RoleSum {
  pos: number
  bits: number
  name?: string
  color?: number
  // How it shows (display only): its icon (an emoji, '' for none), whether its members show
  // as a group of their own, whether it colors their names, and its display position (null
  // follows its position).
  icon?: string
  hoist?: boolean
  tint?: boolean
  dpos?: number | null
  // The fields of its latest `role_meta` this version doesn't know, kept by the next write.
  extra?: Record<string, unknown>
}

// The fields of a role's look, each read where it has the right type.
export const ROLE_LOOKS = ['icon', 'hoist', 'tint', 'dpos'] as const
const ROLE_META = new Set<string>(['role', 'name', 'color', ...ROLE_LOOKS])
const ICON_MAX = 64

const lookOk: Record<(typeof ROLE_LOOKS)[number], (x: unknown) => boolean> = {
  icon: x => typeof x === 'string' && x.length <= ICON_MAX,
  hoist: x => typeof x === 'boolean',
  tint: x => typeof x === 'boolean',
  dpos: x => x === null || Number.isSafeInteger(x),
}

// A channel overwrite (`chperm`) that allows or denies something.
export interface OverSum {
  allow: number
  deny: number
}

// A category: its name, place and header style, and the fields of its latest write this
// version doesn't know (a style it doesn't know among them), kept by the next write.
export interface CategorySum {
  name: string
  pos: number
  style?: CategoryStyle
  extra?: Record<string, unknown>
}

// A separator of the channel list: its label, how its line is drawn, its category (null for
// none) and place among the channels (`pos`, the same order as theirs), with the fields of its
// latest write this version doesn't know.
export interface SeparatorSum {
  label: string
  style?: SeparatorStyle
  cat: string | null
  pos: number
  extra?: Record<string, unknown>
}

// The category of a channel (`cat`, null for none) and whether its overwrites copy the
// category's (`sync`), with the fields of its latest write this version doesn't know.
export interface ChcatSum {
  cat: string | null
  sync: boolean
  extra?: Record<string, unknown>
}

export interface CodeSum {
  a: string
  h: string
  label?: string
  exp?: number
}

export interface Summary {
  // null: no genesis held yet; unrecognized versions are read-only.
  rules: number | null
  owners: string[]
  creator: string | null
  members: Record<string, MemberSum>
  roles: Record<string, RoleSum>
  everyone: number
  channels: Record<string, AclContent>
  // Overwrites by channel, then subject (`r:<role>`, `u:<ik>`).
  overwrites: Record<string, Record<string, OverSum>>
  categories: Record<string, CategorySum>
  chcats: Record<string, ChcatSum>
  separators: Record<string, SeparatorSum>
  settings: AclContent | null
  // What members may set in their room profile; null (no write counts) reads as everything.
  profiles: ProfilesMode | null
  // The server's description and icon, as written (read with `p2pAbout`).
  about: AclContent | null
  // The `store` register: whether devices store the room's events sealed. Null: never set.
  store: AclContent | null
  // Who sees the member list, as written (read with `parseP2pMemberList`).
  memberList: AclContent | null
  codes: Record<string, CodeSum>
  upgraded: boolean
  // Admitted upgrades, and devices with a fork point (evidence against them).
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

type Keyed =
  'members' | 'roles' | 'channels' | 'overwrites' | 'categories' | 'chcats' | 'separators' | 'codes'
const KEYED: readonly Keyed[] = [
  'members',
  'roles',
  'channels',
  'overwrites',
  'categories',
  'chcats',
  'separators',
  'codes',
]

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
  categories: dict(),
  chcats: dict(),
  separators: dict(),
  settings: null,
  profiles: null,
  about: null,
  store: null,
  memberList: null,
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
const mapNumbers = <T>(x: T, to: (n: number) => number | null): T => {
  if (typeof x === 'number') return to(x) as T
  if (Array.isArray(x)) return x.map(item => mapNumbers(item, to)) as T
  if (typeof x !== 'object' || x === null) return x
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(x))
    if (field !== undefined) out[key] = mapNumbers(field, to)
  return out as T
}
export const toStored = <T>(x: T): T =>
  mapNumbers(x, n => (n === Infinity ? BIG : n === -Infinity ? -BIG : Number.isNaN(n) ? null : n))
export const fromStored = <T>(x: T): T =>
  mapNumbers(x, n => (n === BIG ? Infinity : n === -BIG ? -Infinity : n))

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

// The roles: position, bits, and the name, color and looks of their latest `role_meta`, else
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
    for (const k of ROLE_LOOKS) {
      const v = m && lookOk[k](m[k]) ? m[k] : c && lookOk[k](c[k]) ? c[k] : undefined
      if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v
    }
    const extra = m ? Object.entries(m).filter(([k]) => !ROLE_META.has(k)) : []
    if (extra.length) r.extra = Object.fromEntries(extra)
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

const extraOf = (c: AclContent, known: ReadonlySet<string>) => {
  const extra = Object.entries(c).filter(([k]) => !known.has(k))
  return extra.length ? Object.fromEntries(extra) : undefined
}
const CATEGORY_FIELDS = new Set(['id', 'name', 'pos', 'gone'])
const CHCAT_FIELDS = new Set(['ch', 'cat', 'sync'])
const CHSEP_FIELDS = new Set(['id', 'label', 'cat', 'pos', 'gone'])
// A style this version knows, else undefined (and the written value stays an unknown field).
const styleIn = <S extends string>(styles: readonly S[], x: unknown): S | undefined =>
  styles.find(s => s === x)
const shortIdOr = (x: unknown) => (typeof x === 'string' && x !== '' && x.length <= 64 ? x : null)

// The live categories (not gone), the CATEGORIES_MAX lowest by place then id.
export const CATEGORIES_MAX = 50
export const categoriesOf = (F: EvalResult['facts']) => {
  const live = [...F.categories]
    .filter(([, c]) => c.gone !== true && typeof c.name === 'string')
    .map(([id, c]): [string, CategorySum] => {
      const sum: CategorySum = { name: c.name as string, pos: c.pos as number }
      const style = styleIn(CATEGORY_STYLES, c.style)
      if (style) sum.style = style
      const extra = extraOf(c, style ? new Set([...CATEGORY_FIELDS, 'style']) : CATEGORY_FIELDS)
      if (extra) sum.extra = extra
      return [id, sum]
    })
    .sort(([a, x], [b, y]) => x.pos - y.pos || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CATEGORIES_MAX)
  const out = dict<CategorySum>()
  for (const [id, c] of live) out[id] = c
  return out
}

// The live separators (not gone), the SEPARATORS_MAX lowest by place then id. A category that
// isn't a short id reads as none.
export const SEPARATORS_MAX = 50
export const separatorsOf = (F: EvalResult['facts']) => {
  const live = [...F.chseps]
    .filter(([, c]) => c.gone !== true && typeof c.label === 'string')
    .map(([id, c]): [string, SeparatorSum] => {
      const sum: SeparatorSum = {
        label: c.label as string,
        cat: shortIdOr(c.cat),
        pos: c.pos as number,
      }
      const style = styleIn(SEPARATOR_STYLES, c.style)
      if (style) sum.style = style
      const extra = extraOf(c, style ? new Set([...CHSEP_FIELDS, 'style']) : CHSEP_FIELDS)
      if (extra) sum.extra = extra
      return [id, sum]
    })
    .sort(([a, x], [b, y]) => x.pos - y.pos || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, SEPARATORS_MAX)
  const out = dict<SeparatorSum>()
  for (const [id, c] of live) out[id] = c
  return out
}

// The category of each channel that has a `chcat`.
export const chcatsOf = (F: EvalResult['facts']) => {
  const out = dict<ChcatSum>()
  for (const [ch, c] of F.chcats) {
    const sum: ChcatSum = { cat: (c.cat as string | null) ?? null, sync: c.sync === true }
    const extra = extraOf(c, CHCAT_FIELDS)
    if (extra) sum.extra = extra
    out[ch] = sum
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
    // A reset counts by its author's standing: whoever they reset is worked out with them.
    for (const a of [...touched]) for (const T of ix.profileResetBy.get(a) ?? []) touched.add(T)
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
  const categories = categoriesOf(F)
  const chcats = chcatsOf(F)
  const separators = separatorsOf(F)
  const gone = src.gone
  return {
    summary: {
      rules: ix.ev[ix.genesis].c.rules ?? null,
      owners: [...F.owners],
      creator: ix.ev[ix.genesis].a,
      members,
      roles,
      everyone: F.bits.get(EVERYONE) ?? 0,
      channels,
      overwrites,
      categories,
      chcats,
      separators,
      settings: F.setting ?? null,
      profiles: roomMode(F.profileMode) ?? null,
      about: F.about ?? null,
      store: F.store ?? null,
      memberList: F.memberList ?? null,
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
    const rules = ix.ev[ix.genesis]?.c.rules
    const unbans = ix.unbanEv.get(ik) ?? []
    const standing = (ix.banEv.get(ik) ?? []).filter(
      b =>
        fe.inS(b) &&
        fe.isEffI(b) &&
        !unbans.some(
          u => fe.inS(u) && !fe.isVoidI(u) && ix.before(b, u) && cmp(ix.k(u), ix.k(b)) >= 0
        )
    )
    const terms = standing.map(b => ({
      by: ix.ev[b].a,
      ts: ix.ev[b].ts,
      ...banTerms(rules, ix.ev[b]),
    }))
    const end = banEnd(terms)
    if (end) {
      sum.banUntil = end.until
      sum.banBy = end.by
    }
    const reason = banReason(terms)
    if (reason !== null) sum.banReason = reason
  }
  if (m === 'join') {
    let j = -1
    for (const g of ix.memEv.get(ik) ?? []) if (fe.inS(g) && !fe.isVoidI(g) && g > j) j = g
    if (j >= 0) {
      sum.joinTs = ix.ev[j].ts
      sum.joinId = ix.ids[j]
    }
    if (j >= 0 && ix.ev[j].t === 'join') letIn(src, sum, ik, j)
    const reset = F.profileReset.get(ik)
    if (reset) sum.reset = reset
    const b = sum.profile?.binding ?? (j >= 0 ? ix.ev[j].c.binding : undefined)
    if (typeof b === 'string') sum.binding = b
    const t = timeoutWrite(
      ix,
      ik,
      x => fe.inS(x) && !fe.isVoidI(x),
      x => fe.inS(x) && fe.isEffI(x)
    )
    if (t !== undefined) {
      sum.timeoutUntil = timeoutEnd(ix.ev[t])
      sum.timeoutBy = ix.ev[t].a
      const reason = timeoutReason(ix.ev[t].c)
      if (reason !== null) sum.timeoutReason = reason
    }
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
  const id = ix.ev[inv.add].c.code
  if (typeof id === 'string') sum.codeId = id
  if (inv.code === undefined) return
  sum.code = ix.ev[inv.code].a
  const label = ix.ev[inv.code].c.label
  if (typeof label === 'string') sum.codeLabel = label
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
  const walk = evalLimits(ix.cx).acl.vouchWalk
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
