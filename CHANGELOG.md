# Wallet changelog

## 0.1.96 source update — 23 October 2026

- Saved bridge screen: when XMR is reserved by a bridge you started but never approved on Solana, "Finish your saved bridge" shows that exact transfer (amount, route, what you receive, time left) with **Continue** and **Cancel bridge**. Cancel asks once ("Keep it" / "Yes, cancel"). The wallet engine then waits until every Solana approval made so far has expired (finalized height past the confirmed height at the start + 160 blocks), requires the custody receipt to be absent in a finalized read, and only then marks the saved bridge `cancelled` in the encrypted funding journal, which frees the unsigned fee coin. A bridge with a signed Monero transaction, or whose deposit reached Solana, cannot be cancelled. Saved entries show "Cancelled".
- Bridge progress: one step tracker from Solana deposit → Monero transaction → send → 10 confirmations, with the xmrchain link once the network accepts the transaction. The finished Monero transaction step shows how long each part took (bridge service, wallet catch-up, building, signing); the service request and the wallet catch-up now run at the same time.
- Phantom compatibility for holder deposits: the custody adapter accepts a holder approval to which the wallet added only a bounded priority fee (ComputeBudget) or pinned Lighthouse guards, with every reviewed instruction, account and signer unchanged; anything else is still refused.
- Native engine artifact `native-package/market/native-wallet/runtime.js` 8762a65b… → 96b873b3… (cancel action, Solana height reads, the custody adapter change above, and the replay-guard digest reuse already published in `services/native-market/xn1/replay.mjs`). Engine sources outside this repository are unchanged otherwise; worker, transport, monero-ts and signer bytes are identical to 0.1.95.
- Not verified here: a real Cancel of a reserved bridge, and the build-step timing on a funded bridge. The website wallet screens that share these pages are not part of this repository.

## 0.1.95 source update — 22 October 2026

- Publish the wallet source that the installed XMR20 Wallet 0.1.95 package was built from: the native (operator-verified) Monero bridge pages (Bridge to Monero, Bridge to Solana, Monero token send, finished-setup detection), the premium compact bridge panels, the Bridge window with Tokens | SOL ↔ XMR tabs and the ChangeNOW SOL ↔ XMR exchange page (quote → review → saved request → create → pay through the normal Send screen → status/recovery).
- Publish the native-market client sources the pages depend on for the first time: `services/native-market/` (operator custody, credit preparation and redemption clients, signature/funding journals, XN1 records, carrier and replay), `bridge/core-monero-send/` and `bridge/core-fast-send/`, plus the shared address/protocol/amount helpers under `shared/`.
- Native wallet engine files (`native-package/market/native-wallet/`) are shipped as pinned artifacts with their hashes; the signer is built from a separate Rust crate that is not in this repository. `npm run build:native` assembles the native package layout and reports which outputs match the installed package.
- Wallet-side status fix: a saved bridge publication that only the unrestricted Monero peer can still see is reported as accepted (with relay proof) instead of a failed publish, so the UI no longer offers a misleading retry.
- Website holdings reader (`services/wallet-index`): every launched token is read directly at finalized commitment when the independent reader does not track it, so tweet-launched tokens appear in website wallets.
- 554 public tests pass (`npm test`); `build:bridge` passes. One extension test (native carrier worker) is not published because it loads `monero-ts` from the private website workspace.
- Not verified here: a funded native bridge on this exact source, a funded ChangeNOW exchange, and the website wallet screens (not part of this repository). The published build is not byte-identical to the installed 0.1.95 package: that package was bundled from a multi-workspace dependency tree with a duplicated Solana client stack, and the source has two later edits (swap page `open(requestId)`, bridge page `resumeFrom` wording option) that are covered by tests.

## Server carrier own-node transport — 20 October 2026

- Prefer the owned Monero node for native carrier synchronization and first publication, while retaining independent checkpoint verification and bounded fallback.
- Connect the server's Docker carrier to the existing private SSH tunnel through a loopback-only connector with privilege dropping and automatic restart.
- Preserve signed amounts, fee limits, input reservations, recovery records and confirmation requirements. No extension version or bundled client package changes in this update.
- Publish the server source and 83 passing regression tests in `bridge/core-universal-link/carrier-host/`. Private configuration and operational receipts are excluded. Readiness checks remain several seconds; this is not an instant-startup claim.


## 0.1.57 source update — 19 October 2026

- Link Solana and Monero wallets once for supported tokens, with separate preparation and final confirmation labels.
- Resume saved wallet-link progress when reopening Bridge with no token balances; Back remains usable and explicit token recovery is preserved.
- Share catalog/snapshot reads, bound connection checks, preserve cached balances for display, and coalesce popup updates.
- Show compact token balances, token images and clearer bridge and Monero-send forms.
- Keep exact signing amounts, one token fee, ten confirmations, both signatures and public recovery receipts.

Source only: no replacement ZIP, website deployment or service deployment is included. Existing packaged 0.1.28 artifacts remain unchanged. Current source requires the compatible universal-link deployment; the build selects its public program pin explicitly. Full-wallet performance and funded end-to-end behavior are not established by unit tests.

## 0.1.28 — 14 October 2026

Current installable wallet: `extension-bridge/`. The separate `extension/` output remains the older 0.1.14 developer preview.

- Bring GitHub up to date with the saved-return fixes previously installed as 0.1.27.
- Use the public wallet RPC proxy for Solana bridge checks, with one bounded deadline and concurrent independent reads. Provider keys stay on the server.
- Show preparation progress and errors beside the action; preserve the existing bridge when preparation expires or a response is lost.
- Keep an already signed approval recoverable instead of inviting another signature after uncertain submission.
- Include the shared deposit approval compatibility for narrowly defined read-only wallet safety assertions. Reject changes to reviewed transfers, fees, destinations, signers and other instructions.
- Keep Max controls, held-token filtering, independent balance refresh, recovery receipts and one transfer-tax deduction.
- Preserve extension identity, permissions and dependency versions. No vault migration is required.

The latest funded Phantom retry and a funded two-holder round trip on the newer program are not verified. Monero confirmations and provider delays still apply. This remains an upgradeable, unaudited testing release.

## 0.1.26 — previous GitHub wallet

Kept unfinished legacy returns visible after the Monero burn and resumed the existing receipt from the generic Bridge action. See `BRIDGE-TESTING.md` for earlier dated verification.
