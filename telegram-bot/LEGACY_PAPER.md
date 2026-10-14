# XMR20 Telegram bot — private pilot in development

Latest scope: **one owner, mainnet, XMR20 mode only**. Normal mode is excluded from the new pilot. The existing running process is still the paper bot; the new mainnet entry point has not been activated or tested with funds.

The local pilot now has an image-required launch wizard, an isolated copy of the website's exact XMR20 launch reviewer, Turnkey signing transport, encrypted launch/transaction journals, a private SSH launch gateway, Helius RPC/Sender delivery, direct XMR20-pair trading and fixed-recipient SOL withdrawals. These are implementation components, not evidence of live readiness. See `MAINNET_PILOT.md` for the concrete activation gaps and verification limits.

`Check Mainnet Readiness.command` runs an owner-unlocked read-only check of Turnkey identity, a dedicated wallet and Helius mainnet. It asks for secrets in a hidden local terminal and never enables execution. `Start Mainnet Pilot.command` is a separate entry point that refuses incomplete or changed wallet/policy settings. No mainnet settings have been enabled by this implementation.

## Existing paper bot

An isolated prototype of the bot-managed-wallet experience: launch wizard, buy/sell, percentage sells, balance, order history and withdrawal reviews. **The running bot has no real wallet, deposit address, signing, launch, swap or withdrawal.** All prices, balances and costs are test fixtures. Do not send money to the prototype. This is not a mainnet release or a custody security audit.

Both Normal and XMR20 modes are represented in the wizard. Any permitted ticker works for any allowed test user; no ticker-to-wallet mapping exists. A launch creates a `demo:` identifier, never a real mint or chart link. Test trading supports DEMO, simulated launch identifiers and correctly decoded 32-byte Solana addresses. Entering a real mint does not load its market price.

## Try locally

Requires Node.js 22+ and Python 3. The paper bot uses Node built-ins; the Turnkey connection checker uses the pinned official API-key stamper. Run `npm ci --ignore-scripts` on a fresh checkout.

```sh
npm test
npm run demo
```

Or double-click `Try Local Bot.command` on macOS. Try `/fund`, `/launch`, then follow the prompts. At the image step, type `skip_image` in the local demo (Telegram supports photo uploads). Type `/confirm` to approve a displayed paper review; `/quit` exits. `/buy DEMO 0.1`, `/sell DEMO 25`, `/wallet`, `/orders`, `/cancel` and `/privacy` also work. The local demo uses a disposable encrypted vault and deletes it on ordinary exit. The scripted example is `node src/demo.mjs --scripted`.

## Private Telegram test

1. Create a dedicated **test** bot using Telegram's verified [@BotFather](https://t.me/BotFather) and `/newbot`. Do not share the HTTP API token in a chat, issue or commit.
2. Double-click `Setup Telegram Test Bot.command`, or run `python3 scripts/setup.py`. Hidden prompts capture the token and a unique passphrase of at least 16 characters. Enter numeric Telegram tester IDs; leaving them empty saves credentials but prevents the bot from starting. Re-running setup replaces the configured token/allowlist while preserving encrypted paper accounts. Use a fresh test vault when switching bot identities.
3. Double-click `Start Telegram Test Bot.command`, or run `npm start`, and unlock with the passphrase. This is the separate explicit action that starts Telegram polling and replies to allowed users.
4. Open the bot's private chat and send `/start`. Use **Add test SOL**, then launch/buy/sell. Group chats, other users, edits and forwarded cross-user callbacks do not execute commands.
5. Ctrl+C stops polling. Terminal hangup and termination are also forwarded to the bot so it can close its vault lock. No hosting or automatic restart is installed.

The token, allowlist, Telegram identities, drafts, balances, Telegram photo references, responses, order receipts and polling offset are saved inside `~/.local/share/xmr20-telegram-paper/state.vault`. Credentials never go into the source tree, shell arguments or a plaintext dotenv file. Setup uses a private subprocess pipe, and provider error messages/URLs are not logged. No Helius credential is currently loaded or copied.

Storage uses Node's AES-256-GCM with a random 96-bit nonce per write, fixed format-specific authenticated data and scrypt (N=32768,r=8,p=1, fresh 128-bit salt) to derive the key from your passphrase. Files are created with mode0600, the new state directory with0700. Atomic replacement and fsync protect committed state; an exclusive lock prevents two bot processes using the same vault. Wrong passwords and corrupt data fail closed. An uncatchable kill or crash may still leave `state.vault.lock`: verify the bot is stopped before an operator removes that lock. Never delete the vault to resolve a delivery error. Use a strong passphrase; losing it means losing access to the encrypted test state. Protect the running host too: decrypted state necessarily exists in process memory; JavaScript cannot guarantee memory erasure. An existing parent directory's access policy is not repaired by this prototype.

## Commands and confirmations

- `/launch`: name → ticker → normal/xmr20 → initial SOL buy → photo or Skip image → 30-second review → confirm.
- `/buy <mint|DEMO> <SOL>`: exact atomic input and fee-aware paper review.
- `/sell <mint|DEMO> <percent>`: integer percentage, including25/50/75/100 buttons in the wizard.
- `/withdraw <address> <SOL>`: destination and total debit review; simulated only.
- `/deposit`: explicitly refuses real deposits; `/fund` gives one simulated SOL per test account.
- `/wallet`, `/orders`, `/cancel`, `/privacy`, `/erase`.

Each confirmation is bound to its user's current draft and nonce. Old, cancelled, expired and cross-user reviews cannot execute. Updates and completed orders are deduplicated; state is committed before replying. A network interruption can cause a duplicate Telegram reply but does not debit the same order twice. Pending unreviewed drafts expire after ten minutes. `/erase` resets only this paper account and cached responses in the current vault; it does not erase Telegram's messages, backups or securely overwrite prior disk blocks. It is not an acceptable live-money deletion flow.

