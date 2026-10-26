# XMR20 unshielded-by-default candidate — security review

**Date:** 26 October 2026  
**Candidate:** `<workspace>/research/token-format-unshielded-20261025`  
**Review type:** AI second pair of eyes. **This is NOT an independent audit.**

## Verdict

**Do not use this build for a real-funds mainnet pilot.** The supplied suites passed on reproduction, but targeted review found **nine additional issues: two HIGH, five MEDIUM and two LOW**. The two high findings undermine bridge payout controls. Other findings concern parameter authentication at the wallet-library boundary, concurrent wallet journal writes, reservations during a partial private transfer, fragment resource use, test isolation and fee presentation.

No accepted public-value forgery, shield/unshield inflation or new direct native output-to-key-image disclosure was demonstrated. This is a bounded result, not a proof that those attacks are impossible. No CRITICAL finding was established; absence of such a finding is not a security guarantee.

Before a mainnet pilot, fix and regression-test the applicable findings, settle the replay-snapshot question below, and obtain an external human review of the cryptographic composition and wallet implementation. Bridge payouts and marketplace settlement still have the documented rollback-loss limitations. Those require a justified design/policy decision and review; these tests do not remove them. The Penumbra ceremony transcript remains independently unverified; published key-byte/hash/ID checks were performed. This candidate uses published Penumbra ceremony keys, **not** the earlier disposable XMR20 circuit setup.

No fixes to candidate behavior were made. No deployment, merge, push, production wallet operation, real-funds operation or stagenet test was performed. New review scripts and documents are under `review/`; required builds and offline suites also wrote their normal candidate-local outputs. A baseline comparison of 134 existing source/document files found zero changed or missing files. The test-isolation incident below is an exception to the intended isolation of runtime effects and must not be omitted from a handoff.

### Finding summary

| ID | Severity | Finding | Evidence level |
|---|---|---|---|
| H1 | HIGH | A previous incident suppresses a later paid-without-burn halt | Unchanged operator, synthetic receipts/scans and durable journal |
| H2 | HIGH | Unresolved submitted payouts bypass the payout-window cap | Unchanged operator, supported post-submit interruption and synthetic receipts |
| M1 | MEDIUM | SDK authenticates manifest bytes but operates on another object | Real wasm and public parameter files; synthetic root/RPC responses |
| M2 | MEDIUM | Journal lease allows two successful reservations and a lost write | Actual journal module, real encryption and controlled storage interleaving |
| M3 | MEDIUM | Refusal of part B releases token reservations for a pending operation | Actual reservation exports and a reproduced publisher state transition |
| M4 | MEDIUM | Duplicate private fragments accumulate and distort the pending count | Actual Rust pool; bounded synthetic fragment sequence |
| M5 | MEDIUM | Offline backend can attach to and modify another test daemon | Observed during the initial supplied-suite run; source inspection |
| L1 | LOW | Parameter streams are unbounded before pinned-length rejection | Bounded 64 KiB synthetic stream, no OOM attempt |
| L2 | LOW | Approval text truncates the exact network fee | Actual formatter and approval-path inspection |

Severity reflects the affected control and plausible consequence, not an assertion that funds were lost during review. HIGH here means a material failure of financial safety controls under the stated preconditions. H2 demonstrates an exposure-cap bypass, not a theft, duplicate payout or reserve shortfall. MEDIUM findings principally affect integrity, recovery or availability. LOW findings have narrower demonstrated impact.

## Reproduction and evidence

The handoff, README, DESIGN, RESULTS, RELEASE-NOTES and MIGRATION-CUTOVER were read before focused code review. Official reproduction preceded reliance on the reported outcomes. All chain execution for this review was offline fakechain, not public stagenet. All wallet material used by review tests was synthetic.

### Supplied builds and suites

| Reproduction | Result | Evidence under `review/reproduction/` |
|---|---|---|
| Core release tests, offline | 10/10; 3.22 seconds test time | `core-test.log` |
| Format release build, offline | Success | `format-build.log` |
| Holder wasm release build, offline | Success; correct target path rechecked | `holder-build.log`, `holder-build-recheck.log` |
| Local review extension build | Success | `extension-build.log` |
| Supplied `flow.test.mjs` | 1/1; approximately 111 seconds | `flow-test.log` |
| Supplied parts/rollback assertions, isolated endpoints | 1/1; approximately 197 seconds | `parts-isolated-final.log` |
| Supplied real-popup assertions, isolated endpoints/profile/build | 1/1; approximately 149 seconds | `browser-isolated-final.log` |

The Node counts are broad test cases, not counts of independent security properties. Initial failed attempts are retained. In particular, the original parts run failed with an HTTP port collision and exposed M5. Two earlier isolation-hook attempts failed on Node module loading before starting their daemon; they do not constitute protocol failures.

