STAGENET CARRIER REHEARSAL — research/privacy-stagenet-rehearsal-20261023 (prepared, NOT executed on stagenet)
23 October 2026. Copied from research/privacy-verifier-params-20261023 (stage 3/4 code + hardened lab backend reference).
No blockchain download and no public broadcast were performed in this session. Offline fees and decoy behaviour are
NOT mainnet (or stagenet) measurements.

WHAT WAS PREPARED (runnable)
- Engine/library network awareness: the parameter manifest's network.kind may be "offline-fakechain" or "stagenet";
  the engine refuses anything else; the scanner requires nettype fakechain+offline for the first and nettype stagenet
  for the second (no accidental cross-network use); the carrier builder enables monerod's send_raw_transaction sanity
  checks whenever the network is not the fakechain (normal validation on stagenet).
- params/stagenet-v0: a parameter set generated with the lab `setup` for the STAGENET genesis
  (76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb) and its manifest (stagenet/make-stagenet-manifest.mjs).
  Still a disposable single-party Groth16 setup; only the ledger domain is bound to stagenet.
- stagenet/rehearsal.mjs: the harness. Refuses non-stagenet or unsynced nodes and mainnet; syncs the wallet from the
  given node; reports native balance/unlock; quotes a carrier with the REAL stagenet fee rate and decoy distribution;
  proves 1-, 2- and 3-note transfers; signs; publishes with sanity checks ON; re-sends the same blob once (uncertain
  broadcast); polls pool membership and confirmations to 10; records record/tx_extra/carrier sizes, fees and timings;
  separates "token proof valid locally" from "native transaction accepted by the node". Writes a JSON report.
- stagenet/local-checks.mjs: what can be checked NOW without a stagenet node (run it: node stagenet/local-checks.mjs).

LOCAL CHECKS RUN IN THIS SESSION: see RESULTS.txt / runs/stagenet-local-checks.json.

WHAT STILL REQUIRES EXECUTION ON STAGENET (not done here; each needs an operator decision to spend time/resources)
1. A synced stagenet monerod the operator controls (full stagenet sync; hours; not started here).
2. A static parameter server for params/stagenet-v0 (the lab backend is fakechain-only).
3. Stagenet-aware issuer/indexer roles: the lab binary's native::guard still requires an offline fakechain
   (research/privacy-verifier-params-20261023-lab/src/native.rs guard), and its Chain replay assumes the daemon's
   block set is small. Needed: a `--network stagenet` mode in the lab guard + manifest check (the manifest change is
   already accepted by the hardened Params::load), and a credit (XB3) issued on the stagenet-anchored pool so the
   holder has notes to spend. Until then only the native half (XMR carriers with a placeholder record) could be
   rehearsed, which is not the goal.
4. Funding: stagenet XMR from the public faucet to the synthetic wallet's stagenet address; 60-block coinbase
   maturity does not apply (faucet outputs are ordinary), 10-block spendable age does.
5. The rehearsal itself: 1-, 2-, 3-note transfers; verify node acceptance with sanity checks ON; measure complete
   tx_extra (expected 1,056 B), carrier size (expected ≈2,520 B), fee at the stagenet dynamic rate, decoy sampling
   rounds, proving time on the target machine, confirmation handling, uncertain-broadcast retry behaviour (same blob,
   idempotent), and whether a public stagenet node relays carriers with a 1,056-byte extra (relay rule limit 1,060).
6. Native input selection on a wallet with many small outputs (faucet amounts), and the one-carrier-per-10-blocks
   limit with a single output.
7. Record the results with the same discipline: evidence folder, network audit, no secrets, and the statement that
   stagenet fees are not mainnet fees.

NOT CHANGED: readiness (NO-GO), bridge payout and native trading gates, the disposable setup, the need for review.
