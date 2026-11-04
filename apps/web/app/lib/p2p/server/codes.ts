import { isRecord } from '../../bytes'
import { b64u, bytesOf, randomBytes } from '../canonical'
import { blankRoom } from '../dag'
import type { CodeRecord } from '../db'
import { validate2, type WireV2 } from '../event_v2'
import { type Wire } from '../event_v1'
import type { Message } from '../frames'
import { peerId, liveCerts } from '../keys'
import { LOCAL } from '../limits'
import type { Session } from '../session'
import { can, LIMITS as STATE_LIMITS, memberOf, membershipOf, nameOf, P } from '../state'
import type { ServerCtx } from './context'
import {
  SERVER,
  NOBODY_ONLINE,
  BAD_CODE,
  REDEEM_TEXT,
  ServerError,
  encodeCode,
  parseCode,
  codeHash,
} from './types'
import { clip } from '../rate'

export async function issueCode(cx: ServerCtx, room: string, ttl: number, label = '') {
  const s = cx.sumOf(room)
  if (cx.myMembership(room) !== 'join') throw new ServerError('Join the server first')
  if (!can(s, cx.me, P.Invite)) throw new ServerError("You can't invite people here")
  const now = cx.clock.now()
  // At the cap of live codes, our own expired ones are revoked to make room.
  if (!can(s, cx.me, P.ManageServer)) {
    const mine = Object.entries(s.codes).filter(([, c]) => c.a === cx.me)
    const old = mine
      .filter(([, c]) => (c.exp ?? Infinity) <= now)
      .slice(0, Math.max(0, mine.length - STATE_LIMITS.codesPerMember + 1))
    for (const [id] of old) await cx.emit(room, 'code_revoke', () => ({ code: id }))
    if (mine.length - old.length >= STATE_LIMITS.codesPerMember)
      throw new ServerError('Revoke one of your invites first')
  }
  const secret = b64u(randomBytes(16))
  const hash = codeHash(secret)
  const exp = now + ttl
  const clean = label.trim().slice(0, STATE_LIMITS.label)
  await cx.emit(room, 'code', () => ({ h: hash, exp, ...(clean ? { label: clean } : {}) }))
  const rec: CodeRecord = { hash, room, secret, exp, label: clean, created: now }
  await cx.db.put('codes', rec)
  return cx.codeText(room, secret)
}

// The code string: the room, its name, the secret, and the peer ids of up to 4 members who
// can let people in (us first). No identities, addresses or anything else.
export function codeText(cx: ServerCtx, room: string, secret: string) {
  const s = cx.sumOf(room)
  const peers = [cx.deps.node.peerId]
  for (const ik of cx.joinedOthers(room)) {
    if (peers.length >= SERVER.codePeers) break
    if (!can(s, ik, P.Invite)) continue
    const d = cx.deps.node.anyDevicesOf(ik)
    const cert = d ? liveCerts(d.certs, d.revocations)[0] : undefined
    if (cert) peers.push(peerId(cert.dk))
  }
  const id = cx.codeByHash(room, codeHash(secret))?.id
  return encodeCode({
    v: 1,
    room,
    name: nameOf(s)?.name ?? 'P2P server',
    ...(id ? { code: id } : {}),
    secret,
    peers,
  })
}

// The live code with this hash (codes are named by their event id, spec 1.4).
export function codeByHash(cx: ServerCtx, room: string, hash: string) {
  for (const [id, c] of Object.entries(cx.sumOf(room).codes)) if (c.h === hash) return { id, ...c }
  return null
}

// Revokes a code once synced (moderate), refusing it here meanwhile; null if cancelled.
export async function revokeCodeSynced(cx: ServerCtx, room: string, hash: string) {
  const key = `${room}\n${hash}`
  cx.holding.add(key)
  try {
    return await cx.moderate(room, { act: 'Revoke an invite code' }, () =>
      cx.revokeCode(room, hash)
    )
  } finally {
    cx.holding.delete(key)
  }
}

export async function revokeCode(cx: ServerCtx, room: string, hash: string) {
  const cur = cx.codeByHash(room, hash)
  if (!cur) throw new ServerError('Unknown invite')
  await cx.emit(room, 'code_revoke', () => ({ code: cur.id }))
}

