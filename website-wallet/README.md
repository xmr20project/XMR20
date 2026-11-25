# Website wallet

Source of the wallet built into xmr20.org: the wallet button on each page and `/wallet/wallet.html`. It hosts the extension's own pages from `../src/` (Bridge to Monero, Bridge to Solana and Send) and uses the bridge clients in `../bridge/` and `../services/native-market/`, so the website and the extension run the same bridge code.

- Connect Phantom, Solflare or the XMR20 extension; SOL and token balances; Solana sends.
- SOL ↔ XMR exchange through ChangeNOW: floating rate, the order is saved before you pay.
- Bridge to Monero, Bridge to Solana and Monero token Send. Saved entries can be resumed, and a saved bridge can be cancelled before its deposit.
- Monero tab: Monero-side token balance, plus bridges and sends that are still confirming.

## Build and test

```sh
npm ci                      # in the repository root (shared bridge modules)
cd website-wallet
npm ci
npm test                    # unit tests
npm run build               # writes dist/
CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

`npm run build` sets the same build flags as the xmr20.org build. The browser tests run a local fixture in a fresh headless Chromium profile, with generated keys and no internet. Screenshots go to `test-output/`.

## Scope and limitations

- This is the website wallet source as of 23 October 2026 (website Bridge to Solana and Send added). It bundles the same 201 project files as the private project's wallet build. The output is not byte-identical, because the private project resolves packages from several folders.
- The tests use local fixtures. A funded Bridge to Solana or Send from the website is not verified by this repository's tests.
- Not included: the rest of xmr20.org (launch, docs, rewards pages), static files served next to the wallet (the Monero wallet engine under `/wallet/monero-wallet/` and `/monero-native/`), and the server routes behind `/api/`.
- Testing software. It has not been independently audited. Monero confirmations and the bridge's operator checks still apply.
