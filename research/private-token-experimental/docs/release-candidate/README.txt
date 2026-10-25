XMR20 PRIVATE TOKENS — RELEASE CANDIDATE (research/privacy-release-candidate-20261025)
One isolated integration candidate built from the newest verified work. Experimental research; NO-GO for real funds.

READ IN THIS ORDER
  RELEASE-CHECKLIST.txt   what is verified / inadequately tested / missing / undecided / needs independent review; exact versions
  SETTLEMENT-DESIGN.txt   both counterexamples reproduced, the failing assumption in each, constructions evaluated, recommendation
  CONFORMANCE.txt         one rule set for every component; conformance/states-vectors.json; what is shared vs mocked
  DISCLOSURES.txt         what the public, counterparties, operator and viewing-key holders learn; specific checks; crypto status
  RELEASE-GATES.txt       measurable gates per component, measurements on record, operations, staged rollout
  RESULTS.txt             every run of this candidate with evidence paths (failed attempts retained)

WHAT IS IN HERE (sources copied from privacy-stagenet-wallet-20261024 and privacy-stagenet-roles-20261023; nothing moved)
  wallet-extension/       popup source with lookup-before-retry; builds: XMR20_PRIVATE_HOLDER_TEST=local|stagenet node build.mjs
  wallet-lib/, cli-wallet/ library and CLI over the same wasm engine (holder-wasm/…/xmr20_holder_wasm.wasm, sha256 2c866f39…)
  backend/service.mjs     offline test service (fakechain + lab roles + LiteSVM custody) — now with observer-gated payouts and
                          third-party legacy migration (EXTREMIST acceptance asset); backend/stagenet-service.mjs — stagenet service
  stagenet/               roles, parameter server, fault proxy, holder process, recovery cases, rehearsal harness
  settlement/             counterexample A live test + evidence; counterexample B model + preserved evidence
  conformance/            replay equivalence, observer gate, operator journal corruption; states vectors
  migration/              third-party legacy migration acceptance test + catalog (real mint recorded, stand-in used)
  review/                 external review package (00-08) carried from the roles candidate, unchanged except pointers
  integration-suite.mjs   runs everything above (+ the offline real-popup suites) into runs/integration-report.json

RUN
  cd research/privacy-release-candidate-20261025
  (cd wallet-extension && XMR20_PRIVATE_HOLDER_TEST=local node build.mjs)   # once: the offline test extension the popup suites load
  node integration-suite.mjs --quick     # unit, settlement, conformance, migration, checker, interop (real popup), roles (~40 min)
  node integration-suite.mjs             # + the four real-popup suites on the offline fakechain
  node integration-suite.mjs --carry runs/<earlier integration-report.json>  # reuses a PASS row only when the recorded CONTENT
                                         # identities of that suite's inputs (sources, spawned scripts, wasm, lab binaries, monerod,
                                         # custody program, parameter manifests + proving-key bytes, built extension, toolchain) are
                                         # identical; origin (run id, time, build) is kept through reuse; no mtimes, no logs
  node --test integration-suite.test.mjs # runner self-test (suite-provenance.mjs): changed dependency/binary/parameters invalidate
                                         # reuse even with preserved timestamps; --quick/--only never claim completion
  node reproduce-builds.mjs [--only key,…] # locked build recipe: rebuilds the engine wasm, both lab binaries (in their recorded target
                                         # directories, no RUSTFLAGS) and the custody program (platform-tools v1.57, registry remapped)
                                         # from source, offline and --locked, and compares byte-for-byte with the digests in
                                         # runs/integration-report.json -> runs/repro-builds/BUILD-RECIPE.txt + report.json (~7 min)
  Every suite streams to runs/suite-logs/<file>.log, is bounded in time (its whole process group is terminated at the bound) and
  echoes failures plus one heartbeat per minute; the report is runs/integration-report.json (build identity, per-row input digests,
  executed vs reused rows with their origin, and a completion claim that is only "full suite" when every row of the full suite passed).
  Stagenet (real network, hours, faucet-limited): see privacy-stagenet-wallet-20261024 (launch.sh, browser-stagenet.test.mjs).

BOUNDARIES
  Synthetic wallets, offline fakechains, LiteSVM, stagenet faucet coins only. No deployment, no real balances, no live
  payouts or trading, no access to existing private keys. Bridge payouts and native XMR trading stay gated.
