# XMR20 independent read indexer 0.2.0

Run your own read-only XMR20 index from public Monero records and finalized
Solana account data. This package builds its own scan cache and SQLite database,
verifies Monero signatures locally, discovers deployments and escrow bindings
from chain data, and reconciles holder balances. **It does not fetch the XMR20
website catalog, primary balances, listing flags or an operator database.**

This remains an experimental source release. On 7 October 2026, an operator-run
mainnet rebuild from the published start completed using its own initially empty
database/cache with project API access blocked. Its accepted ledger matched a
replay of the preserved primary ledger source at the exact Monero height/hash.
**Complete live-primary accepted-state and same-slot backing parity remain
unverified.** See [dated evidence](LIVE_VERIFICATION.json). Independent indexing
makes the accounting inspectable; it does not make the operator-attested bridge
trustless or certify project security.

This source includes the deployed 0.2.0 runtime repair: correct CommonJS globals
in ESM bundles, whole-token retry when a finalized RPC bank is temporarily behind,
and paired enumeration/account reads with compensating pacing. Exact finalized-slot
equality, signatures, admission/accounting rules and the RPC read allowlist remain
unchanged. The source fingerprint is
`5a918c8f38da831627d8291ff4a35413697aef28e55a95f80ecd53027704238f`;
tests and documentation are outside that runtime fingerprint.

- [Protocol and admission rules](PROTOCOL.md)
- [Rebuild comparison, evidence and remaining trust assumptions](VERIFICATION.md)

## Build and test

Requirements: Node.js 24+, npm and Python 3.9+ on Linux or macOS. Python uses
only its standard library. Windows needs a Linux environment such as WSL.

From the repository root:

```sh
cd indexer
npm ci --ignore-scripts
npm test
```

Tests build the runtime first and use synthetic chain accounts and unfunded
identities. They do not contact chain nodes, start the service or move funds.
GitHub's indexer workflow runs the tests with network access disabled after
installing dependencies. `npm run build` builds without testing.

There are no dependencies on unpublished backend files or the wallet build.
`package-lock.json` pins npm dependencies. `build/source-manifest.json` identifies
the source used, and `build/hashes.json` contains runtime output hashes. See
[verification instructions](VERIFICATION.md) for a repeat-build comparison.

## Configure your nodes

```sh
cp config.example.json config.local.json
command -v node
```

Edit the ignored `config.local.json`:

- Set `node` to the absolute path printed above.
- Set `daemonUrls` to two distinct, synchronized Monero mainnet daemon endpoints.
  The example uses your own node at `http://127.0.0.1:18081` and a placeholder
  second peer. Choose the second peer yourself. Endpoints must provide
  `get_info`, `get_block_header_by_height`, `get_block` and `/get_transactions`,
  including historical transaction data.
- Set `solanaUrl` to your own or a chosen Solana mainnet RPC. It must support
  `getGenesisHash`, complete Token-2022 `getProgramAccounts` enumeration and
  `getMultipleAccounts`. A public rate-limited endpoint may be insufficient.
- Keep `replayHeight: null` to follow the chain tip. For an agreed comparison
  checkpoint, set it to a Monero block height at or after `bridgeStartHeight`.
  This pins Monero only; it cannot rewind ordinary Solana RPC account reads.
- Set `dataDir` to a writable directory dedicated to this reader. The example's
  `./state` is relative to the directory in which you start the process.
- `port` defaults to 8792; the HTTP listener binds to loopback.

HTTPS is required for remote endpoints. Plain HTTP is accepted only for the
literal loopback addresses `127.0.0.1` and `[::1]`. URLs cannot contain embedded
usernames/passwords or fragments. Monero endpoints also cannot contain queries.
Private RPC provider access details belong only in ignored local configuration.
No wallet seed, spend key, funded wallet or server credential is needed.

The public policy comes from the reviewed 5 October 2026 snapshot: scan start
**3,772,610**, transfer activation **3,773,055**, the configured deployment/credit
authority, the pinned V3 program, and two exact historical exclusions. These
settings determine the ledger, so review them and publish your policy hash with
your result. Independent discovery does not remove the authority requirement
or make deployment admission permissionless.

## Run a rebuild

```sh
npm start
```

