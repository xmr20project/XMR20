XMR20 — PRODUCTION-SHAPED INDEXER AND BRIDGE SERVICE for the unshielded-by-default token format
Candidate: research/bridge-service-unshielded-20261026 (additive; isolated from the live website, wallet, bridge and backend)
Status: EXPERIMENTAL RESEARCH CANDIDATE. Tested on the offline fakechain and read-only on public stagenet. NOT deployed,
NOT reviewed independently, NO real funds, NO mainnet manifest exists. Independent security review: NOT PERFORMED.

WHAT THIS IS
The format candidate (research/token-format-unshielded-20261025) ships a TEST backend (backend/service.mjs) that boots a
fakechain and replays the whole chain on every scan. This candidate turns that into the two long-running services a real
deployment needs, without touching the reviewed format core:

  indexer/            Rust binary `xmr20-indexer` (stdio JSON). Same admission rules as the reviewed core Pool and the same
                      trusted-manifest parameter authentication as the lab roles, plus an append-only state log, incremental
                      sync, restart-from-disk and reorganisation handling (fork point by stored hashes, atomic truncation,
                      rebuild). Refuses mainnet daemons unless the manifest says mainnet (none does).
  bridge/indexer-service.mjs
                      Supervises the indexer child, restarts it, answers loopback HTTP (health/status/summary/owner/record/tx/
                      verify/view/events/sync). Bearer token required when not bound to loopback.
  bridge/operator.mjs The bridge operator state machine: durable journal + audit log; deposit receipts -> PUBLIC credits bound to
                      the receipt (exactly once); burns -> payouts after D confirmations, exactly once, with an optional
                      independent-observer gate and exposure limits; incidents (burn reorganised / vanished -> PAUSE;
                      paid-without-burn -> HALT); liabilities (every unit of reserve owed to exactly one bucket).
  bridge/custody-litesvm.mjs / custody-rpc.mjs
                      One custody interface, two implementations: the in-process Solana VM (tests, offline chain) and the
                      @solana/web3.js RPC flavour (devnet / mainnet-beta). The RPC flavour is WRITTEN BUT NOT EXECUTED against
                      any network in this candidate.
  bridge/bridge-service.mjs
                      The service process: configuration + mainnet guard, issuer role child (format roles binary), one operator
                      per asset, deposit/credit-recovery/payout loops, the holder API the wallet popup already speaks
                      (state, register, depositPrepare/Submit, redeemPrepare, payout, claimPrepare/Submit, view) and an admin API
                      (status, incidents, liabilities, pause, resume, tick). Test services (mine, fund, pop) exist only with
                      testServices=true on the offline fakechain.
  ops/                config.example.json, run-indexer.mjs, health-probe.mjs. RUNBOOK.txt has start/stop/upgrade/incident steps.
  test/               harness.mjs (fakechain + both services as separate processes) and bridge-service.test.mjs.
  stagenet-follow.mjs Read-only follow of the 25–26 Oct stagenet rehearsal with the persistent indexer (results in RESULTS.txt).

WHAT IT DOES NOT DO
- It does not change the format, the proofs, the wallet or the test backend of the format candidate (Codex review in progress
  on that candidate's review/00-CODEX-SECURITY-REVIEW-HANDOFF.txt). The core crates are consumed as dependencies.
- It does not remove the settlement counterexamples documented in the release candidate: a deep reorganisation after a final
  Solana payout is still a loss (the operator HALTS; it cannot revoke), and an operator-verified custody is still custody.
- It has no mainnet manifest, no mainnet issuer key, no production operator keypair and no deployment. The RPC custody path and
  the stagenet bridge loop (deposits on devnet/mainnet Solana) have not been exercised end to end.

HOW TO RUN THE TEST (fakechain, LiteSVM; ~ten minutes; synthetic keys only)
  cd research/bridge-service-unshielded-20261026
  node --test --test-concurrency=1 test/bridge-service.test.mjs
The binaries come from the format candidate's shared Cargo target: `cargo build --release -p xmr20-unshielded-lab` there and
`cargo build --release` in indexer/ (CARGO_TARGET_DIR=../../token-format-unshielded-20261025/target). Run folders under runs/
are deleted on success and kept on failure.

HOW TO RUN THE SERVICES (stagenet example; test funds only)
  node ops/run-indexer.mjs ops/config.json           # ready line: {"ready":true,"url":...}
  node bridge/bridge-service.mjs ops/config.json     # ready line: {"ready":true,"url":...,"issuerNative":...}
  node ops/health-probe.mjs ops/config.json          # exit 0 = healthy
Mainnet: refused (XMR20_BRIDGE_MAINNET=I-UNDERSTAND is additionally required and there is no mainnet manifest).

EVIDENCE
RESULTS.txt — measured runs (attempt logs under runs/, results JSON), transaction counts and fees, what was NOT run.
