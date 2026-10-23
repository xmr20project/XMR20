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

| 4 | `docs/stage4-interop/` | Interoperability: a versioned experimental specification (`SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.txt`), a small documented wallet library (`wallet-lib/`), a minimal CLI second wallet (`cli-wallet/`), an extension↔CLI interoperability test on one pool (`interop.test.mjs`), portable synthetic test vectors (`vectors/`) and an independent decoder written from the specification (`independent/`). |

| V | `docs/verifier-params/` | Verifier-side parameter authentication: the issuer and indexer roles of the laboratory binary now require a trusted manifest path independent of their parameter directory, authenticate `parameters.json` and the proving keys (exact length and sha256) before parsing, check protocol/circuit/ledger/network identity and the daemon genesis, and refuse to start otherwise (no fallback). The two changed laboratory source files are included for review of the loading path; the laboratory crate itself is not published. |
| S | `docs/stagenet-rehearsal/`, `stagenet/` | Stagenet carrier rehearsal: PREPARED, NOT EXECUTED (no blockchain download, no public broadcast). Network-aware engine/scanner/carrier (manifest network kind `offline-fakechain` or `stagenet`; monerod sanity checks ON off the fakechain), a stagenet-anchored disposable parameter manifest, the runnable harness and the local checks that were run (12/12). What still requires execution on stagenet is listed item by item. |

**Shared engine, scoped decoder.** The research extension and the CLI wallet are two applications over ONE
cryptographic implementation: the same `holder-wasm` binary and the same host modules (scanner, parameter loader,
carrier builder) and vendored upstream crates. They are not independent implementations. The separate decoder in
`independent/` checks only what it actually implements from the specification with established JavaScript
libraries — tx_extra framing, record layouts and ids, message preimages, manifest and ledger-domain rules, the
key-derivation PRF — and explicitly lists what it cannot check (commitments, nullifiers, signatures, proofs,
payload decryption, address derivation), which remain for independent security review.

The code in `holder-wasm/`, `wallet-extension/src/`, `backend/` and the tests is the **stage-3/4 (cumulative)**
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
- `wallet-lib/`, `cli-wallet/`, `independent/`, `vectors/`, `SPEC-…txt` — stage 4 (see `docs/stage4-interop/README.md`; the CLI's `--seed` import needs `monero-ts@0.11.16`, `--root`/`--viewing-key` need nothing extra; the CLI stores its synthetic root in clear and is for synthetic use only).
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
