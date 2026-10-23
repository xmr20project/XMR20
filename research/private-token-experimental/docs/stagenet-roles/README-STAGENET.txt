STAGENET-AWARE LABORATORY ROLES, PARAMETER SERVICE AND TWO-WALLET REHEARSAL HARNESS
research/privacy-stagenet-roles-20261023 (+ lab crate research/privacy-stagenet-roles-20261023-lab), 23 October 2026.
Continues research/privacy-stagenet-rehearsal-20261023 (unchanged) and the hardened verifier lab crate (copied, unchanged).
Synthetic wallets and funds only. The rehearsal itself has NOT been executed on stagenet in this session: no stagenet
node exists on this machine, no chain download was started, nothing was broadcast publicly. Everything executed here ran
on an offline zero-peer regtest fakechain and is labelled SIMULATED. Readiness is unchanged (NO-GO everywhere; bridge
payouts and native XMR trading gated). Mainnet is refused by every component.

WHAT NOW WORKS (built and tested locally; see RESULTS.txt)
1. Network-aware issuer and indexer (lab crate). The trusted manifest (--trusted-manifest, required, authenticated
   parameters) now also selects the NETWORK: network.kind "offline-fakechain" or "stagenet"; anything else (mainnet,
   testnet, typos) is refused in Manifest::validate. native::guard(daemon, kind) checks the daemon's own get_info:
   fakechain => nettype fakechain, offline, zero peers; stagenet => nettype stagenet; mainnet is refused unconditionally
   before the kind check. The daemon URL comes from XMR20_INTEGRATION_RPC_URL (the operator's own node) or the loopback
   port. The daemon's genesis must equal the manifest's. network.startHeight (default 0) is the pool start: the indexer,
   issuer and holder wallets ignore blocks below it and replay from it (a start above the tip yields an empty pool).
   Normal Monero validation stays on: the roles publish with the daemon's ordinary send_raw_transaction path, and the
   holder library keeps monerod's sanity checks ON whenever the network is not the fakechain. Addresses are formatted
   for the selected network (stagenet prefix on stagenet; the regtest fakechain uses the mainnet format).
2. Static parameter service (stagenet/param-server.mjs). Serves EXACTLY /params/parameters.json,
   /params/normal.public-pk, /params/boundary.public-pk (+ an informational /params) from one directory; GET/HEAD only;
   no manifest, no issuer.secret.json, no wallet roots, no journals, no listing, no traversal (404). It is transport
   only: the wallet library authenticates every byte against ITS OWN shipped manifest; a tampered or foreign file served
   by this service is refused by the client (tested).
3. Harness (stagenet/rehearsal.mjs) connecting the roles, the service and two holder wallets (wallet-lib):
   three issuer credits -> T1 A->B with ONE note input and exact change -> recovery of BOTH wallets from their roots in
   fresh instances -> T2 from recovered A with THREE inputs -> T3 from recovered B with TWO inputs; every transfer shows
   the holder-paid XMR fee before approval, re-sends the SAME blob once (uncertain-broadcast recovery, no second payment),
   asserts exact notes/balances/change, exact native fee accounting (balance moves by exactly the fee), and indexer
   admission. --mode local = SIMULATED (own fakechain, mines on demand); --mode stagenet = EXECUTED ON STAGENET against an
   operator node (waits for real blocks). The JSON report states the execution mode and the fee basis in every row.
4. stagenet/make-stagenet-manifest.mjs gained --start-height N and --out.

EXECUTED IN THIS SESSION (SIMULATED, offline fakechain): node --test stagenet-roles.test.mjs — see RESULTS.txt.
NOT EXECUTED: anything on stagenet.

PREREQUISITE CHECK PERFORMED (read-only, no wallets or credentials inspected): no monerod process, no ~/.bitmonero or
stagenet data directory, no synced stagenet node and no known synthetic stagenet funds exist on this machine. The stagenet
rehearsal therefore still needs the setup below. Nothing was downloaded.

HOW TO RUN THE REAL STAGENET REHEARSAL (operator steps; none performed here)
Requirements: an owner-controlled monerod on STAGENET, fully synced (hours; tens of GB; `monerod --stagenet
--rpc-bind-ip 127.0.0.1 --rpc-bind-port 38081 --confirm-external-bind` or the equivalent on your server; never point the
harness at a mainnet node — it refuses, but do not try); Node 24; the built wasm engine
(holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm) and lab binary
(research/privacy-stagenet-roles-20261023-lab/target/release/xmr20-integration-lab); about 4 x 0.01 XMR of STAGENET
coins from a public stagenet faucet (worthless test coins; not real funds).

  cd research/privacy-stagenet-roles-20261023
  # 1. Choose the pool start height = the node's current height (replaying from the stagenet genesis is impractical).
  H=$(curl -s http://127.0.0.1:38081/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["height"]-1)')
  # 2. Build the trusted manifest for params/stagenet-v0 with that start height, OUTSIDE the parameter directory.
  node stagenet/make-stagenet-manifest.mjs params/stagenet-v0 --start-height $H --out runs/stagenet-trusted-manifest.json
  #    This file is the ONLY trust anchor: the roles load it as --trusted-manifest and the wallets ship it. Record its sha256.
  # 3. (Optional) run the parameter service yourself; otherwise the harness starts it on 127.0.0.1:8951.
  node stagenet/param-server.mjs --dir params/stagenet-v0 --port 8951
  # 4. Preflight: prints the three stagenet addresses to fund (issuer, wallet A, wallet B), then stops as "blocked".
  node stagenet/rehearsal.mjs --mode stagenet --rpc http://127.0.0.1:38081 --manifest runs/stagenet-trusted-manifest.json \
       --params-dir params/stagenet-v0 --wallet-dir runs/stagenet-wallets --out runs/rehearsal-stagenet.json
  # 5. Fund each printed address from a stagenet faucet (issuer: >0.01 XMR, ideally 3 separate outputs so three credit
  #    carriers can be built without waiting 10 blocks between them; A and B: any amount >0.01 XMR). Wait 10 confirmations.
  # 6. Run again with the SAME --wallet-dir (the roots persist there, mode 0600). The run waits for real blocks:
  #    credits (10 confirmations) + 3 transfers (10 each) ≈ 40+ stagenet blocks ≈ 1.5-2 hours. --max-wait-ms caps each wait.
  node stagenet/rehearsal.mjs --mode stagenet --rpc http://127.0.0.1:38081 --manifest runs/stagenet-trusted-manifest.json \
       --params-dir params/stagenet-v0 --wallet-dir runs/stagenet-wallets --out runs/rehearsal-stagenet.json
  # 7. Keep runs/rehearsal-stagenet.json as evidence (it contains addresses, txids, fees, sizes, timings; no secrets).
  #    Stagenet fees and decoy behaviour are NOT mainnet measurements; say so wherever the numbers are quoted.

WHAT THE STAGENET RUN WOULD STILL HAVE TO SHOW (unknown until executed)
- public stagenet nodes relay and mine a carrier with a 1,056-byte tx_extra (relay limit 1,060) and the 0-amount dummy
  output; monerod's sanity checks pass with real ring statistics (the fakechain accepted them once, which proves nothing
  about stagenet);
- real dynamic fee rate and decoy sampling rounds, proving/signing times on the operator's machine, confirmation handling;
- many-small-output input selection (faucet amounts) and the one-carrier-per-10-blocks limit per wallet output;
- the credit carriers from the issuer's stagenet wallet (issuer-funded; the holder never pays for credits);
- behaviour under a real uncertain broadcast (the harness re-sends the same blob; monerod must report it as known).

NOT CHANGED BY THIS MILESTONE
- The disposable single-party Groth16 setup (params/stagenet-v0 is bound to the stagenet genesis but is NOT a ceremony).
- The need for an independent security review (package in research/privacy-review-20261023/review).
- The bridge rollback-loss example and the native-trading asymmetric-finality loss; both gates stay closed.
- The verdicts: NO-GO for private transfers, migration, bridging and native XMR trading.
