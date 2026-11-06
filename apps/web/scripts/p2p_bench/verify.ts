// The page's wire check per server event (validate2: canonical id, Ed25519 signature, content
// hash) on `--events` N signed mark events, and the cost of signing them.
// Usage: bun apps/web/scripts/p2p_bench/verify.ts [--events N]
import { buildEvent2, validate2 } from '../../app/lib/p2p/event_v2'
import { newKeyPair } from '../../app/lib/p2p/keys'
import { args, emit, f3 } from './world'

const a = args()
const N = a.events
const author = { ik: newKeyPair(), dk: newKeyPair() }
const T0 = 1_700_000_000_000
const srv = buildEvent2(author, null, 'genesis', 'a', { rules: 2 }, { seq: 0 }, T0).id
const ap = [0, 1].map(i => buildEvent2(author, srv, 'mark', 'a', {}, { seq: i + 1 }, T0 + i).id)
const t0 = performance.now()
const ws = Array.from(
  { length: N },
  (_, i) => buildEvent2(author, srv, 'mark', 'a', {}, { seq: i + 3, ap }, T0 + i).wire
)
const signMs = performance.now() - t0
let bad = 0
let why = ''
const t1 = performance.now()
for (const w of ws) {
  const v = validate2(w, srv)
  if (!v.ok) {
    bad++
    why = v.why
  }
}
const verMs = performance.now() - t1
emit('verify', {
  events: N,
  sign_ms_per_event: f3(signMs / N),
  validate_ms_per_event: f3(verMs / N),
  bad,
  ...(why ? { why } : {}),
})
