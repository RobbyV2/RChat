import { isRecord } from '../../bytes'
import { deviceCertOk, genesisBundle, genesisSrv } from '../acl/binding'
import { aclContentOk, RULES_VERSION } from '../acl/rules'
import type { Plan, Received } from '../acl_room'
import { b64u, bytesOf, randomBytes } from '../canonical'
import { blankRoom, chainKey, insertServer, type DevChain } from '../dag'
import { buildEvent2, LIMITS2, validate2, type ChainFields } from '../event_v2'
import { LIMITS as EV, sizeOf } from '../content'
import { type Wire } from '../event_v1'
import {
  CANT_TEXT,
  CONFLICT_TEXT,
  CO_OWNERS_MAX_TEXT,
  TOO_BIG_TEXT,
  TRANSFERRED_TEXT,
  refusalText,
} from '../flows'
import type { Message } from '../frames'
import { keyId } from '../keys'
import { AGREED, LOCAL } from '../limits'
import type { Session } from '../session'
import {
  channelOf,
  channelsOf,
  knownChannel,
  knownSettings,
  type HistoryVis,
  type SystemContent,
} from '../state'
import { isQuotaError } from '../sync'
import { MOVED_TEXT, MOVING_TEXT, STORAGE_FULL_TEXT } from '../dm'
import type { ServerCtx } from './context'
import {
  SERVER,
  SYNC_TEXT,
  ServerError,
  newShortId,
  EVERYONE_BITS,
  sizeOfWire,
  type EmitOpts,
  type ChannelPatch,
} from './types'
import { clip } from '../rate'

export async function author(cx: ServerCtx) {
  const author = cx.deps.node.author()
  if (!author) throw new ServerError(MOVED_TEXT)
  if (await cx.deps.node.sendingPaused()) throw new ServerError(MOVING_TEXT)
  return author
}

// Builds, decides, stores and sends an event of ours, within the room's lock and the device's
// signing lock. `make` writes the content from the plan (its parents, identity-chain position,
// watermark). The device's chain is read from the store and checked again in the transaction
// that stores the event.
export function emit(
  cx: ServerCtx,
  room: string,
  t: string,
  make: (plan: Plan) => Record<string, unknown>,
  opts: EmitOpts = {}
) {
  return cx.locked(room, () => cx.emitNow(room, t, make, opts))
}

export async function emitNow(
  cx: ServerCtx,
  room: string,
  t: string,
  make: (plan: Plan) => Record<string, unknown>,
  opts: EmitOpts = {}
): Promise<string> {
  const author = await cx.author()
  if (cx.readOnly(room)) throw new ServerError(cx.readOnly(room) as string)
  const rt = cx.ensureRt(room)
  await rt.loading
  // Spec 3.9: a device whose history conflicts with another copy of it stops signing.
  if (rt.conflict) throw new ServerError(CONFLICT_TEXT)
  // Spec 3.8: a copy transferred to a new one takes nothing but leaving.
  if (cx.sumOf(room).upgraded && t !== 'leave') throw new ServerError(TRANSFERRED_TEXT)
  const dev = keyId(author.dk.pk)
  const L = opts.L ?? 'a'
  const chainNow = async () =>
    ((await cx.db.get('meta', chainKey(room, dev))) as DevChain | undefined) ?? null
  return cx.withDevice(dev, async () => {
    let chain = await chainNow()
    const req = { t, L, a: cx.me, dev, to: opts.to, ...(opts.ap ? { ap: opts.ap } : {}) }
    let plan = await cx.host.plan(room, req)
    if (!plan.ap.length) throw new ServerError('Unknown server')
    // Never sign from a position without this device's last ACL event (a room removed here
    // and joined again, a backfill under way): that would fork the device.
    if ((chain?.aprev ?? plan.aprev) !== plan.aprev) {
      // Spec 3.9: this device's key signed past what this device stored: another copy of it.
      if (plan.aclSeq > (chain?.seq ?? -1)) {
        cx.conflicted(room)
        throw new ServerError(CONFLICT_TEXT)
      }
      if (chain?.aprev) rt.need.add(chain.aprev)
      throw new ServerError(SYNC_TEXT)
    }
    // W4 (spec 4.1): a mark at least every 500 content events of this device.
    if (L === 'c' && Math.max(chain?.seq ?? -1, plan.seq) + 1 - plan.aclSeq > AGREED.w4) {
      const mp = await cx.host.plan(room, { t: 'mark', L: 'a', a: cx.me, dev })
      await cx.emitOne(room, 'mark', {}, 'a', chain, mp)
      chain = await chainNow()
      plan = await cx.host.plan(room, req)
    }
    return cx.emitOne(room, t, make(plan), L, chain, plan)
  })
}

