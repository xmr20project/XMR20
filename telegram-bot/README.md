# XMR20 Telegram bot

Launch and trade XMR20 tokens from Telegram: **[Open @XMR20_Bot](https://t.me/XMR20_Bot)**.

This folder contains the hosted bot's application source, transaction reviewers, encrypted storage, Turnkey integration, Helius transport, tests and operator helpers. It is separate from the browser wallet elsewhere in this repository.

## Use the bot

1. Open the bot in a private chat and send `/start`. Each new Telegram user receives a separate Turnkey Solana wallet. Returning users keep their existing address.
2. Deposit SOL to the address the bot displays, then tap **Wallet** to check the finalized balance.
3. Tap **Launch**, enter a name and ticker, upload an image or choose **Skip image**, and enter the initial buy amount. Prepare and review the actual costs before confirming.
4. **Buy** and **Sell** accept the CA of any verified, published XMR20-mode launch, regardless of who created it. These trades use XMR20 as the quote token. The initial launch buy can use SOL.
5. **Orders** shows saved progress and recovery actions. Delete removes unsigned drafts or hides settled entries while preserving receipts. Pending financial operations cannot be deleted. **Withdraw** sends SOL to the user's separately configured withdrawal address after confirmation.

An initial buy of zero still requires SOL for account and pool rent, the 0.01 SOL launch fee and network fees. Preparation estimates the cost before approval. A failed simulation does not launch the token; retry the saved order rather than creating another token.

Normal-mode launches, general SOL trading routes and arbitrary Solana tokens are not supported by this bot.

## Wallet custody and privacy

Wallet keys are held by Turnkey. The bot operator's scoped API credential authorizes signing after application checks and the user's Telegram confirmation. This is a bot-managed wallet, not a self-custody wallet. Turnkey policy limits which wallets and signing activities the credential can use; amounts, recipients, programs and user isolation are enforced by this application.

State and transaction journals use AES-256-GCM with scrypt-derived keys. Telegram bot chats are not end-to-end encrypted, Solana activity is public, and the running host can access decrypted application credentials. Independent user key export/recovery and off-server encrypted backups are not implemented here. See [PRIVACY.md](PRIVACY.md).

## Develop and test

Requires Node.js 22 or newer and Python 3.9 or newer.

```sh
cd telegram-bot
npm ci --ignore-scripts
npm test
npm run release:check
```

Tests use synthetic identities and mocked providers. They do not start the bot or move real funds. Keep dependency lifecycle scripts disabled; the runtime rejects the optional native bigint-buffer binding and uses its JavaScript fallback. Known inherited dependency advisories remain; see [VERIFICATION.md](VERIFICATION.md).

## Operator setup

Using the hosted bot does not require API keys or a local installation. Running another instance requires Telegram and Helius credentials, a Turnkey organization and reviewed policies, and an authenticated XMR20 launch backend. This source is not a complete deployment of that backend. The official setup intentionally pins the `XMR20_Bot` username; operators adapting it must review identity binding and migrate state deliberately.

Start with [HOSTING.md](HOSTING.md), [MAINNET_PILOT.md](MAINNET_PILOT.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Setup helpers use hidden local prompts and encrypted vaults. `.env.example` contains only non-secret settings. Never commit a bot token, RPC credential URL, API private key, passphrase, vault, wallet backup or user/order database.

## Release scope

Published on 14 October 2026 from hosted application release `dbbdc960535af846`. Runtime files under `src/`, vendored reviewers and the restricted gateway match that release. Documentation is refreshed; the host handoff helper accepts an operator-configured SSH hostname instead of embedding the production server address. No production settings or user data are included.

The hosted service and public registration were verified, and one owner launch has finalized receipts. This does not establish every funded buy, sell, withdrawal or recovery path for every user. The software has not received an independent custody security audit. See [VERIFICATION.md](VERIFICATION.md) for the exact scope. Original project code is covered by the repository's [MIT license](../LICENSE); dependency licenses remain with their respective authors.
