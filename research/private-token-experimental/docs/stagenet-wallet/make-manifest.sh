#!/bin/sh
# Source/build/evidence manifest for research/privacy-stagenet-wallet-20261024 (run from the candidate root).
# Excludes browser profiles, run folders with journals/state, node_modules and the symlinked parameter sets (hashed in their
# own candidate's manifest); includes the built stagenet extension and its shipped manifest.
cd "$(dirname "$0")" || exit 1
{
 find wallet-extension/src wallet-extension/build.mjs wallet-extension/package.json wallet-extension/wallet-styles.mjs wallet-extension/extension -type f
 find wallet-extension/extension-stagenet-test -type f
 find backend stagenet wallet-lib -type f
 ls *.mjs *.txt *.sh 2>/dev/null
 echo holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm
 echo params/stagenet-v0-trusted/manifest.json
 ls runs/*.log runs/*.json 2>/dev/null | grep -v -e state -e faucet
 find evidence -type f -name '*.json' 2>/dev/null
} | sort -u | while IFS= read -r f; do [ -f "$f" ] && shasum -a 256 "$f"; done > MANIFEST.sha256
wc -l MANIFEST.sha256