export async function emitOne(
  cx: ServerCtx,
  room: string,
  t: string,
  content: Record<string, unknown>,
  L: 'a' | 'c',
  chain: DevChain | null,
  plan: Plan
): Promise<string> {
  const author = await cx.author()
  const now = cx.clock.now()
  const seq = Math.max(chain?.seq ?? -1, plan.seq) + 1
  const fields: ChainFields = { seq, ap: plan.ap }
  if (L === 'a') {
    if (plan.aprev !== undefined) fields.aprev = plan.aprev
    if (plan.iprev !== undefined) fields.iprev = plan.iprev
  } else {
    const rec = await cx.deps.store.room(room)
    fields.prev = (rec?.heads ?? []).map(h => h.id).slice(0, EV.prev)
    if (chain?.cprev !== undefined) fields.cprev = chain.cprev
  }
  const ts = Math.max(now, plan.ts)
  const { id, wire } = buildEvent2(author, room, t, L, content, fields, ts)
  // The wire checks peers apply (a strike there): one of ours that fails them is never kept.
  const v = validate2(wire, room, cx.sumOf(room).rules ?? RULES_VERSION)
  if (!v.ok) throw new ServerError(v.why === 'size' ? TOO_BIG_TEXT : CANT_TEXT)
  // Our own content needs room too (spec 4.2): evicted for in the stated order.
  for (let full = L === 'c' ? await cx.contentFull(room, wire) : null; full;) {
    if (!(await cx.evictForSpace(room, sizeOfWire(wire), full === 'total'))) break
    full = await cx.contentFull(room, wire)
  }
  let out: Received
  let delta = null
  if (L === 'a') ({ out, delta } = await cx.host.acl(room, id, wire, ts))
  else out = await cx.host.content(room, id, wire, ts)
  if (out.s === 'R') {
    if (out.why === 'forked') cx.conflicted(room)
    throw new ServerError(refusalText(out.why))
  }
  if (out.s !== 'A' && out.s !== 'C') throw new ServerError(CANT_TEXT)
  let res
  try {
    res = await insertServer(cx.db, room, id, wire, now, {
      me: cx.me,
      chain,
      ...(out.s === 'A' ? { aseq: out.aseq, acl: out.rec } : {}),
      roomCap: cx.deps.roomCap,
      roomBytes: cx.deps.roomBytes,
      serverCap: cx.deps.serverCap,
      serverBytes: cx.deps.serverBytes,
    })
  } catch (e) {
    await cx.reload(room)
    if (!isQuotaError(e)) throw e
    cx.storageFull = true
    throw new ServerError(STORAGE_FULL_TEXT)
  }
  if (res.status !== 'new') {
    // The evaluator took it but it isn't stored: start again from what is.
    await cx.reload(room)
    if (res.status === 'full') throw new ServerError(cx.deps.dms.fullText(res.why))
    throw new ServerError("Couldn't save that")
  }
  cx.storageFull = false
  if (t === 'migrate') cx.migrateArrived(cx.ensureRt(room))
  await cx.db.put('outbox', { id, room, created: now, deliveredTo: [] })
  const cached = cx.rooms.get(room)
  if (cached && cached.lastSeq < res.rec.seq)
    cx.rooms.set(room, { ...cached, lastSeq: res.rec.seq })
  if (delta) await cx.applyDelta(room, delta)
  if (L === 'c') {
    await cx.purgeRedacted(room, res.rec)
    await cx.fillViews(room, typeof wire.c?.ch === 'string' ? wire.c.ch : '')
  }
  cx.sync.push(room, id, wire as unknown as Wire)
  cx.sync.announce(room)
  cx.changed(room)
  return id
}

// Reloads a room's evaluator from what is stored (after a failed store).
export async function reload(cx: ServerCtx, room: string) {
  const r = await cx.deps.store.room(room)
  if (r) await cx.load(r)
}