The isolated copies preserve the supplied assertions. `review/reproduction/prepare-isolated-suites.mjs` adapts imports, module-root references, endpoints and the review-extension location. The parts run uses RPC/P2P/HTTP ports 31131/31130/18991; the browser run uses 31041/31040/18940. The extension is a disposable review build, not the installed wallet. The substitutions are review infrastructure, not fixes to candidate behavior.

Commands, from the candidate directory, with the existing toolchain/dependencies:

```sh
export CARGO_TARGET_DIR="$PWD/target"
(cd core && <home>/.cargo/bin/cargo test --release --offline)
(cd format && <home>/.cargo/bin/cargo build --release --offline)
(cd holder-wasm && CARGO_TARGET_DIR="$PWD/target" <home>/.cargo/bin/cargo build --release --offline --target wasm32-unknown-unknown)

XMR20_PRIVATE_HOLDER_TEST=local \
XMR20_EXTENSION_OUTDIR="$PWD/review/reproduction/extension" \
XMR20_EXTENSION_REVIEW_OUTDIR="$PWD/review/reproduction/extension-review" \
node --import ./review/reproduction/isolate-ports.mjs wallet-extension/build.mjs

node review/reproduction/prepare-isolated-suites.mjs
node --test flow.test.mjs
node --test review/reproduction/parts-rollback.isolated.test.mjs
node --test review/reproduction/browser-flow.isolated.test.mjs
```

**Before any further backend run, check its actual ports are unused.** The original flow command also needs this check. Do not start the unmodified parts or browser suites alongside other test services. A preflight check reduces the chance of collision; it is not the durable ownership fix recommended in M5.

### Additional review tests

```sh
node --test review/bridge-params/operator-security-repro.test.mjs \
  review/bridge-params/parameter-security-repro.test.mjs \
  review/wallet-privacy/journal-race.test.mjs \
  review/wallet-privacy/reservations-and-fees.test.mjs

CARGO_TARGET_DIR="$PWD/target" <home>/.cargo/bin/cargo test --release --offline \
  --manifest-path review/public-crypto/Cargo.toml -- --nocapture
```

The Node reproductions passed **7/7** in approximately 206 ms. The Rust review tests passed **7/7** in 1.87 seconds of test time. These are small, bounded local tests; the additional Node tests start no daemon or network service. Tests named REPRO deliberately assert the defective behavior. Their passing status means **the defect was reproduced**, not fixed.

Primary logs are `review/reproduction/additional-node-tests.log` and `review/public-crypto/parent-test-complete.log`. Earlier reviewer harness/compiler/assertion mistakes remain in intermediate logs and are not counted as candidate vulnerabilities.

### Scope incident during the initial unmodified parts suite

The suite attempted to start its own fakechain on RPC 30131 while a different chat's offline test daemon already occupied that port. The new daemon failed to bind, but backend readiness accepted the existing daemon because it reported `fakechain` and `offline`. The backend then reached its automatic 250-block startup mining step against that other offline chain before failing to listen on HTTP 8991. The other chain was advanced; the review did not intentionally request or repeat this cross-candidate mutation.

The failed suite remained pending and was stopped by terminating only its identified review-owned processes. The other chat's daemon, existing owner wallet session and stagenet node were left running. The remaining official suites were rerun using distinct reviewed endpoints. There was no real-chain or real-funds effect. The original failure log is `review/reproduction/parts-rollback-test.log`; it records the HTTP collision and cancellation, while the startup code and runtime inspection identified the prior attachment/mining. This incident is M5 and prevents an unqualified claim that every runtime effect remained within the review candidate.

## HIGH findings

### H1 — Earlier incident suppresses a later paid-without-burn halt

**Location:** [backend/operator.mjs:65](<workspace>/research/token-format-unshielded-20261025/backend/operator.mjs:65); preceding reorganisation handling at [line 62](<workspace>/research/token-format-unshielded-20261025/backend/operator.mjs:62).  
**Claims:** 10, incident handling after payout.  
**Preconditions:** The same burn has an earlier reorganisation incident, the operator explicitly resumes, the burn is paid, and it later leaves canonical history.

The code tests whether **any incident with this txid** exists before both recording `paidWithoutBurn` and setting `halted = true`. A prior `burnReorganised` incident therefore suppresses the required later halt as well as the new event.

**Reproduction:** Run the first test in `review/bridge-params/operator-security-repro.test.mjs`. It imports the unchanged operator and supplies synthetic scans, a receipt stub and its real durable journal:

1. Observe a burn at height 10 with tip 19.
2. Observe the same burn at height 11 with tip 20; verify the pause and `burnReorganised` incident.
3. Explicitly resume and pay the burn.
4. Reconcile a canonical scan containing no such burn.

**Observed:** One actual synthetic payout; zero remaining burn confirmations; `halted === false`; no `paidWithoutBurn` incident. The journal contains the earlier reorganisation event and explicit resume. The parent reproduction is preserved in `review/bridge-params/evidence-operator-tZW91U/journal.json` and the additional Node log.