## Reply speed and token images

Button acknowledgements run alongside replies with a two-second deadline; a slow acknowledgement cannot hold up the next message. Telegram message/photo delivery has a ten-second deadline, idle long polling retains its separate35-second network deadline, and stopping the bot aborts in-flight calls. Polling waits for incoming activity; its25-second timeout is not a deliberate per-message delay. Authorized retries reuse the encrypted saved response without re-running commands or another engine write. Durable saves and duplicate protection remain in place.

The Terminal prints processing and Telegram delivery durations only, with no user IDs, commands, images, URLs or credentials. These durations begin when this bot receives an update, excluding Telegram inbound delivery and the user's device. They are diagnostic measurements, not end-to-end latency guarantees.

New launch drafts ask for a photo before final review. Send a Telegram photo up to10MB or tap **Skip image**. The review reuses Telegram's photo with its caption and confirmation buttons. Only the image reference and dimensions are saved encrypted; the prototype does not download image bytes or publish token metadata. Existing reviews created before this update can still complete unchanged. Real launch image download, verification and metadata publication remain part of the unimplemented live integration.

After source changes, stop the bot with Ctrl+C, reopen Start Telegram Test Bot.command, unlock it, and send a new `/start`. Already-sent messages retain their old buttons.

## Helius and live integration

`src/helius.mjs` implements a fixed-host HTTPS Helius mainnet **read-only** adapter with deadlines, finalized balance reads and redacted errors. It rejects all sending methods. Tests use a fake transport; no live Helius call or latency benchmark has been performed for this bot.

The planned live delivery path reuses the existing XMR20 `website/web/server/quick-network.mjs:sendQuickBytes` and transaction validation, with Helius RPC and Sender. A standalone Turnkey signing adapter is locally tested with synthetic transactions but is not connected to Telegram or a provider account. Wallet provisioning, signing permissions, live quotes, deposits and execution remain unimplemented. See `ARCHITECTURE.md` for concrete integration boundaries and remaining gates. There is no environment toggle that enables real money.

## GitHub preparation

```sh
npm run release:check
```

Creates `dist/xmr20-telegram-source.zip` from an explicit source allowlist, plus SHA256 manifest and ZIP checksum. The tool rejects symlinks and obvious embedded bot tokens/private-key headers. It never collects runtime state, environment files, the wider repository, archives or production settings. This is a bounded scan, not a complete secrets audit. No repository is created, committed, pushed or published by this command. A distribution license must be selected before an open-source release; none is assumed here.

References checked14October2026: [Telegram Bot API](https://core.telegram.org/bots/api), [BotFather](https://core.telegram.org/bots/features#botfather), [Telegram privacy model](https://telegram.org/faq#q-how-are-secret-chats-different), [Helius Sender](https://www.helius.dev/docs/sending-transactions/sender).

Startup now reports separate fixed messages for an existing lock, an invalid/incorrect passphrase or unreadable vault, incomplete test settings, and Telegram connection failure. The connected message appears only after Telegram startup checks succeed. Error text never includes provider responses or secrets.

UI follow-up: removed the repeated TEST BOT / NO REAL FUNDS prefix from every reply. The home menu says Practice mode once; balances, quotes and receipts remain explicitly simulated until real execution is implemented. No mainnet switch was enabled by this copy change.

## Turnkey account connection setup

Double-click `Setup Turnkey Connection.command` in Finder. Choose a unique passphrase of at least 16 characters. The owner-local Organization ID is loaded from ignored `state/turnkey-public.json`; fresh checkouts prompt for it. The launcher generates a P-256 API credential locally and stores its private half in AES-256-GCM encrypted `state/turnkey-connection.vault` (separate authenticated format from the paper vault). Only the Organization ID and compressed API public key are displayed. Reopening with the same passphrase retrieves the existing public key without rotating it. Keep the passphrase safe.

Register that public key for a separate non-root API-only user named `xmr20-bot` in Turnkey. Keep the administrator passkey separate. Permissions and connection verification are still pending; do not give this user broad signing, export, policy-management or root authority. This setup only creates an API authentication credential locally: it makes no network requests, creates no Turnkey/Solana wallets, enables no deposits and does not connect the running Telegram bot. A subsequent read-only authenticated check and reviewed provider policies are required.

Local settings and encrypted credentials are ignored by Git and excluded from the source archive. No private key or passphrase should be pasted into chat. Reference: https://docs.turnkey.com/features/users/credentials and https://docs.turnkey.com/features/users/best-practices .

## Verify the registered Turnkey service user

After registering the local public key, add the service `userId` and expected `apiPublicKey` to ignored `state/turnkey-public.json` alongside `organizationId`. Owner-specific values are excluded from the source ZIP. Double-click `Check Turnkey Connection.command` and enter the Turnkey vault passphrase locally. The installed official `@turnkey/api-key-stamper` is pinned to 0.6.17 with a lockfile.

The checker authenticates only three read queries to api.turnkey.com: whoami, get_user and get_organization_configs. It checks exact organization/user identity, registered P-256 key and absence from the root quorum. It uses ten-second request deadlines, refuses redirects and all other endpoint methods, and does not print provider errors, stamps, credentials or full account responses. It releases the vault lock before network I/O. A successful check writes only a dated, bounded summary to ignored `state/turnkey-check.json`. A prior report can remain after a failed retry; always check its timestamp against the latest run.

This verifies identity and root membership only. Non-root does not prove least privilege: existing policies still require review. No keys are deleted automatically, no wallets are created, and no permissions, financial transactions or mainnet bot settings are changed. After a verified connection, remove only the earlier unused dashboard-generated key through your administrator account.
