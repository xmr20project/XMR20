XMR20 TOKEN FORMAT v0.2-experimental — UNSHIELDED BY DEFAULT, OPTIONAL SHIELDED TRANSFERS (isolated candidate)
research/token-format-unshielded-20261025 — 25 October 2026. SIMULATED on an offline fakechain with the LiteSVM custody unless a
result says otherwise. Independent review: NOT performed. Not for real funds. The live website, installed wallet, bridge, NFTs,
balances, services and every earlier lab are untouched; this folder copies what it needs and links the shared read-only parts.

WHAT IT IS (DESIGN.txt is the specification; PROOF-SYSTEM note: no XMR20 setup exists any more)
  Public ledger records (no proofs): XP1 transfer · XC1 credit (deposit/migration) · XR1 burn (bridge redemption)
  Boundary records (Penumbra's published circuits and keys): XS1 shield (1 tx) · XU1 unshield (1 tx, one note)
  Private transfer: XMA + XMB — TWO Monero transactions, 3 Penumbra spends + 2 Penumbra outputs, applied once when both are canonical
  Keys: XMR20-TKD1 token spend key (unchanged) + derived public OWNER key; unified address xmr20t1… = shielded address || owner key
  Setup: Penumbra's summoning-ceremony keys (params/penumbra-2.1.1, git-lfs objects verified against the crate's pointers); the
         XMR20-PARAMS-2 manifest pins their bytes and key ids. Not verified here: Penumbra's ceremony transcript.

LAYOUT
  DESIGN.txt                   requirements -> records, byte layouts, disclosure rule, accounting invariant, wallet behaviour
  core/                        Rust: keys, records, Penumbra proofs, pool indexer (shared by the roles binary and the wasm engine); unit tests
  format/                      Rust roles binary xmr20-unshielded-lab: setup | indexer | issuer (chain replay, trusted manifest, native carriers)
  holder-wasm/                 Rust holder engine compiled to wasm32 (derive, scan, select, plan, build, verify, native carrier)
  params/penumbra-2.1.1/       Penumbra's spend_pk.bin (21,673,392 B) / output_pk.bin (7,257,360 B) + vk params + ids; make-manifest.mjs
  params/test-v2/              offline-fakechain parameter set: parameters.json, manifest.json (XMR20-PARAMS-2), issuer.secret.json, key copies
  backend/                     test backend (service.mjs), operator.mjs (public credits/burn payouts), solana.mjs (LiteSVM custody), address.mjs,
                               migration-registry.mjs (legacy claims with unified owners)
  wallet-lib/token-wallet.mjs  Node library over the wasm engine (used by the Node suites)
  wallet-extension/            isolated extension copy; src/token-format.js is the popup module; build = extension-private-holder-test
  flow.test.mjs                end-to-end Node flow (engine + backend + fakechain), evidence runs/flow-results.json
  parts-rollback.test.mjs      two-part transfers under rollback, conflict, reversed arrival; runs/parts-rollback-results.json
  browser-flow.test.mjs        the REAL popup (Playwright Chromium) through every user action; evidence/verified-popup-unshielded-*/
  migration/                   catalog + snapshot/reconciliation tooling copied from the release candidate (public data only)
  runs/                        logs and JSON results of every attempt (retained, including failures)

BUILD (all offline, pinned; toolchain rustc 1.99.0; cargo in ~/.cargo/bin)
  export CARGO_TARGET_DIR=$PWD/target; (cd core && cargo test --release --offline)          # core unit tests (Penumbra keys required)
  (cd format && cargo build --release --offline)                                             # -> target/release/xmr20-unshielded-lab
  (cd holder-wasm && CARGO_TARGET_DIR=$PWD/target cargo build --release --offline --target wasm32-unknown-unknown)
  (cd wallet-extension && XMR20_PRIVATE_HOLDER_TEST=local node build.mjs)                    # -> extension-private-holder-test (loads vendor/holder.wasm)
  Parameter set (once): XMR20_INTEGRATION_LAB=offline-synthetic-only target/release/xmr20-unshielded-lab setup params/test-v2 <fakechain genesis> params/penumbra-2.1.1
                        node params/make-manifest.mjs params/test-v2 --network-kind offline-fakechain

RUN
  node --test flow.test.mjs                 # ~3 min: deposit, public send, shield, 2-tx private send, unshield, burn+payout, migration, recovery, rollback, audit
  node --test parts-rollback.test.mjs       # ~4 min: rollback of one/both parts, conflicting spend, reversed arrival, duplicate part
  node --test browser-flow.test.mjs         # ~30 min: the real popup, two wallets, fresh-profile restore, 320x440 layout, network/secret audit
  TRY IT YOURSELF (test wallet, no real funds): see TRY-THE-TEST-WALLET.txt

STATUS: see RESULTS.txt (measured numbers, attempts, what is NOT done) and RELEASE-NOTES.txt (readiness statement and blockers).