**Impact and limit:** The loss-detection control fails after a legitimate resume, leaving payouts open when the paid burn disappears. This is an implementation defect beyond the already documented inability to reverse a deep-reorg payout. No additional payout or quantified additional loss was exercised by this test.

**Suggested fix:** Always latch and persist the halt when a paid burn is absent, independently of event deduplication. Deduplicate events by incident kind and txid, not txid alone. Add regressions for this sequence both within one process and across journal reloads. The halt limits subsequent exposure; it cannot recover the already-paid amount.

### H2 — Unresolved submitted payouts bypass the payout-window cap

**Location:** [backend/operator.mjs:51](<workspace>/research/token-format-unshielded-20261025/backend/operator.mjs:51), payout admission/submission at [line 79](<workspace>/research/token-format-unshielded-20261025/backend/operator.mjs:79).  
**Claims:** 10, exposure limits and interrupted payouts.  
**Precondition:** A payout succeeds in custody but execution is interrupted before the operator records `paid`; other payout requests are then processed before resolving that receipt.

`paidInWindow()` counts only `status === 'paid'`. The operator persists `submitting` before calling custody. A successful submission followed by the candidate's supported `afterSubmit` interruption leaves paid value outside the cap calculation. Receipt recovery is performed for the requested txid, not all unresolved submissions before admitting unrelated payouts.

**Reproduction:** Run the second operator reproduction. Configure a single-payout cap of 100 and window cap of 200. Reconcile three confirmed burns of 100. Let custody pay the first, inject `afterSubmit`, then pay the other two without first recovering the first receipt.

**Observed:** Actual synthetic payments total **300**; the window calculation reports **200**; statuses are `[submitting, paid, paid]`. Evidence is `review/bridge-params/evidence-operator-EvjKYo/journal.json` and the additional Node log.

**Impact and limit:** The financial exposure control can be exceeded without a reorg. This test uses a synthetic post-submit exception, **not** a demonstrated remote HTTP lost reply or process restart. The receipt stub rejects duplicate nonces. It demonstrates neither duplicate payment, inflation nor reserve shortfall. HIGH is assigned because a configured financial safety boundary is bypassed; the immediate demonstrated effect is accounting/control failure.

**Suggested fix:** Durably reserve exposure before submission and include unresolved reservations in admission checks. Serialize each asset's cap check and reservation. Reconcile outstanding custody receipts before admitting further exposure; release a reservation only after definite failure, not uncertainty. Test crashes, lost replies, concurrent calls and journal reloads. Keep the distinction between a payout-rate limit and a proven bound on arbitrary rollback losses.

## MEDIUM findings

### M1 — Wallet library authenticates bytes but uses another manifest

**Location:** [wallet-lib/token-wallet.mjs:33](<workspace>/research/token-format-unshielded-20261025/wallet-lib/token-wallet.mjs:33), operational uses at [line 37](<workspace>/research/token-format-unshielded-20261025/wallet-lib/token-wallet.mjs:37).  
**Claims:** 7, parameter authentication.  
**Precondition:** An SDK caller supplies inconsistent `manifestBytes` and `manifest` arguments.

`openTokenWallet()` authenticates `manifestBytes` and their pin, discards the parsed checked object, then uses the independently supplied `manifest` for parameter loading and engine/scanner construction. Successful authentication does not establish that the operational configuration is the authenticated configuration.

**Reproduction:** Run the second test in `review/bridge-params/parameter-security-repro.test.mjs`. Supply the genuine bytes and SHA256 pin but change the separate object's start height to 1,000,000,000 and its label. Use the real candidate wasm, public parameters, a synthetic root and in-memory RPC responses reporting chain height 101 (tip 100).

**Observed:** The wallet opens; the scanner uses start height 1,000,000,000 and the altered label and reports `waitingForStart: true`, although the authenticated manifest's start height is zero.

**Impact and limit:** An integration error or attacker-controlled metadata source can change history selection despite a successful pin check. The shipped browser worker uses the checked parsed object and is **not shown vulnerable to this same path**. Forged-proof acceptance, browser compromise and post-open scanner mutation were not demonstrated. Source inspection also shows that a pin supplied without bytes is not enforced by this SDK branch.

**Suggested fix:** Derive the sole operational manifest from authenticated bytes. Remove the redundant object, or require complete equivalence. Require bytes when a pin is supplied. Keep an owned immutable configuration snapshot and test mismatched objects, missing bytes, foreign domains and later caller mutation.

### M2 — Journal lease permits two successful reservations and a lost write

**Location:** [wallet-extension/src/private-journal.js:41](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/private-journal.js:41); reservation consumers at [token-format.js:145](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:145) and [line 152](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:152).  
**Claims:** 9, cross-window reservations and journal durability.  
**Precondition:** Two independent contexts interleave lease acquisition and journal mutation.

