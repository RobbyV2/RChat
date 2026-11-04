import { genesisBundle, signDeviceCert2 } from '../p2p/acl/binding'
import { CHANNEL_CONTENT } from '../p2p/acl/admit'
import { RULES_VERSION } from '../p2p/acl/rules'
import type { ContentEv } from '../p2p/acl/visibility'
import { AclRoom, type AclItem, type Plan, type Received } from '../p2p/acl_room'
import { b64u, randomBytes } from '../p2p/canonical'
import { buildEvent2, contentEvOf, validate2, type ChainFields, type WireV2 } from '../p2p/event_v2'
import { keyId, newKeyPair, type KeyPair } from '../p2p/keys'
import type { Agreed } from '../p2p/limits'
import { EVERYONE_BITS } from '../p2p/server'

// Server worlds for the rules tests: real signed v2 events (spec 1.2) received by the evaluator
// the host serves (acl_room.ts), built as honest clients build them (its plan) unless a test
// overrides the chain fields (a stale position, a reused seq, a future date).

export const T0 = 1_700_000_000_000
export const MIN = 60_000

export interface Who {
  name: string
  ik: KeyPair
  dk: KeyPair
  a: string
  dev: string
}

// Chain fields to use instead of the plan's, a date, and the member a watermark covers (when the
// content is made from the plan).
export type Over = Partial<ChainFields> & { ts?: number; to?: string }

export interface Sent {
  id: string
  wire: WireV2
  out: Received
}

export class ServerWorld {
  room!: AclRoom
  agreed?: Agreed
  srv = ''
  now = T0
  people = new Map<string, Who>()
  // What was received, in order, with the records of admitted ACL events (a store's view).
  acl: AclItem[] = []
  contents: ContentEv[] = []
  wires = new Map<string, WireV2>()

  who(name: string): Who {
    let w = this.people.get(name)
    if (!w) {
      const ik = newKeyPair()
      const dk = newKeyPair()
      w = { name, ik, dk, a: keyId(ik.pk), dev: keyId(dk.pk) }
      this.people.set(name, w)
    }
    return w
  }

  // Another device of `name` (same identity).
  device(name: string, as: string): Who {
    const w = this.who(name)
    const dk = newKeyPair()
    const d = { ...w, name: as, dk, dev: keyId(dk.pk) }
    this.people.set(as, d)
    return d
  }

  static create(owner: string, extra: Record<string, unknown> = {}, agreed?: Agreed) {
    const w = new ServerWorld()
    w.agreed = agreed
    const o = w.who(owner)
    const bare: Record<string, unknown> = {
      rules: RULES_VERSION,
      nonce: b64u(randomBytes(16)),
      owners: [{ ik: o.a, dk: o.dev }],
      everyone_bits: EVERYONE_BITS,
      name: 'Test',
      ...extra,
    }
    const content =
      bare.rules === RULES_VERSION ? { ...bare, owners: [genesisBundle(o.ik, o.dev, bare)] } : bare
    const g = buildEvent2(o, null, 'genesis', 'a', content, { seq: 0 }, w.now)
    w.srv = g.id
    w.room = new AclRoom(g.id, { agreed })
    w.receive(g.id, g.wire)
    return w
  }

  plan(name: string, t: string, to?: string): Plan {
    const w = this.who(name)
    const L = CHANNEL_CONTENT.includes(t) ? 'c' : 'a'
    return this.room.plan({ t, L, a: w.a, dev: w.dev, to })
  }

  // An event `name` signs as an honest client would (or with `over` replacing chain fields).
  build(
    name: string,
    t: string,
    content: Record<string, unknown> | ((p: Plan) => Record<string, unknown>),
    over: Over = {}
  ) {
    const w = this.who(name)
    const L = CHANNEL_CONTENT.includes(t) ? 'c' : 'a'
    const to = over.to ?? (content as { to?: string }).to
    const p = this.room.plan({ t, L, a: w.a, dev: w.dev, to })
    const fields: ChainFields = { seq: p.seq + 1, ap: p.ap }
    if (L === 'a' && p.aprev) fields.aprev = p.aprev
    if (L === 'a' && p.iprev) fields.iprev = p.iprev
    if (L === 'c') {
      const last = [...this.contents].reverse().find(m => m.dev === w.dev)
      if (last) fields.cprev = last.id
    }
    const c = typeof content === 'function' ? content(p) : content
    const { ts, to: _to, ...rest } = over
    this.now += 1
    return buildEvent2(w, this.srv, t, L, c, { ...fields, ...rest }, ts ?? Math.max(this.now, p.ts))
  }

  // Receives an event as a replica does after the wire checks (validate2), recording it as stored
  // when admitted.
  receive(id: string, wire: WireV2): Received {
    const v =
      wire.ev.t === 'genesis'
        ? validate2(wire, null)
        : validate2(wire, this.srv, this.room.summary().rules ?? RULES_VERSION)
    if (!v.ok) return { s: 'M', why: v.why }
    this.wires.set(id, wire)
    const out =
      wire.ev.L === 'a'
        ? this.room.receiveAcl(id, wire, this.now)
        : this.room.receiveContent(id, wire, this.now)
    if (out.s === 'A') this.acl.push({ id, w: wire, rec: out.rec })
    if (out.s === 'U' && wire.ev.L === 'a') this.acl.push({ id, w: wire })
    if (out.s === 'C') this.contents.push(contentEvOf(id, wire))
    return out
  }

  post(
    name: string,
    t: string,
    content: Record<string, unknown> | ((p: Plan) => Record<string, unknown>) = {},
    over: Over = {}
  ): Sent {
    const { id, wire } = this.build(name, t, content, over)
    return { id, wire, out: this.receive(id, wire) }
  }

  // `post` that must be admitted (ACL) or stored (content).
  ok(name: string, t: string, content: Parameters<ServerWorld['post']>[2] = {}, over: Over = {}) {
    const s = this.post(name, t, content, over)
    if (s.out.s !== 'A' && s.out.s !== 'C')
      throw new Error(`${name} ${t}: ${s.out.s} ${'why' in s.out ? s.out.why : ''}`)
    return s
  }

  // `who` joins through an add by `by` (an introducing join with its device certificate).
  join(by: string, name: string) {
    const w = this.who(name)
    this.ok(by, 'add', { to: w.a })
    return this.ok(name, 'join', p => ({
      idb: { ik: w.a, dcert: signDeviceCert2(w.ik, this.srv, w.a, w.dev, p.iprev) },
    }))
  }

  // A device of a member introduces itself.
  addDevice(name: string) {
    const w = this.who(name)
    return this.ok(name, 'device_add', p => ({
      dcert: signDeviceCert2(w.ik, this.srv, w.a, w.dev, p.iprev),
    }))
  }

  channel(by: string, id = 'AAAAAAAAAAA') {
    this.ok(by, 'channel', { id, name: 'general', kind: 'text', pos: 0 })
    return id
  }

  get sum() {
    return this.room.summary()
  }

  // A cold start from what was stored: the records, no event decided again. `map` changes what
  // was stored (a record dropped, of another version, tampered with).
  restore(map: (it: AclItem) => AclItem = it => it) {
    const r = new AclRoom(this.srv, { agreed: this.agreed })
    const out = r.restore(this.acl.map(map), this.contents)
    return { r, out, fresh: out.fresh }
  }
}
