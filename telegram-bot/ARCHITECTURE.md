# Architecture

Private Telegram chat -> numeric sender identity -> per-user state and wallet -> reviewed intent -> durable signing journal -> Turnkey -> validated transaction -> Helius Sender and finalized receipt checks.

`registration.mjs` provisions one wallet per private-chat user, checks the exact account, verifies a zero-value signature with an invalid blockhash without broadcasting, and registers an immutable launch-gateway binding before showing an address. Unknown creation outcomes reconcile by saved unique name rather than creating another wallet. Default capacity is 100 registrations per UTC day and 1,000 total. `UserVault` scopes forms, orders and withdrawal settings; `boundSigner` rejects a different wallet address.

`pilot-engine.mjs` implements the Telegram menu. `launch-pilot.mjs` retains token identity and unsigned preparation, reconstructs exact instructions, checks fees/balances/proofs, journals approvals and preserves partial or uncertain outcomes. `trade-pilot.mjs` verifies public launch metadata and on-chain pool state before preparing XMR20 pair trades. `launch-directory.mjs` rejects unpublished, halted, wrong-network and unverified launches.

`turnkey.mjs` verifies returned signatures, exact message bytes and activity identity. `execution-journal.mjs` reserves before signing and persists receipts before any delivery. Unknown outcomes are fenced from duplicate signing. `helius-mainnet.mjs` separates reads from transaction delivery.

The restricted Python gateway binds each request to its registered wallet and a fixed backend action. It uses the existing launch backend's validation, Helius Sender, publication and Monero proof flow. The primary launch backend and its private configuration are not included in this folder. Publishing the bot does not publish or recreate all XMR20 services.

The hosted runtime uses one process and one encrypted state writer. It polls Telegram without opening a public listener. `hosting/` contains systemd and owner administration helpers; host migration preserves offsets, journals, accounts and saved approvals. Host root remains within the custody trust boundary. See HOSTING.md and PRIVACY.md.