The storage read/write/readback lease is not an atomic compare-and-set. Both contexts can read an empty lease. A writes and verifies its lease; B then writes and verifies its own. Both can enter the critical section and read the same old journal, pass reservation checks, and overwrite each other's encrypted update. A three-second expiry also does not itself establish exclusive ownership throughout a mutation.

**Reproduction:** `node --test review/wallet-privacy/journal-race.test.mjs`. The test uses the actual journal module, real WebCrypto and a deterministic in-memory storage scheduler. It forces both lease reads before either write, then both old-journal reads before either encrypted journal update.

**Observed:** Both callers report reservation success for the same note; A's successful reservation disappears after B writes. The final journal contains only B. The logged interleaving records both successful checks and writes.

**Impact and limit:** Pending-operation integrity and recovery can fail across popups. The test does not drive two full browser sends and does not demonstrate duplicate payment or inflation; ledger conflict checks remain relevant defenses.

**Suggested fix:** Use a genuine cross-context exclusive primitive covering the complete read-modify-write, such as Web Locks where supported, or a single writer backed by transactional storage. Make reservation conflict checks and updates atomic. Test simultaneous acquisition, a delayed owner, expiry, process death and multiple popups.

### M3 — Refusal of the second private carrier frees token reservations too early

**Location:** [wallet-extension/src/token-format.js:24](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:24), publisher outcome handling at [line 95](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:95), continuation at [line 179](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:179).  
**Claims:** 4 and 9, partial-operation recovery and reservations.

After part A is published, a refusal/conflict for part B marks the entire operation `refused`/`conflicted`. `reservedTokens()` excludes that operation, even though its records remain pending and the continuation path can still use them. The token notes become selectable by another operation while the first is unresolved. Native-input reservations remain, so the token and carrier states disagree.

**Reproduction:** Run the first test in `review/wallet-privacy/reservations-and-fees.test.mjs`. Begin with an operation whose A carrier is published and B is signed. Apply the exact status transition performed by the publisher on B refusal, then query the actual reservation exports. Repeat for conflict.

**Observed:** The pending operation still exists; its shielded-note reservation disappears; both native-input reservations remain.

**Impact and limit:** Competing authorized operations and confusing recovery/wasted carrier fees become possible. This is an exported-function reproduction with the publisher transition applied by the test, **not** an end-to-end browser refusal/race. The core pool still rejects a second spend; no token inflation was shown.

**Suggested fix:** Separate per-carrier outcomes from the lifecycle of the overall token operation. Keep token reservations until canonical completion, a proven conflicting spend, or an explicit abandonment decision reconciled against all carriers. Test A accepted/B refused, lost B reply, B replacement, restart, abandonment and a competing send in the real popup.

### M4 — Duplicate private fragments accumulate and corrupt the pending count

**Location:** [core/src/pool.rs:240](<workspace>/research/token-format-unshielded-20261025/core/src/pool.rs:240), append/count/completion ordering at [line 246](<workspace>/research/token-format-unshielded-20261025/core/src/pool.rs:246), pair search at [line 258](<workspace>/research/token-format-unshielded-20261025/core/src/pool.rs:258), cleanup at [line 266](<workspace>/research/token-format-unshielded-20261025/core/src/pool.rs:266).  
**Claims:** 4 and 8, duplicates and resource use.  
**Precondition:** Repeated fragment records are included in distinct native carriers; the sender pays their native fees.

Parts are appended and counted before checking whether their operation already completed. Identical fragments are retained repeatedly. Each new part searches the stored A/B Cartesian product again. On success, cleanup removes all matching copies but decrements the pending count by only two.

**Reproduction:** Run the Rust review test `bounded_fragment_duplicates_and_pending_counter`. Submit three identical A records, an invalid B, then the genuine B; subsequently submit four more A copies for the completed operation.

**Observed:** Three A copies remain available as counterparts before completion. After genuine completion, `pending_records == 3` although only one invalid B remains stored. Four post-completion A copies increase that count to seven. `completedOperations` is **one**, and supply is unchanged.

**Impact and limit:** Redundant retained state, inaccurate pending metrics and avoidable replay work. Source analysis shows that balanced streams of non-completing A/B candidates can cause cubic cumulative **pair-attempt** growth as all previous pairs are retried on each insertion. This is not a measured throughput/OOM result; invalid pairs may reject on roots, nullifiers or commitments before any expensive proof checks. It is separate from the documented whole-pool clone per record.

**Suggested fix:** Reject/ignore completed-operation parts before insertion, deduplicate by operation/kind/content hash, and test only newly introduced pairs or cache immutable cryptographic results without caching state-dependent admission. Account for every removed entry. Define a bounded resource/storage strategy without silently expiring otherwise valid unfinished transfers. Benchmark adversarial as well as ordinary replay.

### M5 — Offline backend can attach to and modify another local test daemon

