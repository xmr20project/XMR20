# Bridge testing — 0.1.26


## Verification on 12 October 2026 (0.1.26)

- Four additional recovery checks cover zero Monero balance after a burn, exact owner/receipt/fee scope, completed/duplicate receipts and one net token fee calculation. Full candidate build/test results are recorded with this release.
- The home screen retains unfinished legacy returns and the generic Bridge route can resume them. Fresh server receipt, chain proof, exact transaction and user approval remain required.
- A real legacy peer transfer reached a confirmed Monero burn and was awaiting its final Solana unlock. The unsigned preparation experienced a Solana verification provider failure. A narrow backend proof-read fallback was deployed without changing signing, transaction or fee policy. A complete peer withdrawal is not claimed until a finalized destination receipt is verified.

## Prior verification on 12 October 2026 (0.1.25)

- 256 candidate tests passed, and both ordinary and bridge extension builds passed. Dependencies, extension identity and permissions remain unchanged.
- Both wallet clients accept only the independent public reader's fixed ten-minute freshness policy. Incomplete and explicitly stale balances remain last-known display data. Cached balances never authorize spending.
- When the new Bridge picker is empty and the selected account holds legacy Monero tokens, the generic Bridge button opens the existing withdrawal route. A single token opens its amount form directly; multiple legacy tokens show the token chooser. New-bridge holdings, unfinished recoveries and explicit token requests stay in their original flow. No balance is migrated or relabeled.
- Actual bridge components were checked at 390 px and 700 px with synthetic unfunded accounts and financial requests blocked. The correct Monero → Solana form and Max were present. No funded withdrawal occurred in this verification.
- The shared public balance endpoint returned the completed legacy send's correct sender debit and recipient credit; both current clients accepted the complete, non-stale results. Measured reads were 0.695 and 0.674 seconds. Upstream delays and confirmation times still apply.
- The received-token route is legacy custody; it does not demonstrate the funded two-holder path for the new joint-v3 program. That funded path, security review, Chrome Web Store distribution and production campaign enforcement remain unverified.

## Prior verification on 12 October 2026 (0.1.24)

- 250 wallet tests and six hosted-gateway tests passed from this self-contained source candidate. Both ordinary and bridge extension builds passed.
- New coverage checks that Bridge opens on a token held by the selected wallet, keeps unfinished receipts recoverable, handles an empty portfolio, and preserves the chosen token, amount and direction when balances or catalog names arrive later. Catalog discovery cannot add unowned tokens or authorize spending. A regression with two open bridge panels verifies that controls, progress and focus stay within their own panel.
- Tests reused the previous clean publication's installed dependencies after checking that the dependency lock differs only in this package's version. No new dependencies were downloaded. The temporary dependency link and generated test modules were removed from the source payload before scanning and packaging.
- The final local connector and gateway fixture suites ran with localhost access and passed all tests. No real wallet, funded transaction, mining process, browser session or live bridge service was used by these checks.
- The package preserves the extension identity, public manifest key and permissions. GitHub publication and installation/reload in Chrome have not been verified by this package preparation.

## Prior verification on 12 October 2026 (0.1.23)

- 235 wallet tests and six hosted-gateway tests pass from this self-contained source layout. Both the ordinary and bridge extension builds pass. The added coverage checks independent balance refresh, bounded public SOL reads, account isolation, finalized zero-position reads, and recovery from incomplete history without automatic signing.
- The runtime client exposes only the fixed public index-catch-up reason. Unknown service errors stay generic; response bodies are not displayed as internal diagnostics.
- The test run reused the prior publication's installed packages, which match the unchanged dependency lock. A fresh dependency download was not repeated for this update. CI still installs from the lock before running tests.
- No funded transaction, peer transfer, extension reload, browser-storage change or service deployment was performed by these publication checks. Neither test results nor this build promise a five-second full bridge confirmation.

## Prior verification on 10 October 2026 (0.1.22)

- 215 extension tests passed, including exact account/message signing, saved-receipt recovery, single-action return cancellation and the all-wallet interface.
- 328 bridge checks passed in the development workspace. They include real compiled Solana custody execution with disposable keys: deposit 2 tokens, credit 1.97 after the fixture tax, transfer 1.97 between different Monero holders, then withdraw 1.94045 to the recipient’s different Solana wallet. The transfer itself charges no second token tax. These are synthetic balances, not a funded peer-transfer claim.
- The extension was also built from a fresh npm dependency installation in an isolated publication directory; its 215 tests and both builds passed without workspace dependency symlinks.
- Mainnet self round trip: 1 XMR20 deposited, 0.985 credited on Monero, 0.970225 returned to the original Solana wallet after the token’s two transfer taxes. [Finalized return](https://solscan.io/tx/qEZGttzhQEk3ZTrRoGPn1eEQoBLbmWVChXoPVHQ9Zmf4VnvqWDDXfnDkUjGpsK5H74LpS9Z39ZK4NDxG9wChavv).

## Try a transfer between holders

1. Unlock wallet B, select the token in Bridge and register its linked wallets if asked. Wait for the Monero link confirmation; the service continues registration after the wallet closes.
2. In wallet A, select the same token, enter the amount and approve the displayed deposit. Wait for the confirmed Monero balance.
3. In A, choose “Send to another Monero wallet” and enter B’s registered Monero address. Review and approve the native record, then complete the saved transfer after confirmations. This path still requires the linked Solana owner’s approval.
4. Open B. Confirm its credited balance and choose “Bridge back to my Solana wallet”. Check the exact fee and destination, then click “Bridge to Solana”. Keep B open and unlocked for automatic completion, or resume after reopening.

Never uninstall an existing wallet to update it. Replace its existing installation files and Reload in Chrome so encrypted accounts and public receipts remain associated with the same extension identity. The manifest key is public and intentionally unchanged.

## Boundaries

The program is `8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB`. Testing requires its exact reviewed bytes and retained upgrade authority. Ordinary/public admission still requires immutable code; this separate testing profile does not change that rule. Unknown tokens, invalid launch proofs, changed code, stale or incomplete history, changed fees and incorrect signatures remain rejected.

The operator remains on loopback behind the hosted HTTPS gateway. The 0.1.25 extension uses that gateway directly; no local helpers need to stay open. Six gateway tests cover exact extension/website origins, bounded requests, preflight and read-only Solana RPC admission. Public HTTPS reads were checked from both trusted origins. A Chrome Web Store release, a funded two-holder test, independent security review, and production airdrop/sale/whitelist enforcement are not certified by these tests. No deployment or wallet operation runs during npm installation, build or tests.
