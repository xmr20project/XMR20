# XMR20 reader rules 0.2.0

This is a description of the rules implemented by this reader, including its
current restrictions and historical policy. It is not a new bridge protocol,
a security audit or proof that the live primary uses exactly these rules.
Links below identify executable rules and fixtures for independent review or
a second implementation. If the prose and code disagree, report the discrepancy;
do not silently change an index to match a website balance.

## 1. Inputs and checkpoints

Start at Monero block 3,772,610 under the supplied policy. Transfer admission
begins at 3,773,055. The public operator address and two exact excluded
`(txid, mint, ticker)` tuples are in [config.example.json](config.example.json).
All policy and scan-start values feed the report's policy hash. Changing them
can produce a different ledger.

Two synchronized mainnet daemon endpoints must agree on checked block hashes;
their tips must be within two blocks. Scan through the lower tip minus one, or
through `replayHeight` when explicitly configured. Relevant payloads must also
agree between both peers. Retain block order and transaction order within each
block. Count confirmations as `checkpointHeight - eventHeight + 1`; only events
with at least 10 confirmations enter replay. A fixed replay height uses
confirmations at that historical checkpoint, not today's confirmation count.

The scanner processes up to 12 additional blocks per pass, persists its cache,
and invalidates a changed suffix back to a matching ancestor on reorg. No
partial catch-up is published as a complete ledger. These are RPC checks, not
independent consensus or transaction-inclusion verification.

Code: [bridge_rules.py](src/bridge_rules.py), [service.py](src/service.py).

## 2. Carrier and signatures

An accepted payload starts with the bytes `XMR20M1`, followed by canonical JSON
for exactly `{ "record": ..., "signature": ... }`. Canonical JSON sorts object
keys, uses no extra whitespace, and escapes non-ASCII characters. The complete
payload is at most 800 bytes. Monero transaction `extra` is at most 1,060 bytes.

The payload is split over one to four nonce fragments. Each starts with `XM2`,
a zero-based one-byte fragment index and a one-byte total count. Non-final
fragments are exactly 245 bytes including that five-byte header; the last is
at most 245 and has a nonempty payload. Ordering/counts must agree. Unsupported
extra tags, malformed varints, duplicate/out-of-order fragments and
noncanonical envelopes are rejected.

The signature is Monero `SigV2`, verified locally against the record's `owner`.
It must be a current version-2 **spend** signature. Owner and applicable Monero
recipient addresses must be standard mainnet addresses, not subaddresses or
integrated addresses. No private key is supplied to the reader.

The signed message is the exact domain below followed by the canonical record
JSON. Each displayed `\n` means one newline byte, not a backslash and `n`.

| Record | Signing domain |
| --- | --- |
| Deployment v1 | `MOUSE-ROAD-XMR20-MAINNET-DEPLOY-V1\n` |
| Deployment v2 | `XMR20-MAINNET-DEPLOY-V2\n` |
| Credit or burn v1 | `MOUSE-ROAD-XMR20-MAINNET-BRIDGE-V1\n` |
| Transfer v1 | `MOUSE-ROAD-XMR20-MAINNET-TRANSFER-V1\n` |

Legacy names are protocol bytes. They must not be renamed as a branding change.

Code: [probe_rules.py](src/probe_rules.py), [launch_rules.py](src/launch_rules.py),
[bridge_rules.py](src/bridge_rules.py), [verifier.mjs](src/verifier.mjs).

## 3. Record shapes and ledger admission

All records use `p: "xmr20"`, `net: "mainnet"` and a lowercase 32-hex nonce.
Unknown or extra fields are rejected by the scanner.

| Operation | Exact field set |
| --- | --- |
| deploy | `p,v,net,op,owner,nonce,tick,mint,creator,chain,max,initial,fee,meta` |
| credit | `p,v,net,op,owner,nonce,token,amount,to,deposit` |
| transfer / burn | `p,v,net,op,owner,nonce,token,amount,to` |

Deployment version is 1 or 2; other operations are version 1. Deployment `owner`
must equal the configured authority. `tick` matches `[A-Z][A-Z0-9]{0,9}`;
`meta` is 64 lowercase hex characters. Mint and creator are valid on-curve Solana
public keys. `chain` is `mainnet-beta` for deployment v1 and `mainnet` for v2.
`max` is the decimal string `1000000000000000`, `initial` is `0`, and `fee` is
`200` or `150`. This reader requires mint decimals 6: the cap is one billion
display units. A Monero deployment initially creates zero indexed balance.

Replay is ordered. An accepted `(owner, nonce)` is globally single-use across
operations. A rejected operation does not consume its nonce. Mint reuse is
rejected; v1 deployments also reject an already-used ticker. Apply exact
historical exclusions before admission. Token identity is the deployment's
64-hex transaction hash, referenced by subsequent records as `token`.

Amounts are positive base-10 integer strings with no leading zeros, at most
`50000000000000` raw units per credit/transfer/burn. No floating point is used
for balances. Fees already reflected in a verified net deposit amount are not
subtracted again by the Monero ledger.

