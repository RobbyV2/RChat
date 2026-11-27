import {
  BOT,
  EVERYONE,
  NEG,
  TOP,
  type AclContent,
  type AclEv,
  type AuthCtx,
  type Rank,
} from '../../p2p/acl/rules'
import type { FactsQ } from '../../p2p/acl/facts'

// A recorded authority decision is one line:
// "type member owner held me a b list flags n out". `held` is the author's wire mask, `me` the
// author's rank, `a` the rank of the role the event names, `b` the rank of its target (for a
// role_move, the rank the role moves to), `list` the ranks an unban reads. A rank is "T" (an
// owner), "N" (not a member), "-" (none) or "position/tie".
export const TO_OWNER = 1
export const ROLE_EXISTS = 2
export const SELF = 4
export const WIPE = 8
export const ON = 16
export const ROLE_SUBJECT = 32
export const MEMBER_SUBJECT = 64

const rank = (s: string): Rank => {
  if (s === 'T') return TOP
  if (s === 'N') return NEG
  if (s === '-') return BOT
  const cut = s.indexOf('/')
  return [Number(s.slice(0, cut)), s.slice(cut + 1)]
}

export interface AuthCase {
  e: AclEv
  x: AuthCtx
  want: boolean
}

export function authCase(line: string): AuthCase {
  const [t, mem, owner, held, me, a, b, list, flags, n, out] = line.split(' ')
  const f = Number(flags)
  const author = 'p'
  const to = (f & SELF) !== 0 ? author : 'q'
  const ra = rank(a)
  const rb = rank(b)
  const role = t === 'role_move' ? rb[1] : 'r'
  const owners = new Set<string>()
  if (owner === '1') owners.add(author)
  if ((f & TO_OWNER) !== 0) owners.add(to)
  const F = {
    mem: new Set(mem === '1' ? [author] : []),
    owners,
    bits: new Map([[EVERYONE, Number(held)]]),
    holds: new Map<string, Set<string>>(),
    roles: new Set((f & ROLE_EXISTS) !== 0 ? [role] : []),
    effBanK: new Map([[to, list === '-' ? [] : list.split(',').map(rank)]]),
  } as unknown as FactsQ
  const c = {
    to,
    role,
    pos: t === 'role_create' ? ra[0] : rb[0],
    bits: Number(n),
    bit: Number(n),
    on: (f & ON) !== 0,
    wipe: (f & WIPE) !== 0 ? true : undefined,
    subj: (f & ROLE_SUBJECT) !== 0 ? 'r:x' : (f & MEMBER_SUBJECT) !== 0 ? 'u:x' : 'x',
  } as unknown as AclContent
  const e = { id: t === 'role_create' ? ra[1] : 'e', t, a: author, dev: 'd', c } as unknown as AclEv
  return {
    e,
    x: { Fr: F, Fo: F, me: rank(me), rankOf: () => ra, rankT: () => rb },
    want: out === '1',
  }
}

export interface AuthWorlds {
  t: string
  held: number[]
  a: boolean
  b: boolean
  lists: boolean
  flags: number[]
  n: number[]
  out: string
}

// The lines of a small-world table (without their outputs), in the order of its `out` string.
export function* worldLines(w: AuthWorlds, ranks: string[], lists: string[]): Generator<string> {
  const none = ['-']
  for (const mem of [0, 1])
    for (const owner of [0, 1])
      for (const held of w.held)
        for (const me of ranks)
          for (const a of w.a ? ranks : none)
            for (const b of w.b ? ranks : none)
              for (const list of w.lists ? lists : none)
                for (const flags of w.flags)
                  for (const n of w.n)
                    yield [w.t, mem, owner, held, me, a, b, list, flags, n].join(' ')
}
