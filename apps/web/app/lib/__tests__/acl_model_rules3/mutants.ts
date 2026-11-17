/* eslint-disable */
// @ts-nocheck
// Part of the P2P ACL reference model, used only by tests.
// Mutation self-check: every seeded mutant of model.ts must be caught by the vectors or by the fuzz.
// Usage: bun mutants.ts [fuzzCases=2000] [workers=16] [mutant,mutant,...|all] [fuzzStartSeed=1] [tplCases=0] [tplStartSeed]
const MUTANTS: Record<string, string> = {
  'x-shield': "X events can't be cut",
  'no-goodfaith': 'witnesses need no good faith',
  'rev-stratum': 'a revocation cuts only tail events at or below its own stratum',
  'concurrent-frontier': 'frontier = concurrent events only',
  'no-kstar': 'k* = k',
  'unstrat-pos': "Pos register ignores the writer's stratum",
  'self-late': 'self-cut denies stay candidates in step 2',
  'no-future-excl': 'protection read from the whole set',
  'no-same-target': "a per-member deny never cuts its target's same-stratum operations",
  'no-witness': 'no witnessing: every candidate is void',
  'any-witness':
    'every later event of another identity is a witness (the original O7-absent failure)',
  'code-revival': 'code death is not sticky',
  'growing-k': 'cascade uses k* from the cuts above the stratum only',
  'uses-stale': 'uses() does not require that the deny takes away something still held',
  'shared-vc': "cascade protection read from one view that drops every cause's future",
  'equal-join': 'joins and non-member targets protected only when ranked strictly above',
  'kickless-withdraw': 'a withdrawal cuts a join without Kick',
  'revoke-on-chain': 'device_revoke on the identity chain and no rotation exemption',
  'rot-watermark': "a rotation's watermark checked only for live devices",
  'member-sigs': 'upgrade countersigned only by owners who are members',
  'hash-codes': 'a code revocation kills every code with the same hash',
  'owner-exempt': 'owners exempt from W3',
  'late-exposure': 'exposure read with the decisions made after the operation',
  'kstar-cuts-only': 'k* ignores concurrent senior denies of the author',
  'attrib-union': 'cascade attribution by label unions',
  'world-flat':
    "an earlier op counts in a world without intersecting it with that op's own exposure",
  'fallback-flat':
    "the class-cap fallback counts an earlier cascade cut even if its world is not inside the op's",
  'anchor-newest': 'W3 backlog anchored at the newest event of another identity',
  'no-day': 'no W3(b) day budget for unacknowledged events',
  'deny-breadth': 'every deny exempt from W3, also bans of never-seen principals and role moves',
  'rot-noop': 'no W6 guard for primary_rotate',
  'id-churn': 'no per-identity cap on device_adds and rotations',
  nonmono: 'authority read in one view V_o(K ∪ N) for resources and obstacles',
  'clamp-min':
    "the author's rank clamped to min(rank under K, rank under K ∪ N), not the position hull",
  'cutdeny-stays': 'a cut deny keeps its effect on the obstacles of operations that relied on it',
  'tail-witness':
    "events past their device's revocation watermark may witness (the tail drop rule is then not inert)",
  'revoke-any':
    'every admitted device_revoke counts for the witness watermark, also a void one (breaks O7-absent)',
  'day-mul':
    'W3(b) unacknowledged day budget 4 × the hourly cap (not applicable: model.ts reads it only inside the `day-window` branch, so ACL_MUT=day-mul runs the unchanged model; its defect is `day-window`)',
  'epoch-churn': 'device_adds counted per epoch, so a rotation resets the allowance',
  'no-fresh': 'no W3(d) fresh-device limits',
  'class-region':
    'protection classes counted over the whole region and Γ with causes that cut nothing',
  'day-window': 'W3(b) as an unacknowledged day window instead of a total',
  'w3b-mod': 'the W3(b) total counts only non-exempt events, so moderation is uncounted',
  'id-totals-off': 'no W3(c) total of unacknowledged rotations (the day cap alone)',
  'no-rot-evidence': 'two rotations with one iprev are not evidence',
  'intro-x': 'a device is a candidate only if every introduction is in X',
  'drops-all':
    "a rotation in X is in force and drops every device; the orphan rule's X exclusion off",
  'class-proj-off':
    'protection classes and the fallback test not projected onto G(q), X ops counted',
  'sybil-join':
    "no W3(e): a join through a non-owner's add needs no third identity's acknowledgement",
  'orphan-nonid': 'storage: the orphan rule drops X events past F(dev) only, never identity ops',
  'rot-same-iprev':
    'rotation evidence only for two rotations with the same iprev, not any two concurrent ones',
  'no-race':
    'a non-rotation identity op over the iprev of a rotation of its identity is no evidence',
  'fi-all':
    'storage: the orphan rule also keeps FI of epochs whose rotation is contested (equivalent: headers count as identity evidence)',
  'pool-off': 'no W3(g): no identity pool at admission, no pool candidates',
  'pool-cap-off':
    'W3(g) without its admission part: one view may hold more than poolU unacknowledged events',
  'ghost-dev':
    'headers of dropped events count as device evidence only; the orphan rule keeps the events defining FI and RF',
  'pin-ok': 'no W3(f): an identity may cite its own unacknowledged evidence pairs and pin them',
  'revoke-pool':
    "a device_revoke can be a pool candidate, so a thief's sibling flood voids the revocation of the stolen device",
  'ap-uncapped': 'more than 10 ACL parents admitted',
  'fast-ghost-dev':
    'fast.ts counts kept headers as device evidence only, not as identity, rotation and pool evidence',
  'work-bound':
    'a work bound: a stratum takes the fallback above (2^classes + 1) × |Fl \\ (X ∪ Tail)| > work, which a junior can switch',
  'pool-all':
    "P(x) counts every concurrent event of the identity, also those past their device's fork point (C1 (c) open)",
  'pool-drop':
    'the orphan rule drops candidates that are candidates only by pool evidence, which is unsound once P(x) counts only events before their fork points (poolmono)',
  'keep-headers':
    "every dropped event keeps its header, also events past their device's fork point (C1 (a) open)",
  'bare-idops':
    "identity ops past their device's fork point are dropped without their headers too (a later rotation loses its rotation evidence)",
  'fast-bare-anc':
    "an event that a kept header has in its past may go without its header, so the header's place in the causal order is lost (fast.ts, like a replica, knows it only through ap)",
  'cite-cands':
    'honest clients cite every head, candidates, X and Tail events included (the flood is stored in full)',
  'cite-no-upgrade':
    "honest clients don't cite an upgrade in X either, so the old server never freezes (the client rule without its upgrade exception)",
  'fast-prune-pool':
    "fast.ts's witness search stops at an event in whose state the candidate is only a pool candidate (unsound, since pool candidacy can end)",
  'fork-parent':
    'an event is refused when a parent is a device-fork candidate in St(e) (it refuses honest clients citing an upgrade or a rotation, and does not close layering)',
  'duel-join':
    "a duel ban's target's racing join is exposed at rank <= kk, as protectedTarget let the ban take effect (after a later unban the add that join consumed becomes usable again and the device it introduced is gone)",
  'class-proj-g':
    "protection classes projected onto each op's own G(q), which its author picks with its parents (vectors pclass, jclass)",
  'fast-hdr-parents':
    "fast.ts reads a header's past through its maximal indexed ancestors without the ancestor test (only those events themselves), so an identity op below them looks concurrent (vector header read)",
  'v2-limits':
    "a rules-2 genesis's `limits` field is read (an older client ignores it: the state splits silently; C3)",
  'lim-unranged': 'rules-3 limits are not checked against their ranges',
  'fast-h2-deny':
    'the second head-path case also when an event concurrent with the arrival is a deny',
  'fast-h2-agree':
    'the second head-path case without the agreement test of Eval(S) and St(e) on C(ap)',
  'fast-h2-sameid':
    "the second head-path case also when an event of the arrival's identity is concurrent with it",
  'rk-off':
    'no protection rules: creation records, chains, the void rule, signer checks at evaluation, key and epoch death all off',
  'rk-v2':
    'the recovery-key rules also on rules-2 servers, where an older client reads `rk`, `chain` and `by` as unknown fields',
  'rk-any-signer':
    'an identity record (rotation, certificate, revocation) is admitted whatever key it names as its signer (A1)',
  'rk-drop':
    "the orphan rule drops the events of an identity with a creation record by any candidacy, not only past their device's fork point",
  'rk-epoch-alive':
    'no epoch death for revocations: a revocation signed by a stolen primary concurrently with the recovery stays in force',
  'rk-dev-signer':
    "records whose signer their own position doesn't allow are not made inert at evaluation (equivalent, the evaluation repeats admission's check on the same chain records)",
  'rk-two-cr':
    'a join whose creation record differs from the one its position knows is admitted (the refusal-only path; the void rule then makes the identity unprotected)',
  'rk-key-alive':
    'no key death: a record signed by a recovery key that a reset or removal replaced stays valid, in the chain and in the server',
  'lim-open': 'rules 3 accepts unknown `limits` keys, so a later key splits clients silently',
  'rk-inert-noevidence':
    'an inert rotation is no rotation or race evidence at all, so a record arriving later uncontests what it contested before (seed 13888618)',
  'rk-void-off':
    "no void rule: a creation record stays in force beside a record its identity key signed, or beside a second creation record, so a thief holding a legacy identity's ik mints protection for it",
  'rk-chain-off':
    "introductions and rotations carry no chain: every identity starts at its creation record, so a restored identity's join (certified by its new primary) is refused and a thief holding the epoch-0 primary joins new servers",
  'rk-branch-alive':
    "a record made under a chain record that chain key death killed stays valid (a leaked old phrase's recovery branch keeps its devices after the reset)",
  'rk-rival-ok':
    "rival resets don't equivocate the chain: they kill each other, which falls back to the key both replaced, so the leaked old phrase is alive again",
  'rk-ext-any':
    'an extension may be signed by any primary and keep any device, also without a new chain record',
  'rk-cert-alive':
    "no epoch death for certificates and extensions: a stolen primary's certificate concurrent with a later chain record stays valid with its device's events",
  'rk-epoch-rk':
    "epoch death also kills a revocation signed by a recovery key: the disowning flow with the phrase can't reach before the latest recovery",
  'rk-add-head': "a join through adds that name the invitee's chain head needn't reach it",
  'rk-reset-pk':
    "a reset keeps the old primary (as first drafted): a thief holding it posts the reset as an extension at an early position, and key death kills the user's records signed by the replaced key",
  'lim-proto':
    'the `limits` key check reads the prototype chain (`in`), so names like `toString` or `__proto__` pass as known keys',
  'rk-sh-off':
    "two carriers of one chain record contest each other: with two of the user's devices posting a recovery unwitnessed, both are in X and the stolen device acts",
  'rk-sh-any':
    "carriers of one head are siblings whatever device posts them and keeps (no in-keep bound): a holder of the head's keys mints uncontested devices beyond devCap",
  'rk-sh-drop':
    "siblings drop each other's devices: a fresh recovering device is revoked for good by the other device's extension",
  'rk-void-revives':
    "rival resets void the creation record (every record not signed by ik inert): the user's removals lose their cuts and a dropped device's backdated acts count",
  'rk-void-grants':
    "a frozen identity's grants under either rival branch count, and the rival records kill nothing",
  'rk-void-member': 'a frozen identity stays a member with its devices in the final state',
  'rk-void-admit': 'an event of a frozen identity whose past holds both rival carriers is admitted',
  'rk-upgrade-alive':
    "an upgrade never dies by key or epoch death: a stolen owner device's backdated upgrade freezes S after the owner's recovery",
  'rk-migrate-mem':
    "a rules-3 S' takes membership from `migrate`, so a member listed there is one before its own join",
  'rk-ext-keep':
    'with two same-n heads an extension keeps any device (the keep limit only with a single head)',
  'rk-rec-fields':
    'a chain record with an unknown field is accepted, so one record has two encodings',
  'rk-upg-rot-off':
    "an upgraded S refuses every rotation: the user's reset never reaches it, and a leaked old phrase positioned before the upgrade revives S and takes the owner",
  'rk-upg-rot-mem':
    "an upgraded S admits a rotation carrying new chain records only from members: a genesis owner that left before signing can't post its reset there",
  'rk-sigchain-off':
    "an upgrade signature's carried chain records are checked but never join S's chain: a co-owner's reset carried in its signature leaves the old phrase alive in S",
  'cite-rival':
    "honest clients cite a rival-reset carrier even in X: they acknowledge whatever the old-phrase holder put in its past, so it picks which sibling of a third identity's unacknowledged fork counts",
  'frozen-acts':
    "a frozen identity's own client keeps posting where nobody cites the rival, and its events are admitted there",
  'rk-reach-desc':
    "a join reaches a named head only when it is an ancestor of the join's chain head: an add naming the other one of two reconciled same-n records refuses the user's join with its full chain",
  'rk-link-frozen':
    "linkOf tests the freeze after the pending branch: a frozen identity's fresh device gets an ACL-only link once an owner invites it again",
  'rk-migrate-frozen':
    "projectMembers carries an identity frozen in B(u) unprotected: the carry-over adds it and a join as it is possible in S'",
  // the contacts reference (contacts.ts; vectors only, the fuzz has no contacts)
  'ct-none-default':
    "a contact stored from a source without a creation record is none: a stripped card pins the thief's device and refuses the user's record",
  'ct-qr-none':
    'a QR or safety-number check pins a creation record over none: a hot-ik thief protects a legacy identity in place',
  'ct-badge-nohead':
    "badges aren't checked against heads: a stolen old primary's badge shows for the user after the recovery",
  'ct-succ-fifo':
    'the succession claims list is FIFO: a thief holding a legacy ik pushes out the genuine claim',
  'ct-succ2-dead':
    "a v2 succession ignores key death and the head's validity: a leaked old phrase claims a move after the reset",
  'ct-record-truncate':
    "the account's identity record accepts a PUT that drops records without re-auth: a stolen session truncates the chain",
  // the contacts reference
  'ct-backup-evict':
    'the instance keeps only the last 3 backup versions: three uploads from a stolen session flush every good version',
  'ct-backup-size':
    "a backup PUT over the account's total evicts the oldest versions instead of being refused",
  'ct-cr-unbounded': 'pending creation-record claims are unbounded',
  'ct-server-pins': 'a contact created from a server source pins its creation record',
  'ct-restore-first': 'restore tries only the first id it is given',
  'ct-restore-frozen':
    'restore of a frozen identity keeps fetching for ever instead of offering the move',
  'ct-succ-nohold':
    "a v2 succession at an unknown contact, or naming a head the contact doesn't hold yet, is refused instead of held",
  'ct-succ-v1-refuse':
    'a succession v1 without new_cr (signed by the new ik) is refused instead of shown as a legacy claim',
  'ct-held-unbounded': 'an unknown contact holds any number of unverified chain records',
  'ct-two-cert1': 'two distinct v1 certificates are no proof that ik is in use',
  'ct-succ1-proof': 'a succession v1 is no proof that ik is in use',
  'ct-succ-nodedupe': "succession claims aren't deduplicated by (old, new)",
  // contacts.ts
  'ct-acc-keep':
    "an accepted, unverified move whose head or key a later record kills is kept silently: an old phrase's move accepted before the reset outlives it",
  'ct-succ-chain-drop':
    "a v2's carried chain is only read, and a claim whose head isn't held yet counts as dead: V's move with its chain is dropped when its records then arrive one at a time",
  'ct-held-block':
    "held (unchecked) v2 claims past the cap refuse the newer one: four strangers' claims block V's genuine move",
  'ct-held-forever': 'held v2 claims never expire',
  'ct-cr-nodedupe':
    "creation-record claims aren't deduplicated: the same record from a hello and a card makes two claims with the impersonation warning",
  'ct-restore-rank':
    'restore ranks keep-fetching above the move: a frozen id beside a stale one keeps fetching',
  'ct-safety-two': "with two pending claims the safety screen shows the first claim's number",
  'ct-backup-nodelete': "no per-version delete, though the 'Backup full' copy depends on it",
  // the model's rules
  'rk-upg-any-carrier':
    "an upgrade's signatures die through every carrier of a later record: a stolen device of a later epoch undoes a transfer with an extension concurrent with it, and a sole owner's thief posts its own",
  'rk-upg-intro-any':
    "an upgrade reads its author device's introductions with the full deaths: a later-epoch extension concurrent with the author device's device_add undoes the transfer",
  'holds-dormant':
    "a rejoin revives the roles of a membership a cascade cut: a pending identity's concurrent rejoin makes a stratum-2 ban of it ineffective (seed 91,025,433)",
  'link-push-off':
    "no push link: a non-member's posting, a left identity's, and a phrase-only restore's rotation have no link",
  'link-push-trust':
    "a push link for any device presenting new records, whether or not the new head trusts it: a device certified under a replaced primary pushes the user's records",
  'link-push-ban':
    "a banned identity gets no push link: the posting at a ban's parents never arrives",
  'link-pending-fresh':
    "a pending identity's ACL-only link only for a device the state never introduced: a kept device that S introduced before can't rejoin, nor a re-invited member whose join a cascade cut",
  'holds-any-join':
    "Holds through any live join of the target in the assign's past, an earlier membership's included: the join of a membership a leave ended revives the roles of a later membership a cascade cut, also in a view that doesn't hold that leave as effective yet",
  'push-accept-any':
    'a push link accepts any event of the identity: a kick, a plain join, a rotation carrying nothing new',
  // one mutant per client-rule bullet (client.ts)
  'cl-left-latest':
    "the left bullet at the identity's latest leave or removal in the state: a thief that rejoins, acts and leaves again keeps its acts",
  'cl-left-moves':
    "the recorded leave moves to a later leave the client's own device signs while the server is on its list: the posting then sits after a thief's rejoin and acts",
  'cl-flow-order':
    "the flow lets the phrase go before the owned servers are posted: their carriers are extensions, and a stolen old device's backdated transfer counts (the flow signs for every owned server while the phrase is at hand)",
  'cl-rejoin-first':
    "the user's rejoin of a server on its list goes first, on the heads, without the rotation at the recorded leave: what a dropped device did since the leave stays",
  'cl-left-heads':
    'no precedence for the left bullet: once a stolen device rejoined, a server the identity left gets the member or upgraded bullet',
  'cl-upg-atleave':
    'the left bullet ignores an upgrade the client signed: a co-owner that left before signing undoes its own transfer',
  'cl-upg-heads':
    "the archived-S posting on the heads: an old phrase's records that arrived first drop its poster or fill its day cap, and the thief revives S",
  'cl-member-heads':
    'the member posting on the heads: the old phrase that acted first keeps the identity in a live server',
  'cl-older-heads':
    "the older-epoch posting on the heads instead of at the thief's introduction: what the thief's device did meanwhile stands",
  'cl-older-nojoin':
    "a rotation at an introduction whose chain branch the client's records kill, instead of the join beside it (the cut-off first attempt): the rotation kills the join the membership rested on, and the user is out of a server it was invited to, or owns ('so the identity stays a member')",
  'cl-trust-nojoin':
    "records of the identity the client didn't make stay untrusted after its own join settled them (the cut-off first attempt): after its own rejoin the client's next posting sits before that join, where it is no member, and is refused",
  'cl-keep-poster':
    'the poster in its own keep: the posting is refused (auth) and the thief takes over',
  'cl-owned-ext':
    "extensions where the identity is a genesis owner: a stolen old-epoch device's backdated upgrade survives the user's carrier",
  'cl-wm-noleave':
    "the left posting's watermark of the device that made the leave doesn't cover the leave: the leave is in Tail",
  'cl-no-revoke': 'no revocations at a join that brings a new head (as ACL_GEN_NOREVOKE)',
  'cl-poster-dropped':
    'the maker posts even where it is revoked or dropped: its posting has no link, or is refused',
  'cl-fresh-unkept':
    "the fresh fallback poster is neither kept by the record nor posts an extension: it signs with the recovery key outside the record's keep",
  'cl-no-sweep':
    "no start-up sweep: a crash between a join and its revocations leaves the old device live, and an owned server whose only carrier is an extension keeps a stolen device's backdated upgrade",
  'cl-join-heads':
    "a join ignores an add naming a head its chain doesn't reach and goes on the heads: it is refused",
  'cl-join-nochain':
    "a join carries the creation record without the chain: refused where an add names the head, and in S' the user is locked out",
  'cl-repair-heads':
    'the repair of a record a stolen primary killed, on the trusted heads instead of at the dead record: what the dead record disowned counts again',
  'cl-owned-join':
    "after a join of its own that carried the head into a server it owns, the client posts no carrier signed by the recovery key until the next start-up sweep: a stolen old primary's fresh device rejoins and transfers, positioned before that join, and the transfer counts (every chain posting in an owned server is signed by the recovery key)",
  'cl-reset-unfetched':
    "a reset made without fetching the identity's head in the flow: two of the user's devices make rival resets and freeze it",
}
const fuzzN = Number(process.argv[2] ?? 2000)
const workers = Number(process.argv[3] ?? 16)
const only =
  process.argv[4] && process.argv[4] !== 'all' ? new Set(process.argv[4].split(',')) : undefined
