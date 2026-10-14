# Wallet changelog

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