// Live codes of a room, with the code string for those we issued here.
export async function codes(cx: ServerCtx, room: string) {
  const s = cx.sumOf(room)
  const mine = new Map((await cx.db.getAllFromIndex('codes', 'room', room)).map(c => [c.hash, c]))
  const paused = cx.pausedCodes(room)
  const out: {
    hash: string
    exp: number
    revoked: boolean
    label: string
    by: string
    text: string | null
    paused?: true
  }[] = []
  for (const c of Object.values(s.codes)) {
    const rec = mine.get(c.h)
    mine.delete(c.h)
    out.push({
      hash: c.h,
      exp: c.exp ?? rec?.exp ?? 0,
      revoked: false,
      label: c.label ?? rec?.label ?? '',
      by: c.a,
      text: rec ? cx.codeText(room, rec.secret) : null,
      ...(paused.has(c.h) ? { paused: true as const } : {}),
    })
  }
  // Ours that are no longer live: revoked, or dead with our right to invite.
  for (const rec of mine.values())
    out.push({
      hash: rec.hash,
      exp: rec.exp,
      revoked: true,
      label: rec.label,
      by: cx.me,
      text: null,
    })
  return out.sort((a, b) => b.exp - a.exp)
}

// Joins with a code: dials the members it names until one lets us in.
export async function redeem(cx: ServerCtx, text: string): Promise<string> {
  const code = parseCode(text)
  if (!code) throw new ServerError(BAD_CODE)
  if (cx.myMembership(code.room) === 'join') return code.room
  if (!cx.rooms.has(code.room) && (await cx.isDmId(code.room))) throw new ServerError(BAD_CODE)
  const now = cx.clock.now()
  const had = cx.rooms.get(code.room)
  if (!had)
    await cx.putRoom({
      ...blankRoom(code.room, '', now),
      kind: 'server',
      name: code.name,
      chans: {},
      server: null,
      joining: { at: now, via: 'code' },
      since: now,
    })
  else await cx.updateRoom(code.room, cur => ({ ...cur, joining: { at: now, via: 'code' } }))
  cx.ensureRt(code.room).joinPosted = false
  let why: string | null = null
  for (const peer of code.peers) {
    const s = await cx.deps.node.dialPeer(peer, { rci: code.room })
    if (!s || !s.remote) continue
    const reply = await cx.request(s, {
      t: 'gredeem',
      room: code.room,
      ...(code.code ? { code: code.code } : {}),
      secret: code.secret,
      profile: cx.deps.node.profile,
    })
    if (reply?.ok === true) {
      cx.prefer(code.room, s.remote.ik)
      // The invite they posted for us: it enters the room once we hold what it sits on.
      if (isRecord(reply.ev)) {
        const ev = reply.ev as unknown as WireV2
        await cx.updateRoom(code.room, cur => ({
          ...cur,
          joining: { at: cur.joining?.at ?? now, via: 'code', ev },
        }))
        void cx.locked(code.room, () => cx.takeInvite(code.room)).catch(() => {})
      }
      cx.changed(code.room)
      return code.room
    }
    const w = typeof reply?.why === 'string' ? reply.why : null
    if (w && w in REDEEM_TEXT) {
      // Busy or unknown at one member: another may let us in.
      if (w !== 'unknown' || !why) why = w
      if (w !== 'unknown' && w !== 'busy') break
    }
  }
  if (!had) await cx.forgetEmpty(code.room)
  else await cx.updateRoom(code.room, cur => ({ ...cur, joining: null }))
  throw new ServerError(why ? REDEEM_TEXT[why] : NOBODY_ONLINE)
}

export async function forgetEmpty(cx: ServerCtx, room: string) {
  if (await cx.dropEmpty(room)) cx.changed(room)
}

export function request(
  cx: ServerCtx,
  s: Session,
  msg: Message,
  ms = SERVER.redeemMs
): Promise<Message | null> {
  return new Promise(resolve => {
    const key = `${s.peer}\n${msg.room as string}`
    const timer = cx.clock.set(() => {
      cx.waiters.delete(key)
      resolve(null)
    }, ms)
    cx.waiters.set(key, m => {
      cx.clock.clear(timer)
      cx.waiters.delete(key)
      resolve(m)
    })
    s.onClose(() => cx.waiters.get(key)?.({ t: 'gredeemed', ok: false }))
    void s.send(msg).catch(() => resolve(null))
  })
}