**Location:** [backend/service.mjs:93](<workspace>/research/token-format-unshielded-20261025/backend/service.mjs:93), readiness at [line 100](<workspace>/research/token-format-unshielded-20261025/backend/service.mjs:100), genesis check at [line 124](<workspace>/research/token-format-unshielded-20261025/backend/service.mjs:124), mining at [line 130](<workspace>/research/token-format-unshielded-20261025/backend/service.mjs:130).  
**Claims:** Review/test isolation and reliability of claims 8–10.  
**Precondition:** Another local offline fakechain already listens on the requested RPC port and has the same expected genesis.

Backend startup spawns a daemon, but readiness only asks the port for `fakechain` and `offline`. It does not prove that its own child owns the listener or survived startup. Another fakechain can satisfy both readiness and the later genesis check. The backend then mines startup blocks and exposes other mutating test operations against the foreign daemon.

**Observed reproduction:** This occurred in the first unmodified parts-suite run. The existing offline daemon occupied RPC 30131, startup progressed through mining, and HTTP 8991 later failed with `EADDRINUSE`. See the scope incident and `review/reproduction/parts-rollback-test.log`. This was not repeated deliberately. No mainnet/stagenet daemon satisfied or was subjected to this path.

**Impact:** Cross-test state corruption and misleading evidence, with a test able to mutate another chat's offline chain despite its intended data directory. A failed startup can also leave owned processes waiting. This is a test-infrastructure security/isolation issue, not an attack on Monero consensus.

**Suggested fix:** Allocate exclusive per-run endpoints and verify the owned child actually holds them before any mining, publication or rollback. Observe child exit/bind failure; clean up only owned processes. A port preflight alone is insufficient because of the bind race. Include readiness failures within cleanup handling and add a controlled occupied-port regression that proves no request mutates the existing service.

## LOW findings

### L1 — Parameter streams exceed their authenticated size before rejection

**Location:** [wallet-extension/src/holder-params.js:38](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/holder-params.js:38), callers at [line 49](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/holder-params.js:49) and [line 64](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/holder-params.js:64).  
**Claim:** 7, handling hostile parameter service responses.

The manifest supplies an exact length, but `download()` collects all chunks until EOF, allocates a second complete buffer, and only then checks length/hash. The time limit does not impose a byte limit, and response headers do not constrain the stream.

**Reproduction:** The first parameter reproduction streams 64 KiB for configuration pinned to 2,425 bytes while advertising the expected length. All 16 chunks are consumed; the reader is never cancelled; rejection comes only afterward.

**Impact and limit:** A faulty/hostile service can cause excessive memory consumption before authentication fails. No OOM attempt, key disclosure or hash bypass was performed.

**Suggested fix:** Pass trusted expected size into the stream reader, stop/cancel on the first excess byte and bound both configuration and proving-key downloads. Avoid an unnecessary second full allocation; authenticate before parsing or use. Exercise truncated, oversized, stalled and cached responses.

### L2 — Fee approval text understates exact quotes

**Location:** [wallet-extension/src/holder-carrier.js:75](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/holder-carrier.js:75), approval display at [token-format.js:126](<workspace>/research/token-format-unshielded-20261025/wallet-extension/src/token-format.js:126).  
**Claim:** 9, exact fee approval and no understatement.

The formatter truncates to six decimal places. A quote of **49,520,000 piconero = 0.00004952 XMR** is shown as **0.000049 XMR**, understating it by 520,000 piconero.

**Reproduction:** The second test in `review/wallet-privacy/reservations-and-fees.test.mjs` invokes the actual formatter with that synthetic quote and compares the display's atomic value with the quote. Source inspection traces the formatter into the approval text.

**Impact and limit:** The approval display is not exact. The error is less than one micro-XMR per formatted value. Numeric quote-to-signed-fee matching remains intact; this is not evidence of an extra hidden transfer.

**Suggested fix:** Show exact piconero-derived amounts, up to twelve decimal places with only trailing zeros removed, on the approval screen. Label any compact display as approximate and keep per-carrier and total fees accurate.

## Coverage of the ten requested claims

