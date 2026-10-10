# Bridge testing — 0.1.20

## Verification on 10 October 2026

- 196 extension tests passed, including exact account/message signing, saved-receipt recovery, single-action return cancellation and the all-wallet interface.
- 327 bridge checks passed in the development workspace. They include real compiled Solana custody execution with disposable keys: deposit 2 tokens, credit 1.97 after the fixture tax, transfer 1.97 between different Monero holders, then withdraw 1.94045 to the recipient’s different Solana wallet. The transfer itself charges no second token tax. These are synthetic balances, not a funded peer-transfer claim.
- The extension was also built from a fresh npm dependency installation in an isolated publication directory; its 196 tests and both builds passed without workspace dependency symlinks.
- Mainnet self round trip: 1 XMR20 deposited, 0.985 credited on Monero, 0.970225 returned to the original Solana wallet after the token’s two transfer taxes. [Finalized return](https://solscan.io/tx/qEZGttzhQEk3ZTrRoGPn1eEQoBLbmWVChXoPVHQ9Zmf4VnvqWDDXfnDkUjGpsK5H74LpS9Z39ZK4NDxG9wChavv).

## Try a transfer between holders

1. Unlock wallet B, select the token in Bridge and register its linked wallets if asked. Wait for the Monero link confirmation; the service continues registration after the wallet closes.
2. In wallet A, select the same token, enter the amount and approve the displayed deposit. Wait for the confirmed Monero balance.
3. In A, choose “Send to another Monero wallet” and enter B’s registered Monero address. Review and approve the native record, then complete the saved transfer after confirmations. This path still requires the linked Solana owner’s approval.
4. Open B. Confirm its credited balance and choose “Bridge back to my Solana wallet”. Check the exact fee and destination, then click “Bridge to Solana”. Keep B open and unlocked for automatic completion, or resume after reopening.

Never uninstall an existing wallet to update it. Replace its existing installation files and Reload in Chrome so encrypted accounts and public receipts remain associated with the same extension identity. The manifest key is public and intentionally unchanged.

## Boundaries

The program is `8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB`. Testing requires its exact reviewed bytes and retained upgrade authority. Ordinary/public admission still requires immutable code; this separate testing profile does not change that rule. Unknown tokens, invalid launch proofs, changed code, stale or incomplete history, changed fees and incorrect signatures remain rejected.

The operator remains on loopback and is reached through a local connector/forward. Public hosting, a Chrome Web Store release, a funded two-holder test, independent security review, and production airdrop/sale/whitelist enforcement are not certified by these tests. No deployment or wallet operation runs during npm installation, build or tests.
