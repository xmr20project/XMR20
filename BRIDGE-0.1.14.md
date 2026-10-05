# Built-in XMR20 bridge — local preview 0.1.14

Reviewed “XMR20 docs (4)” and the current website bridge implementation, including wallet pairing, the missing-SOL issue, saved signed approval recovery, and the simplified final Solana unlock. The extension reuses the existing bridge service. No website or indexer deployment is included.

Bridge replaces the unused Swap shortcut. Choose Solana → Monero or Monero → Solana, then a held token. The current account supplies its two public addresses and local keys. A missing service pair requires explicit confirmation; an existing different pair is never overwritten. A Monero recovery phrase is required only for the Monero burn direction. Both directions require SOL for their Solana transaction/account costs.

The amount review shows token fee, net received, both addresses and a SOL cost allowance. Solana deposits and unlocks each have a separate explicit approval after their exact transaction is verified. Monero burns use a dedicated offline worker with a restricted canonical burn domain. Private keys are never sent to the bridge service.

All Solana transactions are reconstructed locally against pinned V1/V2/V3 programs, finalized escrow configuration, exact token/deployment, intent ID or Monero burn hash, owner, recipient, ATA, amount, attestor, fixed compute budget and signer permissions. Unknown extra instructions, lookup tables, altered recipients and pre-signed payloads fail closed. Token fees are checked against the quote and on-chain mint, and a local RPC simulation and SOL check precede signing. The bridge remains operator-attested; this does not make it trustless.

Draft IDs and signed attempts are encrypted inside existing vault receipts before submission. Reopening queries authenticated server receipts, scopes them to the same two addresses/token, and resumes the existing bridge. Uncertain signed submissions are retained until the server acknowledges that exact signature or a matching finalized expiry/failure history. Polling is read-only and never signs. Activity has a View / resume bridges shortcut. Manual lock, idle expiry and account changes clear bridge session material and stop workers.

The existing production service actions are reused; no new service identity, credentials or permissions are required. Public bridge metadata was checked against the live catalog. Runtime backend policy and available funds can still reject a transfer.

The 94 unit tests pass with a standalone dependency installation. Both bridge directions and lost-response recovery also passed isolated browser checks on the original preview build. Browser testing uses disposable keys and intercepted network responses; it does not move real funds. Real-funded end-to-end bridge execution has not been performed by this task.