| Claim | Attacks/checks and bounded outcome |
|---|---|
| 1. Public-value forgery | Rust matrix rejected mixed owners/assets, duplicate/unknown inputs, zero input/output counts, zero outputs, signed inflation/loss, foreign signer/domain, recipient mutation, trailing/truncated encodings, spent-input replay, u64-wrap amounts, burn inflation, redirected change and unbound burns. Note IDs/signing labels were inspected; collision resistance was not proved. No accepted forgery demonstrated. |
| 2. Issuer credits | Mutated amount/asset/owner, non-issuer/foreign-domain signatures, receipt-binding reuse across kinds and record replay were rejected. Issuer compromise can authorize new credit by design. Status/retry concerns remain below; H1/H2 concern payout controls, not issuer-signature forgery. |
| 3. Shield/unshield conservation | Used valid proofs and fresh authorizations to test incorrect public amounts/assets. Forged value commitments that made a binding equation hold were still rejected by proof verification. Unshield recipient mutation and nullifier replay were rejected. No inflation demonstrated; this is not a proof of the circuit composition. |
| 4. Two-part private transfers | Supplied and review tests covered incomplete/invalid counterparts, order reversal, duplicate arrival, one/both-part rollback, competing spends, completion once and state replay. M3/M4 expose wallet/resource issues. Zero-value padding outside the pool was accepted as designed; a positive scratch-tree note could not verify against the real anchor. |
| 5. Keys/address codec | Checked owner/spend/view derivation separation, account differences, 5,984 address substitutions and 193 truncations. Only a limited BIP350 vector subset was exercised. Uppercase-prefix behavior and asset-name normalization remain observations below. No spend from a viewing key demonstrated; PRF/reduction security and timing behavior remain unproved. |
| 6. Native disclosure | Inspected record fields, native carrier construction, holder RPC path, request guards and stagenet runner source. No additional direct real-native-output/key-image association demonstrated. Public token owner/value, operation pairing and boundary/timing metadata remain visible as documented. No claim of zero privacy impact on Monero generally. |
| 7. Parameter authentication | Inspected pre-parse length/hash/ID/VK checks and cache rechecking; exercised the library-object mismatch and oversized stream (M1/L1). Reproduced core/supplied checks as present. Did not independently verify the Penumbra ceremony or rerun every historical parameter fault suite from other candidates. |
| 8. Indexer/replay | Supplied offline rollback/replay suite passed. Checked framing at the 1,060-byte boundary, duplicate fields, noncanonical encodings and 1,062 bounded malformed inputs without a demonstrated panic. M4 affects retained state/work; Q1 remains a source-derived snapshot concern. No full adversarial fuzz campaign or production-load proof. |
| 9. Journal/recovery | Supplied popup interruption/recovery flow passed. Additional deterministic tests exposed M2/M3 and fee issue L2. Inspected lookup-before-retry and native reservations. No exhaustive cross-process browser concurrency or crash schedule was explored. |
| 10. Bridge/migration | Supplied flow/popup exercised synthetic bridge and migration with the lab custody implementation. Inspected signature/claim binding, single-use registry and recovery. H1/H2 reproduce extra operator-control failures. No migration-signature forgery shown; no live Solana, live-holder snapshot, production cutover or marketplace-settlement certification. |

### Interpreting the privacy requirement

The relevant prohibition is an **additional identifying association** between a real native Monero output and its spend/key image. Ordinary Monero transaction blobs necessarily contain native key images and public ring references; their mere presence is not this leak. The review did not identify a new record field/proof disclosing that association. It also did not establish that protocol recognizability, timing, fee-paying behavior or network observations have zero privacy effect.

The two carriers' public operation identifier deliberately links their token fragments. Shield/unshield boundaries expose public amounts/owners, and migration associates an old token entitlement/output key with its requested new address. Past legacy disclosure cannot be erased. These documented disclosures are not misreported here as new key-image vulnerabilities. Imported cryptography, native transaction libraries and decoy selection were not independently audited.

## Unsettled questions and evidence gaps

### Q1 — Replay may label a mixed-time snapshot with the wrong tip hash

**Source:** [format/src/chain.rs:96](<workspace>/research/token-format-unshielded-20261025/format/src/chain.rs:96), replay at [line 103](<workspace>/research/token-format-unshielded-20261025/format/src/chain.rs:103), final check at [line 123](<workspace>/research/token-format-unshielded-20261025/format/src/chain.rs:123).

The code reads a tip hash, walks an internally linked chain into `previous`, and checks the tip again. It does not appear to compare the final replayed `previous` with the recorded tip hash. An A/B/A view across those RPC calls could therefore replay branch B while both outer checks see A. This is **source analysis, not a reproduced RPC sequence**, so it is outside the nine confirmed findings. It needs a controlled RPC regression and resolution before relying on snapshot identity. For a nonempty replay, compare its final hash with the claimed tip in addition to checking chain links and the final node view; explicitly handle an empty replay.

### Further questions

- **PRF/key/address analysis:** Modular reduction and root-key use were inspected but not cryptographically proved or side-channel tested. Valid fully uppercase bech32m checksum strings are rejected by the parser's lowercase prefix requirement. This is an interoperability/canonical-format question, not demonstrated theft. A full BIP350 compliance suite and independent key-schedule review remain appropriate.
- **Asset identity:** `asset_for_mint` lowercases and removes punctuation, making its raw-string mapping non-injective. Current catalog/service collision checks reject duplicate asset IDs. No exploit with two legitimate configured mint accounts was demonstrated. Specify canonical mint identity and registry collision handling rather than relying on display strings.
- **Credit retry status:** `retryCredit` treats an error containing `rejected` as sufficient to continue with `published`. Binding uniqueness still prevents duplicate accepted value, but the UI/recovery distinction between rejected and uncertain publication needs a targeted test; no inflation was demonstrated here.
- **External implementation assumptions:** No audit of imported cryptographic/native dependencies, proof soundness, random-number generation, constant-time behavior, parameter transcript or real-chain economics was completed. Cached valid parameter bytes do not authenticate ceremony history.
- **Production scope:** Synthetic receipts and snapshots do not verify actual bridge backing, every real mint's extension/fee behavior, live indexer cutover, or recovery across every crash point. No external chain was used for this review. The user-facing wallet must not infer production safety from these results.

