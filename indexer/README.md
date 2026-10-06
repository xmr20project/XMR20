# XMR20 read indexer

Experimental, read-only source release of the second XMR20 token indexer. It
replays public Monero inscription records, verifies their signatures locally,
and checks finalized Solana escrow receipts, supply and holder accounts. It can
build its own SQLite database and scan cache without an operator wallet or a
copy of the primary database.

**This is not yet fully independent token discovery or a trustless bridge.**
Token discovery and launch-to-escrow bindings still use the primary public
catalog. Complete mainnet replay and comparison with the primary at matching
checkpoints have not been verified for this source release. Do not switch a
funded wallet to this reader merely because its HTTP server is reachable.

## Build and test

Use Node.js 24 or later, npm, and Python 3.9 or later on Linux or macOS. Python
uses only the standard library. Windows requires a Linux environment such as
WSL because the service uses POSIX file locking and subprocess pipes.

From the repository root:

```sh
cd indexer
npm ci --ignore-scripts
npm test
```

Tests build the runtime first. `npm run build` builds without running tests.
The package has its own dependency lockfile; it does not depend on the wallet
extension, an unpublished backend checkout or local dependency pools. Building
and testing do not start a scanner or contact blockchain nodes. Tests use mock
chain data and unfunded synthetic identities. Generated output is in `build/`.

## Configure and run

```sh
cp config.example.json config.local.json
command -v node
```

Edit `config.local.json` before starting:

- Replace `node` with the absolute path printed by `command -v node`.
- Replace both `daemonUrls` placeholders with distinct HTTPS Monero mainnet
  daemons. The reader needs `get_info`, `get_block_header_by_height`,
  `get_block` and `/get_transactions`, including historical transaction data.
- Replace `solanaUrl` with an HTTPS Solana mainnet RPC that supports
  `getGenesisHash`, complete `getProgramAccounts` enumeration and
  `getMultipleAccounts`. Rate-limited public providers may be insufficient.
- The default `catalogUrl` is the primary public XMR20 token catalog. An
  alternative must provide the same schema and authoritative historical
  bindings; changing the URL does not itself establish independent discovery.
- `dataDir` is this reader's own writable state directory. Run from `indexer/`
  when using the relative `./state` example, or choose an absolute path.
- `port` defaults to 8792. The HTTP listener binds to loopback only.

Then run explicitly:

```sh
npm start
```

In another terminal:

```sh
curl http://127.0.0.1:8792/health
curl http://127.0.0.1:8792/api/xmr20/tokens
```

The first run scans from Monero block **3,772,610**, not the current tip. It can
take substantial time and RPC traffic; no measured completion estimate is
provided. Progress is saved between bounded scan passes and process restarts.
`/health` returns HTTP 503 while syncing or delayed, and balance reads remain
unavailable until reconciliation. A running HTTP server is not proof of a
finished rebuild. Stop with Ctrl-C; retain your local state to resume later.

Public policy in the example comes from the reviewed 5 October 2026 policy
snapshot. Transfer activation is **3,773,055**. The public deployment authority,
bridge program IDs and two historical deployment exclusions are verification
inputs, not secrets. Changing them changes which ledger you compute. Scanner
`address` and `policy.operatorAddress`, and both transfer-height settings, must
stay consistent. This release does not attest that future server policy remains
identical to this snapshot.

Endpoints require HTTPS. Monero/catalog URLs reject embedded credentials,
queries and fragments. Use a TLS endpoint/proxy for a local node; plain HTTP
localhost is not supported by this unchanged transport. Keep any private RPC
access details in ignored local configuration, never in Git.

## Read API

| Route | Purpose |
| --- | --- |
| `/health` | Replay progress, readiness and delayed state |
| `/api/xmr20/tokens` | Catalog with its source and freshness metadata |
| `/api/xmr20/tokens/<id>/holders` | Reconciled holders and backing for one token |
| `/api/wallet-holdings?address=<address>&network=monero` | Indexed holdings |
| `/api/xmr20/wallet-holdings` | Holdings alias; also supports `network=solana` |

Holdings pagination uses `after` and `revision`; restart on HTTP 409. Respect
`complete`, `stale`, missing snapshots and HTTP errors. Pending receipts return
HTTP 501 and POST requests return HTTP 405. There is no signing, relay,
withdrawal authorization, wallet recovery or bridge submission endpoint.

## Verification and limitations

- Both Monero peers must agree on checked block hashes and relevant carrier
  payloads. This is an RPC-based reader, not a full Monero consensus node;
  two URLs do not prove independent operators or honest responses. Choose
  providers you trust, ideally including your own validating node.
- The primary catalog supplies token discovery, version bindings and listing
  flags. Saved entries survive temporary outages, but this release cannot
  promise to discover every token if the primary disappears. Listing decisions
  can affect what is included. Public source alone does not remove this trust.
- Original deposits are checked against finalized receipt accounts. Program
  binaries must match the published hashes and be immutable. All Solana reads
  within one token must share exactly the same finalized slot. Different tokens
  may use different slots; there is no single atomic cross-chain snapshot.
- Busy RPC providers may repeatedly return different slots; publication then
  stays delayed. Missing or invalid evidence is not replaced with a zero balance.
- No complete live replay, current primary parity, funded wallet failover or
  independent security audit is certified by the local tests. Reorg handling is
  tested on synthetic data; deep reorg recovery after a bridge release is not
  proven by this read-only service.
- XMR20 records expose token amounts and relevant addresses. These are public
  application records, not private native-XMR payments or Monero consensus
  balances. Operator-attested withdrawals remain separate from this reader.
- The current scanner persists a JSON cache and replays retained events. Work,
  storage and memory grow with history. Validation also has explicit event and
  account-count limits; this is not an unlimited or performance-certified node.
- The verification library creates a temporary unfunded wallet object in memory
  because its signature-check API requires one. No existing wallet, recovery
  phrase, spend key or funded identity is required or exported.

To compare independent runs, use the same policy and Monero block hash/height,
and identical finalized Solana slots for each token. Compare exact integer
amounts and accepted operations; matching tickers or similar totals is not
sufficient. Publish the source version, policy, checkpoint and discrepancies.

## Source layout and licensing

`src/probe_rules.py`, `launch_rules.py` and `bridge_rules.py` preserve the
read-only functions selected by the second indexer's pinned build. `scanner.py`
binds them to the allowlisted gateway. `replay.mjs` contains ledger and supply
rules; `accounting.mjs` checks raw Solana evidence. Legacy signing-domain strings
and PDA seeds are protocol bytes and must not be renamed as branding changes.
`SOURCE_PROVENANCE.json` records the input file hashes for this extraction;
it is not proof of current live process parity.

The original project code follows the repository's MIT licence. npm dependencies
retain their own licences. The build copies the Monero library licence alongside
its runtime. This source package excludes private configuration, server access,
operational backups and the primary transaction workers.
