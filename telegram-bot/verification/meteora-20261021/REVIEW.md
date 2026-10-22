# Meteora review and Telegram restoration, 21 October 2026

Telegram launch readiness was restored on 21 October after independently rebuilding the changed Meteora program and updating the separate backend's strict program hash. The program upgrade occurred on 15 October, before the hosting maintenance. The old hash correctly paused new launches until this review. Future program or authority changes must still stop execution for another review.

## Published application repair

- Policy comparison now excludes only a canonical consensus predicate identifying both a different user and a different API public key. Original own-policy rows and order are preserved for the reviewed digest. Broad, overlapping, unfamiliar, extra or changed own policies still fail closed. No provider policy or signing grant was changed.
- A structurally valid, mainnet catalog with `enabled: false` allows the bot to connect for existing accounts and receipt recovery. It does not enable a launch. Malformed catalogs, other networks and missing one-approval support still fail startup. The backend continues checking readiness before preparation, reservation and broadcast.
- Runtime status records the observed startup launch availability. This is a startup observation, not a continuously refreshed readiness guarantee. Every financial action still needs its existing checks and user confirmation.
- The source archive includes the new runtime helper and regression tests.

## Reviewed program

| Field | Approved observation |
| --- | --- |
| Source | [Meteora DAMM v2 release 0.2.5, commit 5398b5c](https://github.com/MeteoraAg/damm-v2/commit/5398b5c7c534de014091132da37c6478cce671a8) |
| Program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| ProgramData | `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH` |
| Upgrade slot | `457080014` |
| Unchanged upgrade authority | `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` |
| Allocated payload | 2,174,352 bytes |
| Full payload SHA256 | `967ff9fb161eec2e62f66d2c899100739fb747c445f697b8625c86b31b9a2022` |
| Rebuilt ELF | 1,430,792 bytes |
| Rebuilt ELF SHA256 | `ca7a32627e284798de74eab2c8c3fe5c904c02b282f93a3314d5ad5bc92e5a67` |
| Zero-trimmed executable SHA256 | `0712ca6d350757b9a71a0ea40da8fe9d5b48fca044f2deae0b65a33320e6a59b` |

Two independent finalized RPC observations agreed on the program binding, authority, slot and bytes. The rebuild used Agave 3.1.10 / platform-tools v1.52 on x86_64 Linux, with all 202 official source files unchanged. Padding the rebuilt ELF with zeros to the allocated payload length produced byte-for-byte equality with the deployed payload. Earlier macOS builds did not match and were not accepted.

This is an independent reproduction and review of the upgrade diff and XMR20 integration. It is not an exhaustive independent audit of the entire AMM or a published third-party build attestation. The program remains upgradeable.

The reviewed changes address fee/reward accumulator overflow and pending-amount clamping, wrapping statistics, and an allowed zero-compounding configuration. The fixed XMR20 OnlyB preset is unaffected by that configuration. The paired accumulator arithmetic remains modular; 128-by-256-bit multiplication fits in 384 bits. Existing token transfers and vault balances constrain actual payments. The release diff does not change instruction arguments, account layouts, mint constraints, position ownership/delegate checks or permanent liquidity locking. No new dependency was added.

## Recheck the public evidence

`source-manifest.json` records the immutable official source archive and all 202 file hashes. `linux-source-proof.json` records the successful rebuild comparison. `program-capture.json` contains only the two public RPC observations. No compiled program, wallet, private settings, runtime database or customer receipt is included here.

Rebuild the official commit on x86_64 Linux with Agave 3.1.10 and platform-tools v1.52. The recorded build command, after fetching locked dependencies and installing those exact public tools, was:

```sh
cargo-build-sbf --manifest-path programs/cp-amm/Cargo.toml \
  --skip-tools-install --no-rustup-override --offline --jobs 1 -- --locked
```

The official Linux tool archive SHA256 values were:

- Agave 3.1.10: `a7205ff29bcf0f7199740225ecae2b85a28ea9668892d5ec21bd9749882984a1`
- Platform-tools v1.52: `8b3861e93daf085ec12b65c4fac374d9bec4587a3de16871da6b08ab0c1d907e`

With a raw program payload obtained independently from ProgramData (exclude the 45-byte loader metadata), compare it with the rebuilt ELF:

```sh
python3 verify-build.py --program /path/to/meteora-mainnet.so \
  --rebuilt /path/to/cp_amm.so
```

This command reads only the two supplied public binaries. It checks their fixed hashes, sizes, ELF magic and exact equality after zero padding. It performs no network call or signing and does not establish loader ownership, program binding or upgrade authority; those require separate finalized account checks. A future upgrade must fail this comparison rather than silently refreshing the approved hash.

## Validation and limits

The operational review passed 61 upstream Rust tests, 95 captured-program launch/bridge/recovery tests, 94 Telegram tests and 373 tweet-bot tests: 623 unique cases, no failures or skips. The integration cases used synthetic keys/funds and the captured mainnet executable in an offline VM. They covered mint/pool binding, liquidity locks, creator/platform fee rights, unauthorized claim/withdrawal rejection, initial-buy atomic rollback, exact receipts and recovery. Only the Telegram suite is shipped in this application directory; the other counts describe the separate review workspace.

The live backend changed only its reviewed program hash, retaining its authority, size, fee owner, preset, confirmation depth, signing grants and budgets. Cached policy users were restarted in a controlled order. Telegram was connected and launch-ready at the final 12:09 UTC observation on 21 October. The tweet bot's legacy Meteora verifier was aligned to the same hash in its separate source/release; that bot is outside this repository's published application scope. Its discarded-reply tombstones and 24-hour expiry were preserved.

Existing financial journals were preserved byte for byte. One pre-existing, unrelated native fast-send operation remained submission-unknown; this review neither replayed nor cleared it. Code rollback must never restore older financial journals. No funded launch, real transaction, test message or public reply was initiated during the repair. Availability checks do not establish every balance or funded end-to-end outcome.

This publication contains only the narrow Telegram repair and public review evidence. It does not publish the separate deployment backend or integrate concurrent browser-wallet, CLI, indexer or website work. Server paths, SSH helpers, credentials, configuration and private operational records remain excluded.
