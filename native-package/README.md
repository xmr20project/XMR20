# Native package assets (XMR20 Wallet 0.1.96)

Files copied from the installed 0.1.96 package that are not produced by `build.mjs`:

- `market/native-wallet/` — the private Monero wallet engine the bridge pages run in a worker: `worker.js`, `runtime.js` (built from the website native-market runtime sources), `transport.js`, `monero-0.11.16.js` (monero-ts), and the signer `xmr20_native_market_signer.js` + `.wasm` built from a separate Rust crate. `build-hashes.json` records their hashes.
- `market-entry.css`, `market.html`, `market/*.css`, `site-theme.css`, `inscriptions/site-shell.css`, `rewards/site-header.css` — the packaged market shell styles (composed from earlier builds plus appended release blocks).
- `manifest.json`, `INSTALL.txt`, `MARKET-CANDIDATE.txt` — the native package manifest (extension ID unchanged) and notes.
- `installed-hashes.json` — SHA-256 of these files and of the installed package's built scripts, used by `build-native.mjs`.

These are pinned artifacts, not a build; verify them against `installed-hashes.json`.
