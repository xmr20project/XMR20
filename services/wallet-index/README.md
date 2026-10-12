# Public wallet read adapter

This read-only adapter binds the independent indexer's public deployment IDs to the wallet catalog IDs by exact mint and Monero declaration. Fresh publications use the fixed ten-minute policy; incomplete publications remain last-known. Cached data never authorizes spending. The adapter contains no private endpoint, signing key or database.

Run `node --test services/wallet-index/independent-wallet-index.test.mjs`. The adapter is additive service source: building the extension does not install/restart the primary backend. The complete operator deployment and its private configuration are not included.