### Weaknesses in existing evidence

These are limits on what passing supplied tests prove, not additional counted vulnerabilities:

- The replay-equivalence section around [core/src/tests.rs:291](<workspace>/research/token-format-unshielded-20261025/core/src/tests.rs:291) reports sizes without asserting the claimed complete equivalence.
- The amount-tamper case around [line 221](<workspace>/research/token-format-unshielded-20261025/core/src/tests.rs:221) already has spent nullifiers, and the bad-proof case around [line 250](<workspace>/research/token-format-unshielded-20261025/core/src/tests.rs:250) also has an invalid signature. Either can reject before reaching the intended check. The review added fresh proofs/authorizations and unspent inputs to reduce this masking.
- The stale-B comment in [parts-rollback.test.mjs:68](<workspace>/research/token-format-unshielded-20261025/parts-rollback.test.mjs:68) should not be read as proof of no native fee: the later code mines the stale carrier and checks token inertness.
- Record-length/initial-tag checks in the flow suite are not a complete privacy audit; a count of unspent, unreserved native outputs is not proof that those outputs are unlocked.
- Two applications sharing the same engine, or two replicas replaying the same implementation, are useful consistency tests but not independent cryptographic verification.

## Known limits retained, not counted again

The handoff already documents: one shielded input per unshield transaction; two spendable native XMR outputs for a private send; unverified Penumbra ceremony transcript; no independent audit; no Solana devnet rehearsal; stagenet exercise of the Node library rather than this browser candidate; irreversible payout-after-deep-reorg loss; unresolved native-market settlement; and cloning the whole pool per record. These remain limitations. H1/H2 are additional failures of the implemented controls; M4 concerns duplicate retention and repeated pair processing beyond the acknowledged clone cost.

More confirmations, optional shielding, passing suites and this AI review do not establish finality or make the entire product safe. This review makes no production release recommendation beyond **NO-GO for the reviewed build**.

## Artifact and source provenance

The tested role binary was `target/release/xmr20-unshielded-lab` (10,422,208 bytes), SHA256 `836d2648a22975a0cd38d7ad81b0f7c2617af3d4db7725de56864a808a2139cb`.

The tested holder was `holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm` (5,335,750 bytes), SHA256 `8b29fa98a79066694628fd82361139a89a125115e60df433f0c6abf29d20b77f`. The review extension's `vendor/holder.wasm` has the same hash. Do not substitute the root Cargo target directory for this holder artifact.

`review/BUILD-ARTIFACTS.json` records the relevant build/parameter hashes. `review/REVIEW-EVIDENCE.json` inventories review evidence. `review/reproduction/source-integrity.json` records zero changes/missing files against the 134-file source/document baseline taken at 02:04:16 UTC. This check does not imply all 134 files were reviewed.

The following 45-file manifest identifies the actual reviewed source/document snapshot. `review/REVIEWED-FILES.json` distinguishes full focused reads from partial relevant-section reads and test-harness inspection/execution. In particular, holder-wasm/lib.rs, the format entry point and native carrier code, build scripts/manifests, address service and stagenet runner received relevant-section review rather than an exhaustive line-by-line audit. Paths in the hash manifest are relative to the candidate directory stated above.

