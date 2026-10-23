# Stage 4 — wallet interoperability (EXPERIMENTAL, local, not published)

Goal: independent developers can build compatible XMR20 private-token wallets that receive, decrypt,
recover and send tokens on the same pool, without this project's wallet interface and without a
server holding their keys. Everything here is synthetic (offline fakechain, disposable parameters)
and does not change the readiness gates of stages 1–3 (NO-GO for real funds; bridge payouts and
native XMR trading gated; no independent security review).

| Deliverable | Where |
|---|---|
| Interoperability contract (versioned, experimental) | `SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.txt` |
| Reusable wallet library (no UI, no operator) | `wallet-lib/private-wallet.mjs`, `wallet-lib/README.md` |
| Second wallet application (CLI) | `cli-wallet/xmr20-private-cli.mjs` |
| Two-wallet interoperability test (extension A ↔ CLI B, one pool) | `interop.test.mjs` → `evidence/verified-interop-*/`, `runs/interop-results.json` |
| Portable synthetic test vectors | `vectors/make-vectors.mjs` → `vectors/vectors.json` |
| Independent decoder and check written from the specification | `independent/decode.mjs`, `independent/check.mjs`, `independent/README.md` |
| Results, readiness, reproduction | `RESULTS.txt`, `readiness.json`, `REPRODUCE.txt` |

Three different claims, kept apart in `RESULTS.txt`:

1. **Application interoperability** — two applications (the research extension and the CLI) exchange
   tokens on one pool, recover the same account from the same phrase, and a viewing-only instance sees
   balances without spending. Both run the SAME engine (`holder-wasm`) and the same host modules; this
   is not two independent cryptographic implementations.
2. **Independent decoding** — what a program written from the specification with established
   JavaScript libraries reproduces: framing, record layouts, record ids, message preimages, the
   ledger-domain and manifest rules, the key-derivation PRF. What it cannot reproduce (anything needing
   decaf377/Poseidon/decaf377-rdsa/Groth16) is listed explicitly.
3. **Cryptographic security review** — not performed; the package for it is in stage 3.
