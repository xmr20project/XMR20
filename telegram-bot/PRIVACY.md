# Privacy and custody

The hosted bot uses Turnkey for funded user-wallet keys. Each Telegram user has a separate wallet and isolated application state. The bot operator controls a scoped signing credential. This is custodial operation; Turnkey key protection does not eliminate application, operator or host risk.

The local vault and financial journals use AES-256-GCM and scrypt. They retain numeric Telegram IDs, public wallet bindings, drafts, transaction receipts, bounded reply caches and polling offsets. Credentials and temporary token/position signing identities are encrypted at rest. Decrypted application credentials necessarily exist in runtime memory. Host root, a compromised process or weak passphrase can defeat the protection of encrypted files.

Telegram bot chats are not end-to-end encrypted. Telegram and the bot process messages; Telegram also receives uploaded token images. Token metadata and selected images are published as part of launching. Solana addresses, deposits and trades are public. Helius can see the requests and transactions sent to it. Encryption at rest does not make the bot anonymous.

Never send private keys, seed phrases, API credentials or passphrases in Telegram, GitHub issues or logs. Setup uses hidden local prompts and encrypted storage. Hosted operation uses a systemd encrypted unlock credential. No production credentials, vaults or user records are included in this repository.

Delete in Orders removes eligible drafts or hides settled entries; financial receipts remain available for recovery. It does not reverse a blockchain transaction or erase Telegram messages/backups. Pending signing and recovery records cannot be removed this way. The mainnet `/erase` command does not destroy financial records.

Independent end-user key export/recovery and off-server encrypted backups remain unimplemented. Preserve financial journals and do not run multiple independent copies against the same bot/account state. This source has not received an independent custody security audit.
