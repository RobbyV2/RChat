/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/mutants.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
// Mutation self-check (§7.7): every seeded mutant of model.ts must be caught by the vectors or by the fuzz.
// Usage: bun mutants.ts [fuzzCases=2000] [workers=16] [mutant,mutant,...|all] [fuzzStartSeed=1] [tplCases=0] [tplStartSeed]
const MUTANTS: Record<string, string> = {
  'x-shield': "X events can't be cut (revision-1 behaviour; [H1])",
  'no-goodfaith': 'witnesses need no good faith ([H4], N14)',
  'rev-stratum': 'a revocation cuts only tail events at or below its own stratum ([H2])',
  'concurrent-frontier': 'frontier = concurrent events only ([H3])',
  'no-kstar': 'k* = k ([H3])',
  'unstrat-pos': "Pos register ignores the writer's stratum ([RV I1])",
  'self-late': 'self-cut denies stay candidates in step 2 ([RV C1] class)',
  'no-future-excl': 'protection read from the whole set ([RV I3])',
  'no-same-target': "a per-member deny never cuts its target's same-stratum operations ([RV I5])",
  'no-witness': 'no witnessing: every candidate is void ([RV C3])',
  'any-witness':
    'every later event of another identity is a witness (the original O7-absent failure)',
  'code-revival': 'code death is not sticky ([RV M7])',
  'growing-k': 'cascade uses k* from the cuts above the stratum only',
  'uses-stale': 'uses() does not require that the deny takes away something still held',
  'shared-vc':
    "cascade protection read from one view that drops every cause's future (revision 2; [R2V C1])",
  'equal-join':
    'joins and non-member targets protected only when ranked strictly above (revision 2; [R2V C2])',
  'kickless-withdraw': 'a withdrawal cuts a join without Kick ([R2V C2])',
  'revoke-on-chain':
    'device_revoke on the identity chain and no rotation exemption (revision 2; [R2V C3])',
  'rot-watermark':
    "a rotation's watermark checked only for live devices ([H7], found in the r3 work)",
  'member-sigs': 'upgrade countersigned only by owners who are members (revision 2; [R2V C4])',
  'hash-codes': 'a code revocation kills every code with the same hash (revision 2; [R2V I1])',
  'owner-exempt': 'owners exempt from W3 (revision 2; [R2V I3])',
  'late-exposure': 'exposure read with the decisions made after the operation (revision 2; [H8])',
  'kstar-cuts-only': 'k* ignores concurrent senior denies of the author (revision 2; [H9])',
  'attrib-r3': 'cascade attribution by label unions (revision 3; [R3V C1])',
  'world-flat':
    "an earlier op counts in a world without intersecting it with that op's own exposure (§3.1 step 4)",
  'fallback-flat':
    "the class-cap fallback counts an earlier cascade cut even if its world is not inside the op's (§3.1 step 4)",
  'anchor-r3':
    'W3 backlog anchored at the newest event of another identity (revision 3; [R3V I1], [R3V I3])',
  'no-day': 'no W3(b) day budget for unacknowledged events ([R2V I2], [R3V I1])',
  'deny-breadth':
    'every deny exempt from W3, also bans of never-seen principals and role moves (revision 3; [R3V I2])',
  'rot-noop': 'no W6 guard for primary_rotate (revision 3; [R3V M2])',
  'id-churn': 'no per-identity cap on device_adds and rotations ([R3V I2] class)',
  nonmono:
    'authority read in one view V_o(K ∪ N) for resources and obstacles (revision 4; [R4V C1])',
  'clamp-r4':
    "the author's rank clamped to min(rank under K, rank under K ∪ N), not the position hull (the r4 review's proposal; [R4V C1])",
  'cutdeny-stays':
    'a cut deny keeps its effect on the obstacles of operations that relied on it (revision 4; [R4V M2])',
  'tail-witness':
    "events past their device's revocation watermark may witness (revision 4; [R4V C2]: its tail drop rule is then not inert)",
  'revoke-any':
    'every admitted device_revoke counts for the witness watermark, also a void one (first revision-5 draft; reopens O7-absent)',
  'day-r4':
    'W3(b) unacknowledged day budget 4 × the hourly cap (revision 4; [R4V I2]; dead code since dispatch 5b, not applicable: model.ts reads it only inside the `day-window` branch, so ACL_MUT=day-r4 runs the unchanged model; its defect is `day-window`)',
  'epoch-churn':
    'device_adds counted per epoch, so a rotation resets the allowance (revision 4; [R4V I2])',
  'no-fresh': 'no W3(d) fresh-device limits (revision 4; [R4V I2])',
  'class-region':
    'protection classes counted over the whole region and Γ with causes that cut nothing (revisions 4 and 5a; [H16])',
  'day-window':
    "W3(b) as dispatch 5a's unacknowledged day window instead of a total ([H17], controller ruling on growth)",
  'w3b-mod': 'the W3(b) total counts only non-exempt events, so moderation is uncounted ([H18])',
  'id-totals-off': 'no W3(c) total of unacknowledged rotations (the day cap alone; [H17])',
  'no-rot-evidence': 'two rotations with one iprev are not evidence ([H17])',
  'intro-x': 'a device is a candidate only if every introduction is in X (dispatch 5a; [H17])',
  'drops-all':
    "a rotation in X is in force and drops every device; the orphan rule's X exclusion off ([H17])",
  'class-proj-off':
    'protection classes and the fallback test not projected onto G(q), X ops counted ([H17] (c))',
  'sybil-join':
    "no W3(e): a join through a non-owner's add needs no third identity's acknowledgement ([H18])",
  'orphan-5a':
    "storage: dispatch 5a's orphan rule (X events past F(dev) only, never identity ops; [H17])",
  'rot-same-iprev':
    'rotation evidence only for two rotations with the same iprev, not any two concurrent ones ([H19])',
  'no-race':
    'a non-rotation identity op over the iprev of a rotation of its identity is no evidence ([H19])',
  'fi-all':
    'storage: the orphan rule also keeps FI of epochs whose rotation is contested ([H19]; equivalent since [H20]: headers count as identity evidence)',
  'pool-off': 'no W3(g): no identity pool at admission, no pool candidates (dispatch 5b-i; [H20])',
  'pool-cap-off':
    'W3(g) without its admission part: one view may hold more than poolU unacknowledged events ([H20])',
  'ghost-dev':
    'headers of dropped events count as device evidence only; the orphan rule keeps the events defining FI and RF ([H20])',
  'pin-ok':
    'no W3(f): an identity may cite its own unacknowledged evidence pairs and pin them ([H18])',
  // revision 6 (the r5 review)
  'revoke-pool':
    "a device_revoke can be a pool candidate, so a thief's sibling flood voids the revocation of the stolen device (revision 5; r5 review C1 (c))",
  'ap-uncapped': 'more than 10 ACL parents admitted (revision 5; r5 review M2)',
  'fast-ghost-dev':
    "fast.ts counts kept headers as device evidence only, not as identity, rotation and pool evidence (revision 5's fast.ts; r5 review I1)",
  'work-bound':
    'the ruled I3 (b) work bound, not adopted: a stratum takes the fallback above (2^classes + 1) × |Fl \\ (X ∪ Tail)| > work, which a junior can switch (§10.16; revision 7 lowers CLASSES instead)',
  // revision 7 (the controller's rulings on r6.1 and r6.2; `pool-pre-f` of revision 6 is now the rule)
  'pool-all':
    "P(x) counts every concurrent event of the identity, also those past their device's fork point (revision 6; C1 (c) open)",
  'pool-drop':
    'the orphan rule drops candidates that are candidates only by pool evidence (revision 6), which is unsound once P(x) counts only events before their fork points (poolmono)',
  'keep-headers':
    "every dropped event keeps its header, also events past their device's fork point (revision 6; C1 (a) open)",
  'bare-idops':
    "identity ops past their device's fork point are dropped without their headers too (the ruling's literal reading; a later rotation loses its rotation evidence)",
  'fast-bare-anc':
    "an event that a kept header has in its past may go without its header, so the header's place in the causal order is lost (fast.ts, like a replica, knows it only through ap)",
  'cite-cands':
    'honest clients cite every head, candidates, X and Tail events included (revision 6; the flood is stored in full)',
  'cite-no-upgrade':
    "honest clients don't cite an upgrade in X either, so the old server never freezes (the client rule without its upgrade exception)",
  'fast-prune-pool':
    "fast.ts's witness search stops at an event in whose state the candidate is only a pool candidate (revision 6's pruning; unsound once pool candidacy can end, r7.9)",
  'fork-parent':
    'the proposed admission rule of r7.6, not adopted: an event is refused when a parent is a device-fork candidate in St(e) (it refuses honest clients citing an upgrade or a rotation, and does not close layering)',
  // r7b
  'duel-join':
    "not adopted: a duel ban's target's racing join is exposed at rank <= kk, as protectedTarget let the ban take effect (makes G6's old wording true, but after a later unban the add that join consumed becomes usable again and the device it introduced is gone; r7b, §10.17)",
  // r7c
  'class-proj-g':
    "protection classes projected onto each op's own G(q), which its author picks with its parents (revisions 5–7; r7 re-review C1: pclass, jclass)",
  'fast-hdr-parents':
    "fast.ts reads a header's past through its maximal indexed ancestors without the ancestor test (only those events themselves), so an identity op below them looks concurrent (r7c header read, r7 re-review I1 (b))",
  // revision 8
  'v2-limits':
    "a rules-2 genesis's `limits` field is read (an older client ignores it: the state splits silently; C3)",
  'lim-unranged': 'rules-3 limits are not checked against their ranges (C3)',
  'fast-h2-deny':
    'the second head-path case also when an event concurrent with the arrival is a deny (§5.5)',
  'fast-h2-agree':
    'the second head-path case without the agreement test of Eval(S) and St(e) on C(ap) (§5.5)',
  'fast-h2-sameid':
    "the second head-path case also when an event of the arrival's identity is concurrent with it (§5.5)",
  'b3-off':
    'no protection rules: creation records, chains, the void rule, signer checks at evaluation, key and epoch death all off (§2.5)',
  'b3-v2':
    'the recovery-key rules also on rules-2 servers, where an older client reads `rk`, `chain` and `by` as unknown fields (§1.2)',
  'b3-any-signer':
    'an identity record (rotation, certificate, revocation) is admitted whatever key it names as its signer (§2.2 A1, §2.5)',
  'b3-drop':
    "the orphan rule drops the events of an identity with a creation record by any candidacy, not only past their device's fork point (§2.3, §2.5)",
  'b3-epoch-alive':
    'no epoch death for revocations: a revocation signed by a stolen primary concurrently with the recovery stays in force (§2.5)',
  'b3-dev-signer':
    "records whose signer their own position doesn't allow are not made inert at evaluation (§2.5; fix round 2: equivalent, the evaluation repeats admission's check on the same chain records)",
  'b3-two-cr':
    'a join whose creation record differs from the one its position knows is admitted (the refusal-only path; the void rule then makes the identity unprotected, §2.2, §2.5)',
  'b3-key-alive':
    'no key death: a record signed by a recovery key that a reset or removal replaced stays valid, in the chain and in the server (§1.7, §2.5)',
  'lim-open':
    'rules 3 accepts unknown `limits` keys, so a later key splits clients silently (r8 review M2; §1.2)',
  'b3-inert-noevidence':
    'an inert rotation is no rotation or race evidence at all, so a record arriving later uncontests what it contested before (r8 range N, seed 13888618; §2.5)',
  // revision 8, fix round 2 (the controller's rulings on the r8b reviews)
  'b3-void-off':
    "no void rule: a creation record stays in force beside a record its identity key signed, or beside a second creation record, so a thief holding a legacy identity's ik mints protection for it (§2.5)",
  'b3-chain-off':
    "introductions and rotations carry no chain: every identity starts at its creation record, so a restored identity's join (certified by its new primary) is refused and a thief holding the epoch-0 primary joins new servers (§1.1, §2.5)",
  'b3-branch-alive':
    "a record made under a chain record that chain key death killed stays valid (a leaked old phrase's recovery branch keeps its devices after the reset, §1.7, §2.5)",
  'b3-rival-ok':
    "rival resets don't equivocate the chain: r8b's mutual kill, which falls back to the key both replaced, so the leaked old phrase is alive again (§1.7, §2.5)",
  'b3-ext-any':
    'an extension may be signed by any primary and keep any device, also without a new chain record (§2.5)',
  'b3-cert-alive':
    "no epoch death for certificates and extensions: a stolen primary's certificate concurrent with a later chain record stays valid with its device's events (§2.5)",
  'b3-epoch-rk':
    "epoch death also kills a revocation signed by a recovery key (r8b's rule): the disowning flow with the phrase can't reach before the latest recovery (r8b review I1; §2.5, §3.9)",
  'b3-add-head':
    "a join through adds that name the invitee's chain head needn't reach it (§1.1, §2.2)",
  'b3-reset-pk':
    "a reset keeps the old primary (as first drafted): a thief holding it posts the reset as an extension at an early position, and key death kills the user's records signed by the replaced key (§1.7, §2.5)",
  'lim-proto':
    'the `limits` key check reads the prototype chain (`in`), so names like `toString` or `__proto__` pass as known keys (r8b review I5; §1.2)',
  // revision 8, fix round 3 (the controller's rulings on the r8c reviews)
  'b3-sh-off':
    "two carriers of one chain record contest each other (fix round 2): with two of the user's devices posting a recovery unwitnessed, both are in X and the stolen device acts (ruling 2; §2.3, §3.9)",
  'b3-sh-any':
    "carriers of one head are siblings whatever device posts them and keeps (no in-keep bound): a holder of the head's keys mints uncontested devices beyond devCap (ruling 2)",
  'b3-sh-drop':
    "siblings drop each other's devices: a fresh recovering device is revoked for good by the other device's extension (ruling 2; §3.9)",
  'b3-void-revives':
    "rival resets void the creation record as in fix round 2 (every record not signed by ik inert): the user's removals lose their cuts and a dropped device's backdated acts count (ruling 3; §2.5)",
  'b3-void-grants':
    "a frozen identity's grants under either rival branch count, and the rival records kill nothing (ruling 3; §2.5)",
  'b3-void-member':
    'a frozen identity stays a member with its devices in the final state (ruling 3; §2.5)',
  'b3-void-admit':
    'an event of a frozen identity whose past holds both rival carriers is admitted (ruling 3; §2.2)',
  'b3-upgrade-alive':
    "an upgrade never dies by §2.5's deaths: a stolen owner device's backdated upgrade freezes S after the owner's recovery (ruling 5; §3.8)",
  'b3-migrate-mem':
    "a rules-3 S' takes membership from `migrate` (option A), so a member listed there is one before its own join (ruling 5; §1.5, §3.8)",
  'b3-ext-keep':
    'with two same-n heads an extension keeps any device (the keep limit only with a single head, as in fix round 2; attack review M2; §2.2)',
  'b3-rec-fields':
    'a chain record with an unknown field is accepted, so one record has two encodings (attack review M4; §1.7)',
  // revision 8, fix round 4 (the controller's rulings on the r8d reviews)
  'b3-upg-rot-off':
    "an upgraded S refuses every rotation (fix round 3): the user's reset never reaches it, and a leaked old phrase positioned before the upgrade revives S and takes the owner (ruling 1; r8d attack review C1)",
  'b3-upg-rot-mem':
    "an upgraded S admits a rotation carrying new chain records only from members (the reviewer's point 1 as written): a genesis owner that left before signing can't post its reset there (ruling 1)",
  'b3-sigchain-off':
    "an upgrade signature's carried chain records are checked but never join S's chain (fix round 3): a co-owner's reset carried in its signature leaves the old phrase alive in S (ruling 1)",
  'cite-rival':
    "honest clients cite a rival-reset carrier even in X (fix round 3's exception): they acknowledge whatever the old-phrase holder put in its past, so it picks which sibling of a third identity's unacknowledged fork counts (r8d completeness review I1)",
  'frozen-acts':
    "a frozen identity's own client keeps posting where nobody cites the rival, and its events are admitted there (r8d completeness review I1, the verifier's F1)",
  'b3-reach-desc':
    "a join reaches a named head only when it is an ancestor of the join's chain head (fix round 3): an add naming the other one of two reconciled same-n records refuses the user's join with its full chain (r8d attack review M5)",
  'b3-link-frozen':
    "linkOf tests the freeze after the pending branch: a frozen identity's fresh device gets an ACL-only link once an owner invites it again (r8d attack review M4; §3.7)",
  'b3-migrate-frozen':
    "projectMembers carries an identity frozen in B(u) unprotected (§3.8 step 4 of r8d read literally): the carry-over adds it and a join as it is possible in S' (r8d completeness review I5)",
  // fix round 3 (ruling 10): the contacts reference (contacts.ts; vectors only, the fuzz has no contacts)
  'ct-none-default':
    "a contact stored from a source without a creation record is none (fix round 2): a stripped card pins the thief's device and refuses the user's record (ruling 7; attack review C1)",
  'ct-qr-none':
    "a QR or safety-number check pins a creation record over none (the attack reviewer's first fix): a hot-ik thief protects a legacy identity in place (ruling 7)",
  'ct-badge-nohead':
    "badges aren't checked against heads (fix round 2): a stolen old primary's badge shows for the user after the recovery (completeness review I3)",
  'ct-succ-fifo':
    'the succession claims list is FIFO: a thief holding a legacy ik pushes out the genuine claim (ruling 6)',
  'ct-succ2-dead':
    "a v2 succession ignores key death and the head's validity: a leaked old phrase claims a move after the reset (ruling 6)",
  'ct-record-truncate':
    "the account's identity record accepts a PUT that drops records without re-auth: a stolen session truncates the chain (ruling 9)",
  // fix round 4 (rulings 3 and 4; completeness review I2, I3, M1; attack review M3, M6): the contacts reference
  'ct-backup-evict':
    "the instance keeps only the last 3 backup versions (fix round 3's module): three uploads from a stolen session flush every good version (ruling 3; completeness review I2 (a), attack review M3)",
  'ct-backup-size':
    "a backup PUT over the account's total evicts the oldest versions instead of being refused (ruling 3)",
  'ct-cr-unbounded': 'pending creation-record claims are unbounded (completeness review I2 (b))',
  'ct-server-pins':
    'a contact created from a server source pins its creation record (completeness review I2 (c))',
  'ct-restore-first': 'restore tries only the first id it is given (completeness review I2 (d))',
  'ct-restore-frozen':
    'restore of a frozen identity keeps fetching for ever instead of offering the move (ruling 3; completeness review I2 (d))',
  'ct-succ-nohold':
    "a v2 succession at an unknown contact, or naming a head the contact doesn't hold yet, is refused instead of held (ruling 4; completeness review I3)",
  'ct-succ030-refuse':
    'a 0.3.0 succession v1 (no new_cr, signed by the new ik) is refused instead of shown as a legacy claim (ruling 4)',
  'ct-held-unbounded':
    'an unknown contact holds any number of unverified chain records (attack review M6)',
  'ct-two-cert1':
    'two distinct v1 certificates are no proof that ik is in use (completeness review M1)',
  'ct-succ1-proof': 'a succession v1 is no proof that ik is in use (completeness review M1)',
  'ct-succ-nodedupe':
    "succession claims aren't deduplicated by (old, new) (completeness review M1)",
  // fix round 5 (the controller's ruling 5): contacts.ts
  'ct-acc-keep':
    "an accepted, unverified move whose head or key a later record kills is kept silently (fix round 4): an old phrase's move accepted before the reset outlives it (r8e attack review I4)",
  'ct-succ-chain-drop':
    "a v2's carried chain is only read, and a claim whose head isn't held yet counts as dead (fix round 4): V's move with its chain is dropped when its records then arrive one at a time (r8e attack review M1)",
  'ct-held-block':
    "held (unchecked) v2 claims past the cap refuse the newer one (fix round 4): four strangers' claims block V's genuine move (r8e attack review M2)",
  'ct-held-forever': 'held v2 claims never expire (r8e attack review M2)',
  'ct-cr-nodedupe':
    "creation-record claims aren't deduplicated: the same record from a hello and a card makes two claims with the impersonation warning (r8e completeness review M5)",
  'ct-restore-rank':
    'restore ranks keep-fetching above the move: a frozen id beside a stale one keeps fetching (r8e completeness review M5)',
  'ct-safety-two':
    "with two pending claims the safety screen shows the first claim's number (r8e completeness review M5)",
  'ct-backup-nodelete':
    "no per-version delete (fix round 4's module), though the 'Backup full' copy depends on it (r8e completeness review M5)",
  // fix round 5 (the controller's rulings on the r8e reviews): the model's rules
  'b3-upg-any-carrier':
    "an upgrade's signatures die through every carrier of a later record (r8e): a stolen device of a later epoch undoes a transfer with an extension concurrent with it, and a sole owner's thief posts its own (ruling 2; r8e attack review C1)",
  'b3-upg-intro-any':
    "an upgrade reads its author device's introductions with the full deaths (the r8e attack reviewer's fix, signatures only): a later-epoch extension concurrent with the author device's device_add undoes the transfer (ruling 2; the C1 verifier)",
  'holds-dormant':
    "a rejoin revives the roles of a membership a cascade cut (r8e): a pending identity's concurrent rejoin makes a stratum-2 ban of it ineffective (ruling 6; r8e attack review I5, seed 91,025,433)",
  'link-push-off':
    "no push link (r8e linkOf): a non-member's posting, a left identity's, and a phrase-only restore's rotation have no link (ruling 4; r8e attack review I3, completeness review C1)",
  'link-push-trust':
    "a push link for any device presenting new records, whether or not the new head trusts it: a device certified under a replaced primary pushes the user's records (ruling 4)",
  'link-push-ban':
    "a banned identity gets no push link: the posting at a ban's parents never arrives (ruling 4)",
  'link-pending-fresh':
    "a pending identity's ACL-only link only for a device the state never introduced (r8e): a kept device that S introduced before can't rejoin, nor a re-invited member whose join a cascade cut (ruling 4; the C1 verifier)",
  'holds-any-join':
    "Holds through any live join of the target in the assign's past, an earlier membership's included (the cut-off first attempt at fix round 5): the join of a membership a leave ended revives the roles of a later membership a cascade cut, also in a view that doesn't hold that leave as effective yet (ruling 6)",
  'push-accept-any':
    'a push link accepts any event of the identity: a kick, a plain join, a rotation carrying nothing new (ruling 4)',
  // fix round 5 (ruling 1): one mutant per client-rule bullet (client.ts)
  'cl-left-latest':
    "the left bullet at the identity's latest leave or removal in the state (§1.7 of r8e as worded): a thief that rejoins, acts and leaves again keeps its acts (ruling 3; r8e attack review C2)",
  'cl-left-moves':
    "the recorded leave moves to a later leave the client's own device signs while the server is on its list: the posting then sits after a thief's rejoin and acts (ruling 3; the C2 verifier's 'never moves')",
  'cl-flow-order':
    "the flow lets the phrase go before the owned servers are posted: their carriers are extensions, and a stolen old device's backdated transfer counts (ruling 2: the flow signs for every owned server while the phrase is at hand)",
  'cl-rejoin-first':
    "the user's rejoin of a server on its list goes first, on the heads, without the rotation at the recorded leave: what a dropped device did since the leave stays (ruling 3)",
  'cl-left-heads':
    'no precedence for the left bullet: once a stolen device rejoined, a server the identity left gets the member or upgraded bullet (ruling 3; r8e attack review C2)',
  'cl-upg-atleave':
    'the left bullet ignores an upgrade the client signed: a co-owner that left before signing undoes its own transfer (ruling 3; r8e attack review I1)',
  'cl-upg-heads':
    "the archived-S posting on the heads (r8e): an old phrase's records that arrived first drop its poster or fill its day cap, and the thief revives S (ruling 3; r8e attack review I2)",
  'cl-member-heads':
    'the member posting on the heads (r8e): the old phrase that acted first keeps the identity in a live server (the I2 verifier)',
  'cl-older-heads':
    "the older-epoch posting on the heads instead of at the thief's introduction: what the thief's device did meanwhile stands (§1.7)",
  'cl-older-nojoin':
    "a rotation at an introduction whose chain branch the client's records kill, instead of the join beside it (the cut-off first attempt): the rotation kills the join the membership rested on, and the user is out of a server it was invited to, or owns (§1.7: 'so the identity stays a member')",
  'cl-trust-nojoin':
    "records of the identity the client didn't make stay untrusted after its own join settled them (the cut-off first attempt): after its own rejoin the client's next posting sits before that join, where it is no member, and is refused",
  'cl-keep-poster':
    'the poster in its own keep (§1.7 of r8e as worded): the posting is refused (auth) and the thief takes over (ruling 3; r8e completeness review C2)',
  'cl-owned-ext':
    "extensions where the identity is a genesis owner: a stolen old-epoch device's backdated upgrade survives the user's carrier (ruling 2's client rule; r8e attack review C1)",
  'cl-wm-noleave':
    "the left posting's watermark of the device that made the leave doesn't cover the leave: the leave is in Tail (ruling 3)",
  'cl-no-revoke':
    "no revocations at a join that brings a new head (fix round 3's ruling 4; as ACL_GEN_NOREVOKE)",
  'cl-poster-dropped':
    'the maker posts even where it is revoked or dropped: its posting has no link, or is refused (ruling 3; r8e attack review I2)',
  'cl-fresh-unkept':
    "the fresh fallback poster is neither kept by the record nor posts an extension: it signs with the recovery key outside the record's keep (r8e completeness review M1)",
  'cl-no-sweep':
    "no start-up sweep: a crash between a join and its revocations leaves the old device live, and an owned server whose only carrier is an extension keeps a stolen device's backdated upgrade (ruling 1)",
  'cl-join-heads':
    "a join ignores an add naming a head its chain doesn't reach and goes on the heads: it is refused (fix round 3, completeness review I5; ruling 1)",
  'cl-join-nochain':
    "a join carries the creation record without the chain: refused where an add names the head, and in S' the user is locked out (ruling 1)",
  'cl-n26f-heads':
    'the N26 (f) repair on the trusted heads instead of at the dead record: what the dead record disowned counts again (ruling 1; fix round 3, attack review I2)',
  'cl-owned-join':
    "after a join of its own that carried the head into a server it owns, the client posts no carrier signed by the recovery key until the next start-up sweep: a stolen old primary's fresh device rejoins and transfers, positioned before that join, and the transfer counts (ruling 2: every chain posting in an owned server is signed by the recovery key; found by a probe at the second restart)",
  'cl-reset-unfetched':
    "a reset made without fetching the identity's head in the flow: two of the user's devices make rival resets and freeze it (ruling 1; r8d attack review M2)",
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
      'vectors-r2.test.ts',
      'vectors-r8.test.ts',
      'vectors-r8d.test.ts',
      'vectors-r8e.test.ts',
      'vectors-r8f.test.ts',
      'contacts.test.ts',
      'fixtures.test.ts',
    ],
    { cwd: dir, env, stderr: 'pipe', stdout: 'pipe' }
  )
  const out = t.stderr.toString() + t.stdout.toString()
  const failed = [...out.matchAll(/^\(fail\) (.+?) \[/gm)].map(
    x => x[1].split(' > ').pop()!.split(':')[0]
  )
  const f = Bun.spawnSync(['bun', 'fuzz.ts', String(fuzzN), String(fuzzStart), String(workers)], {
    cwd: dir,
    env,
    stdout: 'pipe',
  })
  const fo = f.stdout.toString()
  const fj = JSON.parse(fo.slice(0, fo.lastIndexOf('}') + 1))
  // fix round 3 (ruling 11): the B3 mutants also get a forced-template pass (tplN seeds per b3 template on rules 3),
  // and the table names the properties other than O15-oracle that kill a mutant (a kill by the oracle alone isn't one
  // by behaviour)
  let tcol = ''
  const randomProps = Object.keys(fj.byProp)
  const all = new Set(randomProps)
  if (
    tplN > 0 &&
    (m.startsWith('b3-') ||
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
    `| \`${m}\` | ${what} | ${failed.length ? failed.join(', ') : 'none'} | ${fj.failedCases}/${fuzzN} ${randomProps.join(', ')} | ${tcol} | ${behaviour.join(', ') || 'none'} |`
  )
  console.error(rows[rows.length - 1])
}
console.log(
  '| Mutant | Change | Vectors that fail | Fuzz cases failing (properties) | Forced b3 templates failing (properties) | Properties other than O15-oracle |\n|---|---|---|---|---|---|\n' +
    rows.join('\n')
)