In another terminal:

```sh
curl --fail http://127.0.0.1:8792/health
curl --fail http://127.0.0.1:8792/api/xmr20/tokens
curl --fail http://127.0.0.1:8792/verification > my-report.json
```

The first run scans from the configured start, not the current tip. A full
rebuild requires historical RPC access, time, storage and memory; no measured
mainnet completion estimate is available for this release. Progress is saved
between bounded scan passes and restarts. Retain your state directory to resume;
choose a new, empty directory for a rebuild without cached data.

`/health` returns HTTP 503 until reconciled or when delayed. `/verification`
returns HTTP 503 without a fresh publication. A responding server, an empty
catalog or a stale holder response is not proof of a finished rebuild. Read
`ready`, `complete`, `stale`, checkpoint heights and any `replayHeight` setting.
Stop the service with Ctrl-C.

The service requests no XMR20-operated API. You can block those domains while
rebuilding, provided your chosen node endpoints remain reachable. The dated
operator run completed with systemd network isolation and startup probes confirming
project API access blocked; its separate observer can read the primary and does not
feed the scanner. This is operator-run evidence, not an independent audit or a
guarantee that another operator has reproduced it. The offline CI suite tests
source behavior with synthetic evidence.

## Read API

| Route | Purpose |
| --- | --- |
| `/health` | Readiness, progress, delay reason and pinned replay height |
| `/api/xmr20/tokens` | Chain-derived declarations; `catalogSource: "chain"` |
| `/api/xmr20/tokens/<deployment-txid>/holders` | Reconciled holders and backing |
| `/api/wallet-holdings?address=<address>&network=monero` | Indexed holdings |
| `/api/xmr20/wallet-holdings` | Holdings alias; also accepts `network=solana` |
| `/verification` or `/api/xmr20/verification` | Checkpointed ledger/backing report |

Token IDs are the **64-character Monero deployment transaction hash**, not the
primary site's launch UUID. Ticker and creator come from the declaration;
artwork and human-readable metadata are not fetched. This is not yet a tested
drop-in backend for the existing wallet.

An `unbound` declaration has no matching escrow and asserts no token balance.
A credited declaration with missing backing, an ambiguous escrow, incomplete
accounts or inconsistent evidence prevents publication. Listing flags from the
primary cannot hide a token. The published historical policy exclusions still
apply.

Holdings pagination uses `after` and `revision`; restart on HTTP 409. Respect
freshness and completion flags even on HTTP 200. Pending receipts return HTTP
501; POST returns HTTP 405. There is no transaction signing, bridge submission,
withdrawal approval or recovery endpoint. The internal `--calculate` library
path remains for older fixtures; the service uses `--discover-calculate`.

## Compare operators

After both operators have built their own databases and exported reports:

```sh
npm run compare -- my-report.json other-report.json
```

A full `MATCH` requires equal rules/policy, Monero checkpoint and per-token
Solana checkpoints. Different heights or slots are reported as not comparable,
not automatically as dishonest balances. Ordinary Solana `minContextSlot` does
not select a historical slot. Reports expose public XMR20 holder addresses and
amounts; they contain neither private keys nor native-XMR wallet balances.

A report hash is a comparison tool, **not an authentication or consensus proof**.
Someone can invent a self-consistent report. Compute your own from independently
chosen nodes and compare it; do not trust a downloaded report merely because
its hashes match its contents. See [VERIFICATION.md](VERIFICATION.md).

## Source and licence

`src/probe_rules.py`, `launch_rules.py` and `bridge_rules.py` define parsing,
signatures and scanning. `replay.mjs` defines ledger admission and supply;
`discovery.mjs` derives escrow bindings; `accounting.mjs` checks raw Solana
accounts; `verification.mjs` defines reports. Legacy signing domains and PDA
seeds are protocol bytes and must not be renamed for branding.

`SOURCE_PROVENANCE.json` records historical extraction inputs, not hashes of the
modified release or proof of live-service parity. The build generates current
source/runtime hashes. Original code follows the repository MIT licence;
dependencies retain their own licences. The Monero runtime licence is copied
alongside the built library. The signature verifier creates a temporary,
unfunded in-memory wallet object because its library requires one; no existing
wallet is opened or exported.
