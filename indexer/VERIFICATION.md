# What this release lets you verify

Release: reader 0.2.0. This document distinguishes implemented checks from
checks still requiring real mainnet evidence or independent review.

## Remaining trust assumptions

| Question | What 0.2.0 provides | What it does not establish |
| --- | --- | --- |
| Can I rebuild without the project API/database? | Chain-derived discovery, local signatures, own database and configurable node endpoints | A completed full mainnet isolation run for this release |
| Can the website hide a token from this reader? | No website listing flags are consulted | Admission is still limited by the published authority, rules and explicit historical exclusions |
| Can I independently validate the underlying chain? | You can use your own validating nodes as RPC sources | This application does not itself implement Monero or Solana consensus; two Monero URLs can share one operator |
| Is the token accounting internally consistent? | Exact deposits, whole-mint holder enumeration, integer supply and backing checks at stated checkpoints | A fabricated RPC response or self-consistent report is not a cryptographic chain proof |
| Who controls bridge release? | The source exposes how the read-side checks work | Publishing an indexer does not remove attestors, prevent withholding or guarantee withdrawals |
| Is the deployed code the same as this source? | Pinned Solana program bytes and immutability are checked against constants | A reviewed source-to-binary build for those programs, primary server parity or a security audit |

The configured authority still signs deployments and credits. The bridge still
uses its existing withdrawal authorization. A burn reduces the indexed Monero
obligation; it is not proof that a Solana withdrawal was delivered. Aggregate
`inTransitRaw` is an accounting difference, not an individual pending-payment
promise. The reader cannot stop an operator or automatically enforce a release.

All RPC data must come from nodes you choose to trust or independently validate.
This reader does not verify consensus inclusion proofs from arbitrary RPC servers.
Peer agreement reduces some errors; it does not turn two URLs into trustless
verification. Public XMR20 records also have different privacy properties from
native Monero payments.

## Reproduce the build

Use a clean checkout at an explicitly recorded commit and an empty reader state
directory. Record Node, npm, Python, operating system and architecture versions.
Install dependencies using the committed lockfile and disabled install scripts:

```sh
cd indexer
npm ci --ignore-scripts
npm test
cp build/hashes.json /tmp/xmr20-first-build-hashes.json
npm run build
cmp /tmp/xmr20-first-build-hashes.json build/hashes.json
```

For stronger build evidence, repeat in a second clean checkout with the same
toolchain and compare both `build/hashes.json` files. No cross-toolchain or
cross-platform byte identity is promised. The source fingerprint covers `src/`,
`build.mjs`, `package.json` and `package-lock.json`; it is an identifier, not a
signature by an independent reviewer. The runtime manifest separately covers
the bundled code, scanner files and Monero runtime.

CI installs dependencies first, then runs the synthetic test suite in a network
namespace with no outside access. It also repeats the build and compares output
hashes. This demonstrates that tests have no live-API dependency, not that every
real-world chain history has been successfully replayed.

## Recompute and compare real state

1. Each operator builds the reader independently and chooses their own Monero
   and Solana RPC endpoints. Prefer an independently maintained validating node.
   Do not copy the project database, another operator's cache or balance list.
2. Review the example policy. Use the same policy and scan start for comparable
   results. Keep private endpoint access details out of reports and GitHub.
3. Start from an empty `dataDir`. Optionally block all XMR20 project API domains
   while permitting the chosen blockchain endpoints. Record that restriction
   and progress evidence if you later claim an isolated replay succeeded.
4. For a coordinated comparison, agree on a recent Monero height and set
   `replayHeight` to it. Confirm both reports contain the same block hash. Null
   follows the tip. A pinned height appears in health output and does not
   represent current Monero balances after that height.
5. Wait for a completed publication and export `/verification`. Archive the
   source commit, runtime hashes, policy, report, elapsed time and any failures.
6. Run `npm run compare -- my-report.json other-report.json` locally.

The comparison tool returns:

| Result | Meaning | Exit code |
| --- | --- | --- |
| `MATCH` | Same policy and chain checkpoints; same calculated ledger and backing | 0 |
| `LEDGER_MATCH_BACKING_NOT_COMPARABLE` | Same Monero ledger, different Solana checkpoints | 2 |
| `NOT_COMPARABLE` | Different policy or Monero checkpoint | 2 |
| `MISMATCH` | Different calculated state at the compared checkpoints | 1 |
| `INVALID_REPORT` | Wrong schema/rules or inconsistent report digests/checkpoints | 1 |

A `MATCH` also reports `sameSource`. Equal outcomes from different sources can
be useful, but investigate which implementations produced them. Hashes alone
do not authenticate any operator, endpoint or chain data.

The reader requires exact matching finalized slots within each token's Solana
account reads, with five attempts before delaying. Different tokens and
operators may use different slots. Ordinary RPC `minContextSlot` is a lower
bound, **not historical-slot selection**. Pinning Monero cannot reproduce old
Solana state; sufficiently old Monero state combined with current Solana
withdrawals can fail reconciliation. Full historical cross-chain comparisons
need suitable archived evidence and additional tooling. There is no atomic
snapshot shared by both blockchains.

## Verification completed for this source release

Local tests cover:

- V1/V2/V3 chain-derived discovery and reconciliation against synthetic raw
  accounts, with no primary catalog.
- Missing, ambiguous or changed escrow bindings; malformed account evidence;
  incomplete and duplicate holders; wrong deposit backing; mutable programs;
  mismatched binary hashes and moving Solana contexts.
- Published historical exclusions, admission consistency and primary listing
  flags not controlling discovery.
- Native spend-signature verification and rejection of altered messages and
  transaction-capable methods.
- Scanner catch-up, synthetic reorg rollback, pinned-height replay, SQLite
  publication, stale/incomplete responses and pagination revisions.
- Deterministic report comparison, tampering, policy changes and incomparable
  Monero/Solana checkpoints.

The executable fixtures in `test/fixture.mjs`, `test/discovery.test.mjs` and the
other test files are synthetic test vectors. Test program manifests deliberately
use fixture binary hashes; the production CLI uses only the pinned mainnet
constants. Fixtures are never evidence of actual funds or actual deployment.

## Evidence still needed before a stronger claim

- Complete replay from the published start using this release, an empty cache
  and no XMR20 project API access; publish checkpoints and reproducible evidence.
- At least one separately operated rebuild and comparison. Agreement between
  two copies of the same implementation does not exclude a shared bug; a second
  implementation of the documented rules is stronger evidence.
- Primary-service comparison at compatible checkpoints, with discrepancies
  investigated and documented. Primary agreement alone is not correctness.
- Independent review of protocol rules, scanner, dependencies, bridge programs,
  authority control and withdrawals, including source-to-deployed-binary builds.
- Resource measurements on full history, deep reorg analysis, and separately
  tested wallet integration/failover before routing funded wallets to it.

This source publication does not certify those gates as passed. History and
account limits currently cap scans at 100,000 accepted-format events and 20,000
planned/enumerated accounts per token. The scanner caches history in JSON and
replays it; storage, memory and work increase with history. New protocol or
program versions require a reviewed software/policy update.
