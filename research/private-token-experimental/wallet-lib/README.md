# wallet-lib — XMR20 private-token wallet library (EXPERIMENTAL)

A small, documented JavaScript interface for building a compatible wallet: address creation, chain
scanning, balance recovery, viewing-only access, transfer preparation, proof generation, carrier
signing and publication. It has no UI and no bridge-operator logic. See
`../SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.txt` for the protocol it implements.

**Status: experimental research. NO-GO for real funds. Disposable parameters. Not audited.**

## What is shared (disclosure)

The library is a thin layer over the SAME cryptographic engine the research extension uses:

| Component | Role | Shared with the extension |
|---|---|---|
| `holder-wasm` (Rust → wasm) | keys (XMR20-TKD1), scanning, note decryption, nullifiers, Groth16 proving, spend/binding signatures, parameter authentication, Monero carrier construction and signing | yes (identical binary) |
| `wallet-extension/src/holder-engine.js` | wasm host + chain scanner over daemon JSON-RPC | yes |
| `wallet-extension/src/holder-params.js` | manifest check, authenticated parameter loading, cache | yes |
| `wallet-extension/src/holder-carrier.js` | daemon RPC for fee rate, decoys, publication | yes |
| upstream crates (penumbra-sdk 2.1.1, decaf377, decaf377-rdsa, arkworks, monero-oxide) | the actual cryptography | yes (vendored copies) |
| `monero-ts` 0.11.16 (optional, CLI only) | 25-word phrase → private spend key | same version the extension pins |

Two applications over one engine are **not** independent cryptographic implementations. What can be
checked independently from the specification with established libraries is in `../independent/`.

## Interface

```js
import {openPrivateWallet, memoryCache} from './private-wallet.mjs';
const w = await openPrivateWallet({
  wasm: await readFile('…/xmr20_holder_wasm.wasm'),     // the shared engine
  manifest, manifestBytes, pinnedManifestSha256,          // the shipped XMR20-PARAMS-1 manifest (trust anchor)
  daemonRpc: 'http://127.0.0.1:30041',                   // Monero daemon (offline fakechain in this research)
  parameterServer: 'http://127.0.0.1:8940',              // /params/parameters.json, /params/normal.public-pk, /params/boundary.public-pk
  cache: memoryCache(),                                  // or your own {get, put, delete} (files are re-authenticated on read)
  root: '<32-byte hex: the account’s Monero private spend key>'   // or viewingKey: 'penumbrafullviewingkey1…'
});
w.address();                 // 'penumbra1…' (index 0)
w.nativeAddress();           // Monero address of the same root (carrier fees)
await w.sync();              // replay the public chain; detects rollbacks and replays from genesis
w.status();                  // {balances, notes, spent, tip, records, pool}
w.select({asset, amount});   // ≤3 notes, largest first → {notes, total, change}
const built = await w.prove({kind:'send', to, amount, notes});   // authenticates+loads the proving key, proves (~30 s in wasm)
const quote = await w.quoteCarrier({kind:'send'});   // exact XMR fee BEFORE proving if you prefer (ring sampled, input chosen)
const carrier = w.signCarrier(quote.quoteId, built.wire);         // fee must equal the quote
await w.publish(carrier.blob);                                     // send_raw_transaction; idempotent for the same blob
```

Order used by the research wallets: `select → quoteCarrier → (user approves the fee) → prove → signCarrier →
publish`, journaling each step so an interruption can resume (`SPEC` section 9). A view-only wallet
(`viewingKey`) supports `sync`, `status`, `select`, `verify` and refuses everything that needs spending
authority.

## Secret handling

The root (or viewing key) is passed to the engine once and lives in wasm linear memory until `close()`.
The library never persists keys. Callers own persistence of (a) the root/phrase and (b) the pending
operation journal (reserved notes, proved records, signed carriers); without (b) another installation
cannot resume an interrupted operation (SPEC section 9).

## What it does not do

No relay, no fee sponsorship, no bridge operator calls (deposits/redemption bindings are a separate
test service in this research), no sub-addresses, no memo, no mainnet network identity.
