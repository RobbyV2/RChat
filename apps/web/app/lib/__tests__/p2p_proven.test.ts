import { describe, expect, test } from 'bun:test'
import type { Admitted, AclRoom, Received } from '../p2p/acl_room'
import { type Author } from '../p2p/content'
import { insertEvent, insertServer, type InsertCtx, type ServerInsert } from '../p2p/dag'
import type { P2pDatabase } from '../p2p/db'
import type { Wire } from '../p2p/event_v1'
import { buildEvent2, validate2, type WireV2 } from '../p2p/event_v2'
import { keyId, newKeyPair } from '../p2p/keys'
import { b64u } from '../p2p/canonical'
import { P } from '../p2p/acl/rules'
import { genesisBundle } from '../p2p/acl/binding'
import type { AclHost } from '../p2p/resolve_host'
import type { Servers } from '../p2p/server'

const author = (): Author => ({ ik: newKeyPair(), dk: newKeyPair() })

describe('checked wires', () => {
  test('a v2 event gets its checked type from the validator, and a changed one gets none', () => {
    const O = author()
    const skel = {
      rules: 2,
      nonce: b64u(new Uint8Array(16).fill(7)),
      owners: [{ ik: keyId(O.ik.pk), dk: keyId(O.dk.pk) }],
      everyone_bits: P.Invite | P.ViewChannel | P.SendMessages,
      name: 'S',
    }
    const content = { ...skel, owners: [genesisBundle(O.ik, keyId(O.dk.pk), skel)] }
    const g = buildEvent2(O, null, 'genesis', 'a', content, { seq: 0 }, 1)
    const v = validate2(g.wire, null)
    expect(v.ok && v.id).toBe(g.id)
    expect(
      validate2({ ...g.wire, sig: g.wire.sig.replace(/^./, c => (c === 'A' ? 'B' : 'A')) }, null)
    ).toEqual({ ok: false, why: 'signature' })
    expect(validate2({ ...g.wire, later: 1 }, null).ok).toBe(true)
  })

  // What follows is checked by the compiler: each call is refused for the reason its line says.
  test('the stores, the room and the receive path take nothing else', () => {
    const refused = (
      db: P2pDatabase,
      plain2: WireV2,
      plain1: Wire,
      verdict: Received,
      admitted: Admitted,
      ctx: ServerInsert,
      dm: InsertCtx,
      room: AclRoom,
      host: AclHost,
      servers: Servers
    ) => {
      const sound = validate2(plain2, null)
      if (!sound.ok) return
      void insertServer(db, 'r', 'id', sound.wire, 0, { ...ctx, verdict: admitted })
      // @ts-expect-error a v2 wire that no validator returned
      void insertServer(db, 'r', 'id', plain2, 0, ctx)
      // @ts-expect-error a verdict the room did not give
      void insertServer(db, 'r', 'id', sound.wire, 0, { ...ctx, verdict })
      // @ts-expect-error a refusal is not a verdict to store with
      void insertServer(db, 'r', 'id', sound.wire, 0, { ...ctx, verdict: { s: 'R', why: 'x' } })
      // @ts-expect-error a v1 wire that no validator returned
      void insertEvent(db, 'id', plain1, 0, dm)
      // @ts-expect-error the room judges checked wires only
      room.receiveAcl('id', plain2, 0)
      // @ts-expect-error the room judges checked wires only
      room.receiveContent('id', plain2, 0)
      // @ts-expect-error the evaluator host takes checked wires only
      void host.acl('r', 'id', plain2, 0)
      // @ts-expect-error a peer's event enters through the check
      void servers.insert('r', 'id', plain2, 0)
    }
    expect(typeof refused).toBe('function')
  })
})
