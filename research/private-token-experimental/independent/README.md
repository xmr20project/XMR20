# independent/ — decoder and checks written from the specification

`decode.mjs` implements, from `../SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.txt` and with Node's
`crypto` only (plus `@noble/hashes` BLAKE2b in the vector check): tx_extra unframing (SPEC 7.2), the
XM3/XB3 byte layouts (6.1/6.2) with their structural rules, record ids (6.5), authorization-message
preimages (6.4), ledger-domain recomputation and manifest structure/hash checks (4), and the Monero
mnemonic decoding rule (3.1, wordlist to be supplied). It shares no code with the holder engine.

`check.mjs` validates `../vectors/vectors.json` with it and prints three lists:

- **checked** — what the independent code reproduced from the specification;
- **failed** — mismatches (an undocumented assumption in the implementation or an error in the text);
- **notCheckable** — what needs decaf377 / Poseidon / decaf377-rdsa / Groth16 / decaf377-ka, for which
  no established JavaScript library exists: note commitments, nullifiers, value commitments,
  signatures, proofs, payload decryption, address derivation from the token spend key. These are
  verified only by the shared engine and remain subject to independent security review.

Distinguish three things when reading results: **application interoperability** (two applications
on one engine exchanging tokens — `../interop.test.mjs`), **independent decoding** (this directory:
layouts, hashes, framing, key-derivation PRF), and **cryptographic security review** (not performed).