export function onRedeemed(cx: ServerCtx, m: Message, s: Session) {
  if (typeof m.room !== 'string') return s.strike()
  cx.waiters.get(`${s.peer}\n${m.room}`)?.(m)
}

// The invite an admitting member posted for us: through the pending store, so it is decided
// once we hold its ACL parents; our join follows (afterState).
export async function takeInvite(cx: ServerCtx, room: string) {
  const r = cx.rooms.get(room)
  const wire = r?.joining?.ev
  if (!wire) return
  const m = cx.myMembership(room)
  if (m !== 'invite' && m !== 'join') {
    const v = await cx.check(room, wire)
    // Before the genesis is here it can't be judged: kept until a stored event retries it.
    if (!v.ok && v.later) return
    if (v.ok) await cx.take(room, v.id, wire, cx.clock.now())
  }
  await cx.updateRoom(room, cur =>
    cur.joining?.ev ? { ...cur, joining: { at: cur.joining.at, via: cur.joining.via } } : null
  )
}

// Someone redeems a code with us: we check it by our own clock and, if it holds, post an
// invite for them that names the code (spec 8.1), send it to them and let them sync the ACL for
// a while. The invite is withdrawn if they don't join by then (lapseRedeems).
export async function onRedeem(cx: ServerCtx, m: Message, s: Session) {
  const r = s.remote
  const room = m.room
  if (!r || typeof room !== 'string' || bytesOf(m.secret, 16) === null) return s.strike()
  const n = (cx.redeems.get(s) ?? 0) + 1
  cx.redeems.set(s, n)
  if (n > SERVER.redeems) return s.strike()
  const answer = (ok: boolean, why?: string, ev?: Wire) =>
    void s
      .send({ t: 'gredeemed', room, ok, ...(why ? { why } : {}), ...(ev ? { ev } : {}) })
      .catch(() => {})
  const st = cx.sumOf(room)
  if (cx.myMembership(room) !== 'join' || !can(st, cx.me, P.Invite) || cx.frozen(room))
    return answer(false, 'unknown')
  const hash = codeHash(m.secret as string)
  if (cx.holding.has(`${room}\n${hash}`)) return answer(false, 'revoked')
  // The code the link names (its id), else the live code with this secret's hash.
  const named = typeof m.code === 'string' ? st.codes[m.code] : undefined
  const code =
    typeof m.code === 'string'
      ? named?.h === hash
        ? { id: m.code, ...named }
        : null
      : cx.codeByHash(room, hash)
  if (named && named.h !== hash) return answer(false, 'unknown')
  if (!code) {
    const rec = await cx.db.get('codes', hash)
    return answer(false, rec && rec.room === room ? 'revoked' : 'unknown')
  }
  const now = cx.clock.now()
  if ((code.exp ?? Infinity) <= now) return answer(false, 'expired')
  const cur = membershipOf(st, r.ik)
  if (cur === 'ban') return answer(false, 'banned')
  if (cur === 'join') {
    cx.prefer(room, r.ik)
    return answer(true)
  }
  const map = cx.redeemersOf(room)
  if (!map.has(r.ik)) {
    const perCode = [...map.values()].filter(x => x.code === code.id).length
    if (perCode >= SERVER.redeemsPerCode || map.size >= SERVER.redeemsPerRoom)
      return answer(false, 'busy')
  }
  let add = memberOf(st, r.ik)?.adds?.[0]
  let at: number | undefined
  if (cur !== 'invite') {
    if (!cx.codeOpen(room, code.id, now)) return answer(false, 'busy')
    // The slot is taken before signing, so redeems at the same moment can't pass it.
    const use = cx.codeUseOf(room, code.id)
    use.adds.push(now)
    try {
      add = await cx.emit(room, 'add', () => ({ to: r.ik, code: code.id }))
    } catch {
      const i = use.adds.lastIndexOf(now)
      if (i >= 0) use.adds.splice(i, 1)
      return answer(false, 'unknown')
    }
    at = now
  }
  const ev = add ? (await cx.db.get('events', add))?.wire : undefined
  if (!map.has(r.ik) && add)
    map.set(r.ik, {
      code: code.id,
      until: now + SERVER.redeemTtl,
      add,
      ...(at !== undefined ? { at } : {}),
    })
  cx.redeemers.set(room, map)
  cx.prefer(room, r.ik)
  answer(true, undefined, ev)
}