```text
c2be2b43a078b983ca6a9e5b62395c09ac164932eb9501cb00ca71d648b19900  review/00-CODEX-SECURITY-REVIEW-HANDOFF.txt
c1667985a6ed63e302c839029df0012b732c75a32a946de5643588fdb2b69bb2  README.txt
5f9c5b1b9f9577244ec5f5d6ae1b19db35f491d6564f68fcc7f7d660c000c1bf  DESIGN.txt
35818fcf288cd11044bf91e2f766caba159c72972e9bfa31d5540032220bd578  RESULTS.txt
f3b45b4933f7f5dd21396772fc2e06b6f0bb46f65daf99ea38399b4edc8f0ed1  RELEASE-NOTES.txt
7ef643b6fd1a78fc3595c96e383e8418ffed9a9de1c395e6df5b87b893d647e1  MIGRATION-CUTOVER.txt
7eaf324ec17e9a79b98cdd6a5e11016ffe145ebe0bf2aa138b1bcf5e68367d5a  core/src/lib.rs
7e720639e55d88cb3aac44018fdf989c122dedda4521cfb89520dfa1c5a49485  core/src/keys.rs
e378e21c29670bcaf50d327457b9496ecb66eda05879754c50c50360dd773dc6  core/src/public.rs
13585ced687da0d9cbddcc811bad3ff7278c2bf29c02f004271ac07f56530ebe  core/src/shield.rs
a1e184735660ab0d1eae77a79687832864817cba3b013f8ffed31f820890c3fa  core/src/private2.rs
4dcf20cd1e690412c3d64386937c175cfa4b85ef1b66ab9114f9324ac83c36b0  core/src/payload.rs
238520f188351757b7ef219f313ffb9d9babd2f2c51b6866e088c080927cc9f0  core/src/pool.rs
b8571a7fc62cd9598d247f1f8475236c58f01288499a5a9871dad0a7692a4a93  core/src/ledger.rs
d0836c67e090178fd7f16c751a73466485cd0e532206037dc6db9a139e02de92  core/src/transport.rs
db755a4719fc9930596b44bfc7d6760264b1ff8180465b53ffab834b262c41ca  core/src/tests.rs
4ff6557509f85f84aaa56c28b7ca456d65840ed9b5174bd69c4511c4d590a134  core/src/penumbra.rs
50829e9136dccf0e268d8f170c558b8fb71c84d359b6bcbdd56be194b3c4f660  core/src/manifest.rs
5a0e23119064a572cf996598b5ff4dea2d29f938296d25355516624925f02713  backend/operator.mjs
4eed808f97f35bf406e5b6943da40c9b5911e97f63cdc9bc222b6a30eedfa08e  backend/migration-registry.mjs
0294c2fa16826d117f47396e46668ec5b701c8022a3499157ae713be2460db66  backend/service.mjs
bf84c298ca9f7d98e16f7164b558ec11b53fb0bd5c4b1e0d5977ee5e227e37e2  backend/solana.mjs
c179b54531711a0a7494119b7dcc72132ee4e5be78df03fe0b4b2d45da9d59f9  wallet-lib/token-wallet.mjs
41920438b991e40a37c808fdd2c79071775ca0ab32bd34cd87aa32c28298fd9e  wallet-extension/src/private-journal.js
1e8a578a44b825c4f0a40cb79f86024501aae61392a5efc7e20939621c21e326  wallet-extension/src/token-format.js
b7b51c6aafc9b904ef08c28ebf2df3c530149536bb27202b2ec46d8c327b0a20  wallet-extension/src/holder-carrier.js
4680375f967cfe95532ea7ae547725a21de69f0fc48b32850d92e07010e1e86a  wallet-extension/src/private-holder.worker.js
cf26049bc3634372d51fadffa718bc2bd7facc44a7035843967daad26a3dfbd5  wallet-extension/src/holder-engine.js
25a974f74a1c0949dd71facd7f261acfd0486eb94e4a02432db06d8dea5c6ae4  wallet-extension/src/holder-params.js
9b44ab0d785c06540446db4cbfdee13c0915a9a1b3d50b05ae81c7f972d1519c  format/src/chain.rs
930df95e86534023c8399692a256d3774d6d4fcd166a8d58d26451af04c08422  holder-wasm/src/native.rs
93efe1b7fc13d139cb4211222a62068307f6d9de7b5baafa1234b2a89079e80c  params/test-v2/manifest.json
b0d9baa140d621fb9d1972a3dd2adfdd351b5408279583691c2ac15468961f09  holder-wasm/src/lib.rs
b63baa4e994590622c1605f99963b52e172c0a5c0da1ce63b94b6c34b80d3e61  holder-wasm/Cargo.toml
d06b6e4a0892077fc0f2ad93c01e6507e591162c869d29ce82d98a7be60d2b2a  format/src/main.rs
9bc5485ff2c6115421d6f5675fbfa2aef47cf14719708a1ef193d434da524d12  wallet-extension/build.mjs
b1cd5c375a5c47be16495cad28c970d072e5e4421ea2376127104ac710156a43  backend/address.mjs
b36af87cf42ca0242c1d7dae2c48252ee67ea532bcbf079aea6e23f9b1414e43  stagenet/run-unshielded.mjs
7732223b1d53b2319d48145a74f1f17de2a6a1f20dc90707effb6d24dbe4a10a  core/Cargo.toml
329ffcdc40290f87ab9f5ce984894cd4539b730e57c077ebcbdefca8428e19ba  format/Cargo.toml
375f68ffc0e78f63832de6551bfd141b368c27c52dfac9b407e76be174dd0c0d  flow.test.mjs
4fef1e5d5a5b0305379bc953240141b1257b241fda49b9874311466c4f9a2379  parts-rollback.test.mjs
c791ff538ce626809874fb664c7ccd734e71d43b215c060bd194dad7aabc0388  browser-flow.test.mjs
bf4bc6e075c991710eb8dd7bf06574b32915c0f0d242b39ff1198b4492526de3  browser-harness.mjs
47e48b0e33845b90938005fe9235efb0770cb75e4b280ce9614be2c76a22a2cb  format/src/native.rs
```
