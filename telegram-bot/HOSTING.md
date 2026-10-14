# Hosted XMR20 Telegram bot

The dedicated service is `xmr20-telegram.service` on the XMR20 server. It uses outbound Telegram polling; there is no public listener, webhook or new website route. The OS user, immutable source release, encrypted application state and systemd unlock credential are separate from the website and tweet bot.

## One-time handoff

Stop the Mac bot with Ctrl+C. Open **Connect Hosted XMR20 Bot.command** and enter the existing XMR20/Turnkey unlock password. No API keys need re-entering. The launcher validates all existing encrypted vaults, exclusively locks them, transfers their ciphertext over pinned SSH, and provisions a host-encrypted systemd unlock credential through stdin. It preserves bot identity, wallet, polling offset, orders, pending approvals and signing journals. It refuses to overwrite an already configured host. Once handoff starts, local startup is blocked to prevent two Telegram pollers and diverging financial records. Use the same Connect launcher to check hosted status.

This is unattended server custody: the runtime must unlock state to operate, and server root can access runtime credentials. Telegram chats are not end-to-end encrypted. The wallet keys remain in Turnkey, while API credentials and state are encrypted at rest. Off-server encrypted backups and independent end-user wallet recovery are not yet provided; the operator must preserve state and signing journals.

## Public registration

Local source includes `/start` provisioning of a separate Turnkey Solana wallet per Telegram user, followed by the welcome text, copyable address and instructions. Existing users reuse their wallet without a balance RPC. Helius handles balance reads and transaction delivery. Public admission is disabled until the exact policy set and version-2 restricted gateway pass startup checks.

The operator must install the two prepared Turnkey policy drafts (wallet creation and bot-labelled wallet signing), retaining the existing owner wallet policy. Then run **Enable Public Hosted XMR20 Bot.command**. This verifies the exact three-policy set and restarts only this bot. It does not grant its own policies or send a financial transaction. New-user onboarding verifies a zero-value signature with an invalid blockhash and registers an immutable gateway binding before publishing a deposit address. Unknown wallet creation is reconciled by saved unique name; ambiguous activation is held for operator attention rather than creating another wallet.

The creation grant is not a provider-enforced registration quota. The bot enforces 100 new users per UTC day and 1,000 total. Signing is scoped to the exact service credential, bot wallet-name prefix, non-imported wallets and V0 Solana fee payer. User isolation, amounts, recipients and transaction programs remain application-enforced. Do not claim BONKbot-equivalent custody or independent user recovery. Buy and Sell accept any verified, published XMR20-mode launch from the public registry, regardless of creator. Pool ownership, canonical address, mints and token balances are independently checked through Helius. Each new user supplies their own withdrawal destination; no administrator destination is inherited.

## Operations and rollback

State: `/var/lib/xmr20-telegram`. Source: `/opt/xmr20-telegram/current`. Unlock credential: `/etc/credstore.encrypted/xmr20-telegram-unlock`. Never print or copy these credentials into chat or Git. Service logs use fixed redacted diagnostics. Public runtime status reports mode, connection state and whether admission is private.

`systemctl stop xmr20-telegram` stops only this bot. Preserve state and all journals on rollback. Do not restart the Mac copy after funded server activity: it is an older snapshot. Source rollback must be compatible with public-registration state; the pre-registration private source must not replace an active public runtime. Rollback copies of the restricted launch gateway are held under `/opt/xmr20-telegram/backups`; restoring a private-only gateway while public users exist would prevent their launch access.
