# Transferable bridge program source

Rust source and pinned Cargo dependency lock for the ABI 3 transferable testing program. The original implementation is published alongside the wallet SDK, record format and deployment policy. Program ID: `8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB`. It retains upgrade authority. Transfers and releases require the holder and verifier; the program does not itself verify Monero consensus. This is experimental code, without an independent security audit.

The deployment review pinned a 155960-byte binary with SHA-256 `2f585a595e6d9071cd2f183c4f1a84c0552d93954cad122d67dc3592099c963a`. That is deployment evidence, not a promise that arbitrary toolchain versions reproduce the binary. Source uses Solana 2.3.0 and the versions in Cargo.lock. Build with a compatible Solana SBF toolchain; do not deploy automatically. Runtime admission and wallet proof/signature checks remain necessary. Publishing this source performs no upgrade or authority change.