// Invites a mutual contact; they see it under "P2P server invites" when they are online.
export async function invite(cx: ServerCtx, room: string, ik: string) {
  const c = cx.deps.node.contact(ik)
  if (!c || c.state !== 'mutual') throw new ServerError('Only mutual contacts can be invited')
  const cur = membershipOf(cx.sumOf(room), ik)
  if (cur === 'join') throw new ServerError('Already a member')
  if (cur === 'ban') throw new ServerError('This contact is banned from the server')
  if (cur !== 'invite') await cx.emit(room, 'add', () => ({ to: ik }))
  for (const s of cx.deps.node.readySessions(ik)) cx.sendInvite(s, room)
}

export function sendInvite(cx: ServerCtx, s: Session, room: string) {
  const m = memberOf(cx.sumOf(room), s.remote?.ik ?? '')
  const add = m?.m === 'invite' ? m.adds?.[0] : undefined
  if (!add) return
  void cx.db.get('events', add).then(rec => {
    if (!rec) return
    void s
      .send({
        t: 'ginvite',
        room,
        name: nameOf(cx.sumOf(room))?.name ?? 'P2P server',
        ev: rec.wire,
      })
      .catch(() => {})
  })
}

// A contact comes online: they hear about invites they haven't answered.
export function offerInvites(cx: ServerCtx, s: Session) {
  const ik = s.remote?.ik
  if (!ik || cx.deps.node.contact(ik)?.state !== 'mutual') return
  for (const room of cx.rooms.keys())
    if (cx.myMembership(room) === 'join' && membershipOf(cx.sumOf(room), ik) === 'invite')
      cx.sendInvite(s, room)
}

export async function onInvite(cx: ServerCtx, m: Message, s: Session) {
  const from = s.remote?.ik
  const room = m.room
  if (!from || typeof room !== 'string' || typeof m.name !== 'string') return s.strike()
  // Only from mutual contacts: nobody else can put rows in our list.
  if (cx.deps.node.contact(from)?.state !== 'mutual') return
  const v = validate2(m.ev, room)
  if (!v.ok) return s.strike()
  const ev = v.wire.ev
  if (ev.t !== 'add' || v.wire.c?.to !== cx.me || ev.a !== from) return s.strike()
  const cur = cx.rooms.get(room)
  if (cur && (cur.joining || cx.myMembership(room) === 'join')) return
  if (!cur && (await cx.isDmId(room))) return
  const pending = [...cx.rooms.values()].filter(r => r.invite).length
  if (!cur && pending >= SERVER.invites) return
  const now = cx.clock.now()
  await cx.putRoom({
    ...(cur ?? { ...blankRoom(room, '', now), kind: 'server', chans: {}, server: null }),
    name: clip(m.name, LOCAL.server.nameMax),
    invite: { from, at: now, wire: v.wire },
  })
  cx.ensureRt(room)
  cx.changed(room)
}

export function invites(cx: ServerCtx) {
  return [...cx.rooms.values()].filter(r => r.invite && !r.joining)
}

export async function acceptInvite(cx: ServerCtx, room: string) {
  const r = cx.rooms.get(room)
  if (!r?.invite) return
  const from = r.invite.from
  const now = cx.clock.now()
  await cx.updateRoom(room, cur => ({
    ...cur,
    invite: null,
    joining: { at: now, via: 'invite', ev: cur.invite?.wire },
    since: now,
  }))
  cx.ensureRt(room).joinPosted = false
  cx.prefer(room, from)
  void cx.locked(room, () => cx.takeInvite(room)).catch(() => {})
  cx.deps.node.schedule(true)
  cx.changed(room)
}

export async function declineInvite(cx: ServerCtx, room: string) {
  const r = cx.rooms.get(room)
  if (!r?.invite) return
  if (!(await cx.dropEmpty(room))) await cx.updateRoom(room, cur => ({ ...cur, invite: null }))
  cx.changed(room)
}