// A new server (spec 3.8): its owners are fixed in its genesis. With co-owners it takes two
// rounds over a session with each (each agrees when asked, answerCoOwner): the creator assembles the
// whole genesis content without the owners' device certificates, naming each co-owner's
// device of that session, and sends it; each co-owner checks it and returns its certificate
// over the digest of that content (binding.ts genesisDigest); the creator adds them and signs.
// Then a #general channel and the settings.
export async function create(
  cx: ServerCtx,
  name: string,
  coOwners: string[] = []
): Promise<string> {
  const author = await cx.author()
  const clean = clip(name.trim(), LOCAL.server.nameMax) || 'P2P server'
  const dk = keyId(author.dk.pk)
  if (coOwners.length > SERVER.coOwners) throw new ServerError(CO_OWNERS_MAX_TEXT)
  const sessions = coOwners.map(ik => {
    const s = cx.deps.node.readySessions(ik).find(x => x.remote?.ik === ik)
    if (!s?.remote) throw new ServerError('Every co-owner must be online')
    return s
  })
  const owners = [{ ik: cx.me, dk }, ...sessions.map(s => ({ ik: s.remote!.ik, dk: s.remote!.dk }))]
  const bare: Record<string, unknown> = {
    rules: RULES_VERSION,
    nonce: b64u(randomBytes(16)),
    owners,
    everyone_bits: EVERYONE_BITS,
    name: clean,
    cert: cx.deps.node.cert,
    profile: cx.deps.node.profile,
  }
  const binding = cx.deps.node.binding
  if (binding) bare.binding = binding
  const dcerts = [genesisBundle(author.ik, dk, bare).dcert]
  // Every owner's certificate is about as long as ours: don't ask anyone for a genesis that
  // can't be sent.
  const est = { ...bare, owners: owners.map(o => ({ ...o, dcert: dcerts[0] })) }
  if (sizeOf(est) > LIMITS2.aclContent) throw new ServerError(TOO_BIG_TEXT)
  for (const s of sessions) dcerts.push(await cx.askBundle(s, bare))
  const content = { ...bare, owners: owners.map((o, i) => ({ ...o, dcert: dcerts[i] })) }
  const now = cx.clock.now()
  const { id: room, wire } = buildEvent2(author, null, 'genesis', 'a', content, { seq: 0 }, now)
  if (!validate2(wire, null).ok) throw new ServerError(TOO_BIG_TEXT)
  await cx.putRoom({
    ...blankRoom(room, '', now),
    kind: 'server',
    name: clean,
    chans: {},
    server: null,
    since: now,
  })
  await cx.locked(room, async () => {
    const res = await cx.withDevice(dk, () => cx.take(room, room, wire, now))
    if (res.status !== 'new') throw new ServerError("Couldn't create the server")
    await cx.db.put('outbox', { id: room, room, created: now, deliveredTo: [] })
  })
  const general = newShortId()
  await cx.emit(room, 'channel', () => ({ id: general, name: 'general', kind: 'text', pos: 0 }))
  await cx.emit(room, 'settings', () => ({
    name: clean,
    history: 'shared',
    system: { ch: general, join: true, leave: true },
  }))
  return room
}

// Round two with one co-owner: the genesis content without certificates goes out, its device
// certificate over that content's digest comes back.
export async function askBundle(cx: ServerCtx, s: Session, g: Record<string, unknown>) {
  const r = s.remote!
  const reply = await cx.request(s, { t: 'gbundle', room: g.nonce as string, g }, SERVER.coOwnerMs)
  const dcert = (reply?.b as { dcert?: unknown } | undefined)?.dcert
  if (typeof dcert !== 'string' || !deviceCertOk(r.ik, genesisSrv(g), r.ik, r.dk, '', dcert))
    throw new ServerError(`${cx.nameOf(r.ik)} didn't agree to be a co-owner`)
  return dcert
}

// A contact we agreed to co-own a server with sends its genesis content: we sign our device's
// certificate over its digest if it is a genesis of rules we know, by that contact, with no
// certificates yet, listing us once with this device.
export function onBundle(cx: ServerCtx, m: Message, s: Session) {
  const from = s.remote?.ik
  const g = m.g
  if (!from || !isRecord(g) || bytesOf(g.nonce, 16) === null || typeof m.room !== 'string')
    return s.strike()
  const author = cx.deps.node.author()
  const dk = author ? keyId(author.dk.pk) : ''
  const owners = Array.isArray(g.owners) ? g.owners : []
  const ok =
    !!author &&
    cx.deps.node.contact(from)?.state === 'mutual' &&
    m.room === g.nonce &&
    g.rules === RULES_VERSION &&
    aclContentOk('genesis', g) &&
    sizeOf(g) <= LIMITS2.aclContent &&
    owners.every(o => isRecord(o) && o.dcert === undefined) &&
    owners.some(o => isRecord(o) && o.ik === from) &&
    owners.filter(o => isRecord(o) && o.ik === cx.me).length === 1 &&
    owners.some(o => isRecord(o) && o.ik === cx.me && o.dk === dk)
  if (!ok || !author) return cx.answerBundle(s, m.room, g, ok)
  // Asked here (coOwnerAsks): agreed or declined from the UI, or no answer in time.
  const key = `${from}\n${m.room}`
  if (cx.coAsks.size >= SERVER.coOwnerAsks && !cx.coAsks.has(key))
    return cx.answerBundle(s, m.room, g, false)
  cx.coAsks.set(key, {
    from,
    name: typeof g.name === 'string' ? clip(g.name, LOCAL.server.nameMax) : '',
    room: m.room,
    g,
    s,
  })
  const drop = () => {
    if (cx.coAsks.delete(key)) cx.changed('')
  }
  s.onClose(drop)
  cx.clock.set(drop, SERVER.coOwnerMs)
  cx.changed('')
}

