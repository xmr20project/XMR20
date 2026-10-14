# Verification scope

## 14 October 2026 source publication

The application release passed 88 tests locally and on the Linux host. Coverage includes private-chat identity, public registration and per-user isolation, duplicate wallet creation recovery, encrypted persistence and locking, image processing and skip, draft deletion, exact transaction reconstruction, fee and pool checks, any-creator XMR20 trading, confirmation expiry, partial/unknown signing fences, receipt recovery, and fixed-code gateway error redaction.

The test suite uses synthetic credentials and accounts. `npm test` does not submit real transactions or connect a production wallet. Packaging uses an explicit allowlist, validates source hashes, rejects symlinks and excludes runtime state. Pattern scans and tests are not an independent security audit.

The hosted mainnet bot connected successfully; all three expected Turnkey policies and the restricted gateway passed activation. Public registration is enabled and a second user's separate wallet reached backend launch preparation. A completed owner launch has independently read finalized mint/pool receipts. The second user's 0.04 SOL zero-buy attempt failed in simulation and retained a draft with no launch receipts. No complete funded multi-user buy/sell/withdrawal/recovery cycle is claimed.

Remaining limits include independent custody review, user-controlled key export/recovery, off-server encrypted backup and full funded recovery verification. Telegram chats are not end-to-end encrypted. Runtime amount, destination and program checks are application-enforced; the provider policy is wallet/activity-scoped.

## Dependencies

Use the pinned lockfile and `npm ci --ignore-scripts`. The optional bigint-buffer native converter has inherited advisories; startup rejects its native binding and uses the JavaScript fallback. This is a mitigation, not a zero-vulnerability claim. Do not rebuild that native dependency. Third-party licenses are unchanged.

## Publication contents

The bot's runtime source, synthetic tests, vendored reviewer modules and operator helpers are included. Production vaults, local settings, SSH identities, host unlock credentials, actual signing journals, customer data, private backend configuration and node_modules are excluded. The primary launch backend is a separate dependency and is not recreated by cloning this folder.
