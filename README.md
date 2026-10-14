# XMR20 Wallet and Read Indexer

## Telegram bot

Launch and trade XMR20 tokens in [@XMR20_Bot](https://t.me/XMR20_Bot). [Bot source, setup and custody details](telegram-bot/README.md) are in `telegram-bot/`. Each user receives a separate Turnkey wallet; Helius handles Solana access.

Open-source XMR20 Chrome wallet and experimental read-only token indexer.

## Current wallet — 0.1.28

**[Download wallet 0.1.28](https://github.com/xmr20project/XMR20/releases/download/v0.1.28/xmr20-wallet-bridge-0.1.28.zip)** · [Release notes](https://github.com/xmr20project/XMR20/releases/tag/v0.1.28) · [What changed](CHANGELOG.md)

Use **`extension-bridge/`** for the current wallet with hosted bridge support. The separate `extension/` directory is the older **0.1.14** preview; it is kept for compatibility and is not the current bridge wallet.

For an existing wallet, replace the installation files in its current folder, then click **Reload** in `chrome://extensions`. **Do not uninstall**: keep the encrypted accounts and saved bridge receipts associated with the same extension. See the installation steps below.

This is a testing release, not an independently audited production wallet.

## Bridge wallet

The latest bridge work is included in source and the installable `extension-bridge/` build. It supports any linked wallet and tokens whose XMR20 launch proofs and Token-2022 configuration pass verification. The earlier cumulative 1 XMR20 test limit does not apply to this build.

- Deposit from Solana into your linked Monero position.
- Airdrop to another registered Monero holder.
- Transfer a balance to another registered Monero holder, who can withdraw to their own linked Solana wallet.
- View exact token fees and destinations, keep public recovery receipts, and resume interrupted operations.
- Approve a return once and let it finish while the wallet stays open and unlocked. Closing, locking, changing account or pausing stops automatic signing.

**This is an upgradeable, unaudited testing release.** The deployment wallet can still change the program. A verifier co-signature remains required for transfers and withdrawals, and refusal or lost keys can prevent withdrawal. XMR20 links and token transfers are public protocol records; these are not private native-XMR transfers. Ten Monero confirmations remain required. The receiving wallet must register its link for the selected token before receiving it.

A real self round trip has completed; the two-holder path passes compiled-contract tests but has not yet completed a funded mainnet test. See [verification and test instructions](BRIDGE-TESTING.md).

The testing build connects directly to the hosted gateway at `https://api.xmr20.org`. No local connector or SSH forward is needed. The gateway serves the website and the pinned XMR20 extension identity; it restricts routes, request size and public Solana read methods. Financial instructions still require their original signatures and proof validation. The testing program remains upgradeable.

Version 0.1.24 refreshes SOL, indexed holdings and bridge balances independently, so a slow bridge read does not hold up every balance. It shows account-specific last-known balances immediately and checks fresh SOL using bounded public reads. Accounts without a funded bridge position can skip the full Monero-history replay after fresh deployment and finalized position checks. The bridge explains index catch-up and resumes status and amount checks automatically; incomplete history never enables approval. Max controls, exact fees, saved approvals and recovery receipts are preserved. Cached data never authorizes spending. Network and Monero confirmation delays still apply.

Version **0.1.28** adds bounded Solana verification through the public wallet RPC proxy, clearer progress and preparation errors, safer recovery after an expired or uncertain approval, and the latest narrowly checked wallet-safety instruction compatibility. It retains held-token filtering, Max, exact token fees, cached balance display and recovery receipts. A funded Phantom retry for the latest compatibility change is still pending; this release does not claim all bridge delays or failures are resolved.

## Features

- SOL, native Monero and indexed XMR20 holdings with price estimates.
- Local encrypted accounts, imports, watch-only accounts and inactivity locking.
- Native and XMR20 transfers with explicit review and approval.
- Built-in XMR20 token bridge in both directions between Solana and Monero.
- Account-approved connections to `https://xmr20.org` and the local review origin `http://127.0.0.1:8893`.

## Build and test

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm test
```

Build the new bridge candidate separately:

```sh
npm run build:bridge
```

Load `extension-bridge/` for version 0.1.28. The hosted gateway is used automatically. The optional local connector remains available only for explicit development profiles. `npm run build` continues to produce the ordinary `extension/` build.

Tests build the extension first. To build without running tests, use `npm run build`.
The test suite uses disposable keys and mocked network responses; it does not move real funds.

## Install or update in Chrome

Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** with the extracted wallet folder (containing `manifest.json`), or `extension-bridge/` from this repository, for bridge testing 0.1.28, or `extension/` for the ordinary preview. For an existing installation, replace the files in its current directory and click **Reload**. Do not uninstall an existing wallet just to update it. Keep recovery material backed up privately.

The manifest contains a **public** key to preserve extension identity. It is not a wallet private key. Preserve this key when rebuilding.

## Scope and limitations

The wallet portion contains extension source, installable builds, unit tests, the shared bridge client modules in `bridge/`, public pricing fixtures, the hosted gateway in `services/transferable-gateway/`, and two small service integration modules used by tests. The separate `indexer/` directory contains the read-only second indexer. This repository does not contain the full XMR20 website, primary transaction service, deployment credentials, browser profiles, user wallets, recovery phrases or transfer receipts. No service deployment is performed by building or testing this repository.

Private keys are stored in the password-encrypted local vault. Unlocked key material exists in memory while the wallet is in use. This is a developer preview, not an independently audited production wallet. The existing operator-attested bridge requires SOL for Solana network/account fees and explicit approvals. See [bridge notes](BRIDGE-0.1.14.md).

Third-party notices and vendor licenses are included under `extension/`.

## License

Original project code is available under the [MIT License](LICENSE). Bundled third-party code retains its original licenses and notices. The `private` setting in `package.json` prevents accidental npm publication; it does not restrict this source license.


Bridge now opens with tokens held by the selected wallet, plus tokens with unfinished public receipts. Catalog discovery supplies names only. Empty portfolios have a refresh and receipt-recovery path; incoming balance updates preserve the selected token and draft amount. Cached balances are for display and never authorize spending.

## Balance reader update 0.1.25

The shared public endpoint now binds the independent reader’s verified holdings to the wallet’s original token IDs. Wallet freshness accepts that reader’s fixed ten-minute policy while retaining explicit stale/error states. Saved balances remain display-only; fresh transaction verification and approvals are unchanged. Update an existing extension in place and Reload; preserve its encrypted vault and receipts.

The generic Bridge button opens the earlier return route when only earlier-custody Monero balances are present and the new bridge has no active choices/recoveries. Existing new-bridge requests, saved approvals and explicit token selections remain in their original flow. A single earlier token skips the network/token picker; several show the earlier-token choices. Existing signing, proof and fee checks remain mandatory.

## Saved-return recovery 0.1.26

An unfinished legacy return remains visible after the Monero burn consumes its token balance. The home screen shows the exact amount due on Solana and a Check and continue bridge button. Generic Bridge also resumes the saved return when no new-bridge asset is available. Resume re-reads the existing owner-bound server receipt and never creates another bridge or burn. Cached recovery state is labeled Last saved. Completed and cancelled receipts leave the recovery list.

## Read indexer

The standalone [indexer source and instructions](indexer/README.md) are in `indexer/`. It rebuilds its own state from public Monero records and finalized Solana account data, with local signature verification. Build it separately with Node.js 24+, Python 3.9+ and its own npm lockfile.

The reader discovers token declarations and escrow bindings from chain data, without the XMR20 website catalog or primary database. Operators can use their own node endpoints and compare checkpointed verification reports. The repository includes [published rules](indexer/PROTOCOL.md), [verification instructions and remaining trust assumptions](indexer/VERIFICATION.md), synthetic tests and GitHub checks.

A mainnet rebuild from the published scan start completed on 7 October 2026 with project API access blocked. Its accepted ledger matched a replay of the preserved primary ledger source at the same Monero height and block hash. The runtime repair used by the live second indexer is included here; [dated verification evidence](indexer/LIVE_VERIFICATION.json) records its source fingerprint. **Complete parity with the running primary service, including its accepted events and backing at equal Solana slots, remains unverified.** Open source and matching reports do not certify bridge security: deployments and credits still require the configured authority, and withdrawals remain operator-attested. The reader does not sign or authorize withdrawals.

## Published protocol and service sources

The transferable ABI 3 Rust program and pinned Cargo lock are in `bridge/core-transferable/program/`. Public record formats, SDK and wallet validation are in `bridge/core-transferable/`; the independent indexer and protocol rules are in `indexer/`. The read-only wallet adapter is in `services/wallet-index/`. The root MIT license covers original project code; third-party licenses remain unchanged. This release does not include the complete primary operator backend or the separate mining/NFT launch under development. Private keys, server settings and user data are excluded. Open source does not mean independently audited or production-ready.