export function answerBundle(
  cx: ServerCtx,
  s: Session,
  room: string,
  g: Record<string, unknown>,
  ok: boolean
) {
  const author = cx.deps.node.author()
  const dk = author ? keyId(author.dk.pk) : ''
  const b = ok && author ? { dcert: genesisBundle(author.ik, dk, g).dcert } : null
  void s.send({ t: 'gbundled', room, ok: !!b, ...(b ? { b } : {}) }).catch(() => {})
}

// Contacts asking to list us as co-owner of a server they are creating (spec 8.2).
export function coOwnerAsks(cx: ServerCtx) {
  return [...cx.coAsks].map(([key, a]) => ({ key, from: a.from, name: a.name }))
}

export function answerCoOwner(cx: ServerCtx, key: string, yes: boolean) {
  const a = cx.coAsks.get(key)
  if (!a) return
  cx.coAsks.delete(key)
  cx.answerBundle(a.s, a.room, a.g, yes)
  cx.changed('')
}

// Only the fields this version knows are written again: one planted by someone else never
// makes our change too big to send.
export function settings(cx: ServerCtx, room: string, patch: Record<string, unknown>) {
  return cx.emit(room, 'settings', () => ({
    ...knownSettings(cx.sumOf(room).settings ?? {}),
    ...patch,
  }))
}

export function setName(cx: ServerCtx, room: string, name: string, color?: number | null) {
  const patch: Record<string, unknown> = { name: clip(name.trim(), LOCAL.server.nameMax) }
  if (typeof color === 'number') patch.color = color
  return cx.settings(room, patch)
}

export function setHistory(cx: ServerCtx, room: string, vis: HistoryVis) {
  return cx.settings(room, { history: vis })
}

export function setSystem(cx: ServerCtx, room: string, sys: SystemContent) {
  return cx.settings(room, { system: sys })
}

// `restrictView`: only owners, Manage channels and overwrites that allow it may view it (spec
// 1.4; the editor for overwrites is Task 23's).
export function addChannel(
  cx: ServerCtx,
  room: string,
  name: string,
  opts: { restrictView?: boolean; kind?: 'text' | 'voice' } = {}
) {
  const pos = Math.max(-1, ...channelsOf(cx.sumOf(room)).map(c => c.pos)) + 1
  const id = newShortId()
  return cx
    .emit(room, 'channel', () => ({
      id,
      name: clip(name.trim(), LOCAL.server.nameMax),
      kind: opts.kind ?? 'text',
      pos,
      ...(opts.restrictView ? { restrict_view: true } : {}),
    }))
    .then(() => id)
}

// Restrictions and slow mode (seconds) too; a restriction off or slow mode 0 is left out.
export function editChannel(cx: ServerCtx, room: string, id: string, patch: ChannelPatch) {
  const cur = channelOf(cx.sumOf(room), id)
  if (!cur) throw new ServerError('Unknown channel')
  const next: Record<string, unknown> = { ...knownChannel(cur), ...patch, id }
  if (patch.name !== undefined) next.name = clip(patch.name.trim(), LOCAL.server.nameMax)
  if (next.topic === '') delete next.topic
  for (const k of ['restrict_view', 'restrict_send']) if (next[k] !== true) delete next[k]
  if (!Number.isSafeInteger(next.slow) || (next.slow as number) <= 0) delete next.slow
  return cx.emit(room, 'channel', () => next)
}

// A channel overwrite (spec 1.4 `chperm`): `subj` is `r:<role>` or `u:<ik>`; allow and deny 0
// clear it.
export function setOverwrite(
  cx: ServerCtx,
  room: string,
  ch: string,
  subj: string,
  allow: number,
  deny: number
) {
  return cx.emit(room, 'chperm', () => ({ ch, subj, allow, deny }))
}
