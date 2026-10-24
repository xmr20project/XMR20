STAGENET-AWARE LABORATORY ROLES, PARAMETER SERVICE AND TWO-WALLET REHEARSAL HARNESS
research/privacy-stagenet-roles-20261023 (+ lab crate research/privacy-stagenet-roles-20261023-lab), 23 October 2026.
Continues research/privacy-stagenet-rehearsal-20261023 (unchanged) and the hardened verifier lab crate (copied, unchanged).
Synthetic wallets and worthless stagenet faucet coins only. UPDATE 24 Oct 2026: the rehearsal HAS NOW BEEN EXECUTED ON
PUBLIC STAGENET (owner-authorised; isolated pruned node; see runs/stagenet/STAGENET-RUN.txt and the "EXECUTED ON STAGENET"
section below). Everything else in this file that is labelled SIMULATED ran on an offline zero-peer regtest fakechain.
Readiness is unchanged (NO-GO everywhere; bridge payouts and native XMR trading gated). Mainnet is refused by every component.

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

EXECUTED (SIMULATED, offline fakechain): node --test stagenet-roles.test.mjs — see RESULTS.txt (4/4, rerun after every fix).

EXECUTED ON STAGENET (24 Oct 2026; full detail, txids, fees, sizes and timings in runs/stagenet/STAGENET-RUN.txt)
- Node: the already-present Monero v0.18.5.3 monerod (provenance re-verified against binaryFate's signed hashes) run as an
  isolated pruned stagenet node (operations/stagenet-node-20261023; loopback RPC 38091; outbound-only p2p; 6.3 GB).
  Sync 21:50Z–03:04Z. Owner-authorised CPU mining (6 threads, ~2.2 kH/s) sped the slow stagenet up a little; none of the
  six carrier-bearing blocks was ours.
- Faucet: cypherfaucet.com API (0.01 sXMR per address per hour, one claim per IP per hour, no human step); six claims.
- Trusted manifest runs/stagenet/trusted-manifest.json (startHeight 2,235,745); wallet roots in runs/stagenet/wallets
  (not published); addresses derived before the sync finished with stagenet/addresses.mjs.
- Result (attempt 3, 3 h 02 min): 4 credit carriers (one surplus from attempt 1, reused/baselined — no replacement credits),
  T1 one-input, recovery of both wallets from roots, T2 three-input, T3 two-input; exact change and exact holder-paid fees
  (50,760,000 / 50,780,000 / 50,660,000 piconero at 20,000 piconero/byte — stagenet, not mainnet); 1,056-byte tx_extra
  carriers accepted WITH sanity checks, relayed to and confirmed (10) by a third-party public stagenet node; same-blob
  re-send idempotent every time; tokens conserved (A 14,500,000 incl. 5,000,000 baseline, B 500,000).
- Two defects found by stagenet and fixed (never by weakening validation): the lab issuer ignored the 10-block spend lock
  (daemon: "output which is too young") and the harness could not resume after an interrupted attempt. Attempts 1 and 2
  are preserved (rehearsal-stagenet-attempt1-too-young.json, rehearsal-stagenet-attempt2-node-stopped.json); attempt 2
  ended because a free-space watchdog stopped the node when ANOTHER session's git packing filled the disk.
- New tools: stagenet/addresses.mjs (funding addresses without a synced node), stagenet/faucet-claim.sh (faucet API),
  harness options --public-rpc (third-party observation) and --param-port; harness steps resume / wait-unlock /
  public-relay / public-confirmation / mining-status.

HOW TO RUN (OR REPEAT) THE STAGENET REHEARSAL (operator steps; performed on 24 Oct 2026 as described above)
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

WHAT THE STAGENET RUN SHOWED (24 Oct 2026) AND WHAT IT STILL DOES NOT SHOW
Shown: third-party stagenet nodes relay and mine 1,056-byte tx_extra carriers with the 0-amount dummy output under
monerod's sanity checks; real dynamic fee rate (20,000 piconero/byte) and 16-member rings from the real distribution;
proving 35-36 s / signing 81-91 ms / ~400 MB on this machine; 10-block confirmation handling; the 10-block spend lock on
small faucet outputs (which exposed the issuer defect); issuer-funded credits; idempotent same-blob re-send; recovery from
roots in fresh instances; resume across interrupted attempts without duplicate credits.
Not shown: mainnet fees, decoy statistics or miner policies; a real lost-reply / reorganization case (only the re-send
path was exercised); the behaviour of the disposable Groth16 setup under review; constant-time safety; anything that
would change the readiness verdicts.

NOT CHANGED BY THIS MILESTONE
- The disposable single-party Groth16 setup (params/stagenet-v0 is bound to the stagenet genesis but is NOT a ceremony).
- The need for an independent security review (package in research/privacy-review-20261023/review).
- The bridge rollback-loss example and the native-trading asymmetric-finality loss; both gates stay closed.
- The verdicts: NO-GO for private transfers, migration, bridging and native XMR trading.
