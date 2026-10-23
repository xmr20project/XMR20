# Private-token research — EXPERIMENTAL, NOT FOR REAL FUNDS

**Status: research candidate. NO-GO for real funds. Native XMR trading gated. Bridge payouts gated. Not audited.**

This directory publishes the source, tests and documentation of three cumulative research stages
(23 October 2026) towards private fungible XMR20 tokens carried by ordinary Monero transactions.
Everything here ran only against **synthetic wallets, an offline local Monero fakechain, a local Solana
simulator and disposable browser profiles**. Nothing was deployed; no live wallet, balance or service
was touched; no reviewer was contacted. Passing tests are engineering evidence, not a security audit.
It is kept separate from the wallet and bridge sources of this repository and changes none of them.

## What the three stages are

| Stage | Directory of the originating candidate | What it adds |
|---|---|---|
| 1 | `docs/stage1-params/` | Parameter authentication: proving/verifying parameter files are authenticated against a manifest shipped with the build (`params/test-v1/manifest.json`, format `XMR20-PARAMS-1`) before parsing; missing, truncated, interrupted, substituted and corrupted files (including an altered proving-key query vector with the expected verifying key) are refused; cached files are re-verified. See `docs/stage1-params/PARAMETERS.txt`. |
| 2 | `docs/stage2-carrier/` | Holder-funded Monero carriers: the holder's wasm engine scans its own XMR, quotes the exact network fee before proving, proves the record, signs the ordinary Monero carrier (record in `tx_extra`) and publishes it to the daemon; no relay. See `docs/stage2-carrier/CARRIER.txt`. |
| 3 | `docs/stage3-review/` | Recovery from the phrase versus the original installation's journal (prepared / proved / signed / lost reply / rollback / stale backup / two installations), the matching reconcile hardening, a leak-regression test, and an external security-review package in `security-review/01..07`. See `docs/stage3-review/RECOVERY-CASES.txt`. |

The code in `holder-wasm/`, `wallet-extension/src/`, `backend/` and the tests is the **stage-3 (cumulative)**
version. Per-stage results, readiness verdicts, reproduction notes and frozen source hashes are under `docs/`.
Measurements and synthetic run audits (step logs, network audits) are under `results/`; screenshots, daemon
data, backend logs and browser profiles are deliberately not published.

## Layout

- `holder-wasm/` — Rust crate compiled to `wasm32-unknown-unknown` (no wasm-bindgen; JSON over a C ABI). Token key
  derivation (scheme `XMR20-TKD1`, `docs/stage3-review/KEY-SCHEME.txt`), local chain replay and scanning, Groth16
  proving of the XM3 transfer / XB3 boundary records, parameter authentication, and (stage 2) the native Monero
  wallet for carriers (`src/native.rs`, on the locally vendored `monero-wallet`). Self-contained: the two vendored
  crates are in `vendor/`. Host tests: `cargo test --release` (9).
- `wallet-extension/src/` — the holder integration modules of the isolated test extension build (worker, parameter
  loader, carrier builder, encrypted operation journal, popup integration) and the build script with the
  `XMR20_PRIVATE_HOLDER_TEST=local` flag. They are written against the wallet sources in this repository's `src/`
  but are **not** wired into the shipped extension.
- `backend/service.mjs` — the synthetic test service (bridge/operator roles over a local Solana simulator, offline
  daemon control, parameter files with test-only fault injection). It depends on laboratory roles (issuer, indexer)
  and modules that are **not published here**; it is reference code for the tests.
- `params/` — the parameter manifests (hashes of the disposable test setups) and the manifest generator. The
  proving keys themselves (83 MB + 64 MB, a single-party disposable setup) are not published; regenerate a set with
  the laboratory `setup` command as described in `docs/stage1-params/REPRODUCE.txt`.
- `*.test.mjs`, `browser-harness.mjs` — Node engine tests and Playwright popup tests (see each stage's
  `REPRODUCE.txt` for ports, prerequisites and expected results).
- `security-review/` — the security-review package: proof construction and trust model, what each observer learns, the
  original native source/key-image leak and its regression coverage, migration/cutover assumptions, the retained
  rollback-loss examples, an adversarial self-review (not an audit) and per-component readiness verdicts.

## What this does not claim

- No soundness or zero-knowledge claim for the disposable single-party Groth16 setup; parameter *distribution* is
  authenticated, the setup itself is not production-safe.
- No Monero-equivalent privacy claim for the token layer; no claim against a malicious node or network-level
  correlation; no constant-time claim; no claim about mainnet fees (the offline chain's rate is ~60× a typical
  mainnet rate; the popup labels an illustrative figure).
- The bridge rollback-loss case and the native-trading rollback-loss case are retained unweakened
  (`security-review/05-ROLLBACK-LOSS-RETAINED.txt`); this work does not resolve either.
- Running the browser tests requires the unpublished laboratory binary, an offline `monerod` and Playwright;
  paths that were specific to the originating workspace are shown as `<workspace>`.

## License

Same license as the repository (see `LICENSE`). Vendored crates keep their own licenses (`holder-wasm/vendor/*`).