- **Credit:** signed by the configured authority; unique deposit receipt;
  standard Monero recipient. The finalized receipt belongs to the selected
  escrow, derives to the supplied deposit address, has matching raw net amount
  and SHA-256 of the recipient address. An authority signature alone cannot
  create accepted backing. Increase recipient balance and outstanding supply.
- **Transfer:** at/after transfer activation, signed by the sending standard
  Monero address, to a different standard address, with sufficient balance.
  Move the exact amount without changing outstanding supply.
- **Burn:** signed by a holder with sufficient balance, to a valid on-curve
  Solana address. Decrease holder balance and outstanding supply. Actual release
  on Solana is a separate bridge operation; this reader never authorizes it.

Code: [replay.mjs](src/replay.mjs). The service supplies events already checked
by the signature scanner; calling replay directly on arbitrary JSON bypasses
that boundary and is not a valid verification procedure.

## 4. Discovery and Solana binding

Discover eligible deployment declarations from scanned events. No website token
list or hidden/listed flag participates. A provisional replay without credited
balances finds declarations; final balance-aware replay must admit the same
set, otherwise publication fails closed. This can delay a history with an
admission/nonce conflict instead of guessing a different policy.

For each mint derive the escrow config PDA under all three pinned programs,
and inspect raw account ownership, format, mint, vault and deployment hash.
A 200-bps declaration binds V1; a 150-bps declaration binds V2 or V3. Exactly
one matching escrow is allowed. Mismatched existing configurations or multiple
matches cause rejection. Recheck all candidate configs at the accounting slot
so the binding cannot change unnoticed between discovery and reconciliation.

| Version | Program ID |
| --- | --- |
| V1 | `G4Cedy1wgpCnAAn3N7NmczwqFHdUrrnSbBV2UnbvzKNp` |
| V2 | `9ZySdqL8A326EfQkU2T8AckeYWCVUeeNyFy42oyVqL4R` |
| V3 | `2wEBASzbdj13KJtmjK7UFhug38oGaWsfvMGhQ3umr265` |

All three program accounts must resolve to immutable upgradeable-loader
ProgramData with the exact binary size/hash pinned in
[accounting.mjs](src/accounting.mjs). This verifies against published byte
constants, not a source-to-binary audit. Solana genesis must match mainnet-beta.
PDA seeds and binary layouts are in [escrow.mjs](src/escrow.mjs).

A declaration without a matching escrow and without any scanned credit is
reported as `unbound`, asserting no holder balance. A credit targeting that
declaration prevents publication rather than hiding missing backing. Artwork
and off-chain names are not fetched; `meta` remains a commitment only.

Code: [discovery.mjs](src/discovery.mjs), [ledger.mjs](src/ledger.mjs).

## 5. Account and supply reconciliation

For each bound mint enumerate **all** Token-2022 accounts, not a top-holder list.
Read mint, config, vault, candidate configs and required deposit receipts at
exactly the enumeration's finalized slot. Requests use `minContextSlot`, but
responses must also have exact slot equality. Retry a moved context up to five
times; otherwise delay publication. Different tokens may have different slots.

The mint must be initialized, have six decimals and no mint/freeze authority.
Escrow ownership, vault authority, receipt derivation and deployment must match.
The vault cannot have a delegate or close authority or be frozen. Enforce the
version-specific tax authorities/rates in `accounting.mjs` and public fund
constants in `fund-policy.mjs`. Enumerated vault bytes must match the separate
vault account read. Reject missing/duplicate accounts and incomplete totals.

Let `S` = mint supply, `V` = vault balance, `L` = escrow locked amount,
`M` = outstanding indexed Monero amount, `W` = withheld tax amount, and
`C` = fixed cap. Require:

```text
0 <= M <= L <= V <= S <= C
sum(non-vault Solana holder balances) + W = S - V
sum(Monero holder balances) = M
inTransitRaw = L - M
unassignedEscrowRaw = V - L
burnedRaw = C - S
```

A Monero withdrawal burn and a permanent Solana supply burn are distinct.
Withheld tax is accounted once. Pending bridge requests are not fetched or
inferred as individual receipts. Invalid evidence prevents a new publication;
it is never replaced by invented zero balances.

Code: [accounting.mjs](src/accounting.mjs), [replay.mjs](src/replay.mjs).

## 6. Reports

`xmr20-verification-v1` reports identify `xmr20-reader-0.2.0`, source fingerprint,
policy hash, Monero block height/hash, per-token Solana slots, accepted operation
IDs, reconstructed ledger and reconciled backing/holders. Integer amounts are
strings. Object keys and report lists are deterministically ordered;
`ledgerSha256` and `backingSha256` hash their canonical JSON. Time-of-read fields
are excluded from state digests.

Reports do not contain a secret, signature, inclusion proof or guarantee about
RPC honesty. A locally calculated match is evidence of agreement at the stated
checkpoints, not proof that the bridge is trustless. Different checkpoints
cannot be compared as though they represented the same state.

Code: [verification.mjs](src/verification.mjs), [compare.mjs](src/compare.mjs).
