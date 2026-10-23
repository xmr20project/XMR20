#!/bin/sh
# Source/binary/evidence manifest for research/privacy-review-20261023 (run from the candidate root).
cd "$(dirname "$0")" || exit 1
{
 find holder-wasm/src holder-wasm/Cargo.toml holder-wasm/Cargo.lock holder-wasm/vendor/getrandom-0.2.17/src/lib.rs holder-wasm/vendor/getrandom-0.2.17/Cargo.toml holder-wasm/vendor/getrandom-0.2.17/PATCH-NOTE.txt -type f
 echo holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm
 find params/test-v1/manifest.json params/test-v1/parameters.json params/test-v1/normal.public-pk params/test-v1/boundary.public-pk params/test-other/manifest.json params/test-other/parameters.json params/test-other/normal.public-pk params/test-other/boundary.public-pk params/make-manifest.mjs wallet-extension/src/holder-carrier.js wallet-extension/src/holder-params.js wallet-extension/src/holder-engine.js wallet-extension/src/private-holder.worker.js wallet-extension/src/private-journal.js wallet-extension/src/private-format.js wallet-extension/src/private-claim.worker.js wallet-extension/src/app.js wallet-extension/build.mjs -type f
 find wallet-extension/extension-private-holder-test -type f
 find backend -type f
 ls *.mjs *.txt *.json *.sh
 find evidence -path 'evidence/verified-*' -type f
 ls runs/*.log runs/*.json runs/*.txt
} | sort -u | while IFS= read -r f; do shasum -a 256 "$f"; done > MANIFEST.sha256
wc -l MANIFEST.sha256
