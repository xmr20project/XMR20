# XMR20 Wallet

Source repository for the XMR20 Chrome extension, developer preview **0.1.14**.

## Features

- SOL, native Monero and indexed XMR20 holdings with price estimates.
- Local encrypted accounts, imports, watch-only accounts and inactivity locking.
- Native and XMR20 transfers with explicit review and approval.
- Built-in XMR20 token bridge in both directions between Solana and Monero.
- Account-approved connections to `https://xmr20.org` and the local review origin `http://127.0.0.1:8893`.

## Build and test

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm test
```

Tests build the extension first. To build without running tests, use `npm run build`.
The test suite uses disposable keys and mocked network responses; it does not move real funds.

## Install or update in Chrome

Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** with the `extension/` directory. For an existing installation, replace the files in its current directory and click **Reload**. Do not uninstall an existing wallet just to update it. Keep recovery material backed up privately.

The manifest contains a **public** key to preserve extension identity. It is not a wallet private key. Preserve this key when rebuilding.

## Scope and limitations

This repository contains extension source, its installable build, unit tests, public pricing fixtures and two small service integration modules used by tests. It does not contain the full XMR20 website/indexer, deployment credentials, browser profiles, user wallets, recovery phrases or transfer receipts. No service deployment is performed by building or testing this repository.

Private keys are stored in the password-encrypted local vault. Unlocked key material exists in memory while the wallet is in use. This is a developer preview, not an independently audited production wallet. The existing operator-attested bridge requires SOL for Solana network/account fees and explicit approvals. See [bridge notes](BRIDGE-0.1.14.md).

Third-party notices and vendor licenses are included under `extension/`.

## License

Original project code is available under the [MIT License](LICENSE). Bundled third-party code retains its original licenses and notices. The `private` setting in `package.json` prevents accidental npm publication; it does not restrict this source license.