const fuzzStart = Number(process.argv[5] ?? 1)
const tplN = Number(process.argv[6] ?? 0)
const tplStart = Number(process.argv[7] ?? fuzzStart)
const dir = import.meta.dir
const rows: string[] = []
for (const [m, what] of Object.entries(MUTANTS)) {
  if (only && !only.has(m)) continue
  const env = { ...process.env, ACL_MUT: m, ACL_CASES: '0' }
  const t = Bun.spawnSync(
    [
      'bun',
      'test',
      '--timeout',
      '120000',
      'vectors.test.ts',
      'vectors-invites-codes.test.ts',
      'vectors-limits-keys.test.ts',
      'vectors-recovery.test.ts',
      'vectors-old-phrase.test.ts',
      'vectors-client.test.ts',
      'contacts.test.ts',
      'fixtures.test.ts',
    ],
    { cwd: dir, env, stderr: 'pipe', stdout: 'pipe' }
  )
  const out = t.stderr.toString() + t.stdout.toString()
  const failed = [...out.matchAll(/^\(fail\) (.+?) \[/gm)].map(x => x[1].split(' > ').pop()!)
  const f = Bun.spawnSync(['bun', 'fuzz.ts', String(fuzzN), String(fuzzStart), String(workers)], {
    cwd: dir,
    env,
    stdout: 'pipe',
  })
  const fo = f.stdout.toString()
  const fj = JSON.parse(fo.slice(0, fo.lastIndexOf('}') + 1))
  // the recovery-key mutants also get a forced-template pass (tplN seeds per recovery-key template on rules 3),
  // and the table names the properties other than O15-oracle that kill a mutant (a kill by the oracle alone isn't one
  // by behaviour)
  let tcol = ''
  const randomProps = Object.keys(fj.byProp)
  const all = new Set(randomProps)
  if (
    tplN > 0 &&
    (m.startsWith('rk-') ||
      m.startsWith('cl-') ||
      m.startsWith('link-') ||
      m === 'push-accept-any' ||
      m === 'cite-rival' ||
      m === 'frozen-acts')
  ) {
    const p = Bun.spawnSync(
      ['bun', 'tplfuzz.ts', String(tplN), String(tplStart), String(workers)],
      { cwd: dir, env, stdout: 'pipe' }
    )
    const po = p.stdout.toString()
    const pj = JSON.parse(po.slice(0, po.lastIndexOf('}') + 1))
    tcol = `${pj.failedCases}/${pj.cases} ${Object.keys(pj.byProp).join(', ')}`
    for (const k of Object.keys(pj.byProp)) all.add(k)
  }
  const behaviour = [...all].filter(k => k !== 'O15-oracle')
  rows.push(
    `| \`${m}\` | ${what} | ${failed.length ? failed.join('; ') : 'none'} | ${fj.failedCases}/${fuzzN} ${randomProps.join(', ')} | ${tcol} | ${behaviour.join(', ') || 'none'} |`
  )
  console.error(rows[rows.length - 1])
}
console.log(
  '| Mutant | Change | Vectors that fail | Fuzz cases failing (properties) | Forced recovery-key templates failing (properties) | Properties other than O15-oracle |\n|---|---|---|---|---|---|\n' +
    rows.join('\n')
)
