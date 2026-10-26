# Disposition of the Codex security review findings (fix candidate, 26 October 2026)

Reviewed candidate: `research/token-format-unshielded-20261025` (unchanged). Fix candidate: `research/token-format-unshielded-fix-20261026`.
The review was an AI second review, not an independent audit; these fixes do not change that. Passing tests here are regression
evidence for the specific defects, not a security certification. The rollback-loss counterexamples (payout after a deep reorganisation is a
loss the operator can only detect and halt on) and the unverified Penumbra ceremony transcript remain exactly as documented.

Original review tests (unchanged) live under `review-original/`. Tests marked REPRO in the review deliberately pass on the defect; their
status against this candidate is listed per finding. Regression tests asserting the corrected behaviour are under `tests/`.

| ID | Finding | Fix (file) | Regression evidence | Original REPRO against the fix |
|---|---|---|---|---|
| H1 | Earlier incident suppressed a later paid-without-burn halt | `backend/operator.mjs`: halt latched unconditionally; incidents deduplicated by kind+txid | `tests/operator-regressions.test.mjs` H1: sequence from the review, then repeated reconcile, then journal reload — halted, one incident | fails (halted is now true) |
| H2 | Unresolved submissions bypassed the window cap | `backend/operator.mjs`: durable reservation before custody; unresolved submissions counted and recovered before admission; serialized admission; definite/uncertain failure rules; `abandonSubmission` | `tests/operator-regressions.test.mjs` H2 (interrupted, reload, definite refusal, uncertain exception, abandon, concurrent); `tests/bridge-integration.test.mjs` on the real backend | fails (third payout refused; 200 paid, not 300) |
| M1 | Wallet library operated on an unauthenticated manifest object | `wallet-lib/token-wallet.mjs`: configuration from authenticated bytes only; mismatching object refused; pin without bytes refused; frozen snapshot | `tests/parameter-regressions.test.mjs` M1 | fails (open refused) |
| M2 | Journal lease allowed two reservations and a lost write | `wallet-extension/src/private-journal.js`: Web Locks (or injected lock) around the whole read-modify-write; writes refused without a lock | `tests/wallet-regressions.test.mjs` M2 (two contexts, crash, slow holder, refusal) | no longer applies: the lease path only exists by explicit opt-in; without a lock implementation writes are refused |
| M3 | Refusal of part B released token reservations of a resumable operation | `wallet-extension/src/token-format.js`: carrier status separate from operation status (`carrierOutcomeTransition`), reservations held while `partial`, explicit `canAbandon` rule, no blind re-send of refused carriers | `tests/wallet-regressions.test.mjs` M3 | no longer applies: the test applied the OLD transition by hand; the publisher no longer performs it |
| M4 | Duplicate fragments accumulated; pending count wrong; repeated pair processing | `core/src/pool.rs`: completed-operation parts ignored, duplicates ignored, only new pairs tried, exact accounting on completion | `core/src/tests.rs` `fragment_duplicates_are_not_stored_and_pending_counts_stay_exact` (11/11 core tests) | review's Rust test (review-original/public-crypto) asserts the defect counts; not re-run here |
| M5 | Offline backend could attach to and mutate another test daemon | `backend/service.mjs`: exclusive ports, HTTP first, child-exit watch, lsof ownership, fresh-chain check, fail-safe cleanup; suites use per-run endpoints; browser extension built per run | `tests/isolation.test.mjs` with a disposable fixture daemon | n/a (incident, not a test) |
| L1 | Unbounded parameter download before rejection | `wallet-extension/src/holder-params.js`: trusted-length streaming, cancel at first excess byte, single allocation | `tests/parameter-regressions.test.mjs` L1 | fails (rejected after one chunk, cancelled) |
| L2 | Approval text truncated the exact fee | `wallet-extension/src/holder-carrier.js` exact `xmr()`, `xmrApprox()` marked ≈; approval screens use the exact value per carrier and in total | `tests/wallet-regressions.test.mjs` L2 | fails (0.00004952 shown) |
| Q1 | Replay could label a mixed-time snapshot with the wrong tip hash (source analysis only) | `format/src/chain.rs`, `format/src/native.rs`: replayed final hash must equal the snapshot tip | `tests/replay-snapshot.test.mjs`: proxy-staged A/B/A over a disposable fakechain — reviewed binary accepts (tip A, replayed B), fixed binary refuses, quiet chain scans | demonstrated, then fixed |

## Bridge service candidate
The production-shaped service (`research/bridge-service-unshielded-20261026`) now builds on this candidate: its indexer links the fixed core/format crates, and its operator carries the H1/H2 changes (own regressions `test/operator-regressions.test.mjs`, suite attempt 8 passed, stagenet follow re-run). Its test lab uses exclusive ports with verified daemon ownership (M5).

## Supplied suites on the final build (isolated endpoints)
See RESULTS-FIX.txt for the run records (flow, parts/rollback, real popup) and the exact commands.

## Remaining blockers (unchanged by these fixes)
- Independent human security review of the cryptographic composition and wallet implementation: not performed.
- Settlement: payout after a deep reorganisation remains a loss; confirmations, exposure limits and observers bound it, nothing removes it.
- Penumbra ceremony transcript unverified (keys pinned by bytes/ids only).
- No mainnet manifest, keys or policy; no devnet custody rehearsal; stagenet exercised through the Node library only.
- Further questions from the review (uppercase bech32m, asset-name normalisation, credit retry status wording) are not addressed here.
