# Wallet changelog

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
