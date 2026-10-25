#!/bin/sh
# Source/build/evidence manifest for research/privacy-release-candidate-20261025 (run from the candidate root).
cd "$(dirname "$0")" || exit 1
{
 find wallet-extension/src wallet-extension/build.mjs wallet-extension/package.json wallet-extension/extension wallet-extension/extension-stagenet-test backend wallet-lib cli-wallet stagenet settlement conformance migration review vectors independent -type f -not -path '*/evidence/*' -not -name '*.log'
 find settlement/evidence conformance/evidence migration/evidence -type f 2>/dev/null
 ls *.mjs *.txt *.sh 2>/dev/null
 echo holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm
 echo params/stagenet-v0-trusted/manifest.json
 ls runs/*.log runs/*.json 2>/dev/null
} | sort -u | while IFS= read -r f; do [ -f "$f" ] && shasum -a 256 "$f"; done > MANIFEST.sha256
wc -l MANIFEST.sha256
