# Mainnet operation and recovery

The hosted official bot now uses XMR20 mode and public per-user registration. Normal mode is not enabled. Operator setup begins with an explicitly configured owner wallet and separately verified public registration policies; changing a username or admission flag alone is insufficient.

## Operator prerequisites

- A Telegram bot token and pinned bot identity, Helius mainnet access, and an encrypted Turnkey connection.
- A non-root Turnkey service user, dedicated initial wallet and exact signing policy. Public registration additionally needs wallet creation and bot-labelled wallet signing policies from `registrationPolicies` in `src/registration.mjs`. Install policies through the organization's administrator, never through the bot credential.
- A compatible restricted XMR20 launch gateway and version-2 immutable user-wallet bindings. The complete primary launch backend is not distributed here.
- Encrypted state/journals, a single active polling process, and an independently secured operator host. Hosted setup requires a configured target and pinned SSH host key; the source helpers do not provision a new server automatically.

Official Setup/Start helpers use hidden local prompts. First activation verifies identity, mainnet, wallet, policy and gateway; it checks a zero-value signature with an invalid blockhash without broadcasting it. Hosted handoff preserves state and disables the obsolete local copy. Do not delete vaults or locks as a troubleshooting shortcut.

## Financial boundaries

Every launch/trade/withdrawal needs a review and explicit confirmation in Telegram. Launches retain the 0.01 SOL fee, account rent, Helius Sender, pool allocation, metadata and Monero proof requirements. Later trades use XMR20 as quote. SOL withdrawals use a separately configured per-user destination and a 0.25 SOL per-review cap. Limits and instruction validation are enforced by the application, not independent provider spending caps.

## Recovery

Full batches use exact saved-signature status/recovery and preserve finalized funding receipts. Partially signed bundles and unknown Turnkey requests remain fenced. Resume reconciles the saved activity or at most 100 signing activities against the exact saved intent. It never signs a replacement simply because a response was lost. A new user review may reuse verified signatures while valid; ambiguous or expired incomplete operations require operator reconciliation.

Preserve all encrypted journals when updating or rolling back. Never replace an active public runtime with a pre-registration snapshot or restart an obsolete local copy after hosted financial activity. Independent end-user export/recovery is not implemented. See HOSTING.md and VERIFICATION.md.
