SOLANA DEVNET REHEARSAL — PREPARED, BLOCKED ON FAUCET FUNDING (25 Oct 2026)

Scope (handoff priority 4): a separate test deployment of the real custody program (xmr20_joint_escrow.so, sha256 a8b7c791…,
reproduced byte-for-byte from source in this candidate) on Solana DEVNET with fresh test-only accounts, exercising deposits,
private credits (lab issuer on the offline fakechain), transfers, burns and payouts, lost replies, duplicate submissions,
operator restarts and exact backing reconciliation. No real funds, no production program, no existing keys.

What exists
  operator.json, holder-a.json, holder-b.json   fresh devnet-only keypairs generated here (0600). They have never held real value.
  faucet-attempts.log                           every faucet request and its outcome.
  Operator (fee payer / verifier / deployer):   4HUkGrLY3P3vNPmKnobzuMa4eTLVccj1eednxK4KoLCQ   balance 0 SOL

Blocker (external dependency, recorded, not worked around)
  The devnet faucet refused every request from this machine ("airdrop request failed … rate limit") — 7 attempts across the
  afternoon. Deploying a 203,472-byte program needs about 1.5 SOL plus the policy/mint/account rents (~0.1 SOL); the rehearsal
  needs roughly 2 SOL on the operator address and 0.1 SOL on each holder. The web faucet (faucet.solana.com) requires an
  interactive GitHub login, which is an owner action. Nothing else in this session can be substituted for it; the owner's own
  devnet keypair (~/.config/solana/id.json) is deliberately NOT used (handoff: fresh test-only accounts only).

Prepared plan (runs unattended once the operator address holds >= 2 SOL devnet)
  1. solana program deploy proof-of-concepts/joint-escrow-wallet/core-monero-send/target/sbpf-solana-solana/release/xmr20_joint_escrow.so
       --url https://api.devnet.solana.com -k runs/devnet/operator.json --program-id <fresh program keypair>
  2. create a Token-2022 TEST mint (decimals 6, transfer fee 150 bps) with the operator as fee-config authority; mint 10,000 test
     units to holder-a's ATA (devnet test tokens, no value).
  3. initializePolicy (bridge-sdk, operator-verified-v1) for that mint; record program/policy/pool/vault addresses in a manifest.
  4. backend/solana-devnet.mjs: the same interface as backend/solana.mjs (deposit receipt read, redeem instruction, receipt lookup,
     token balances, supply snapshot) over @solana/web3.js Connection with 'finalized' reads — the proof-of-concept already has
     RPC-based adapters (core-monero-send/solana-redemption-adapter.mjs, solana-custody-adapter.mjs) to reuse.
  5. Rehearsal script: deposit (holder-a signs) -> receipt observed finalized -> private credit on the offline fakechain by the lab
     issuer -> private transfer A -> B -> burn by B (XB3) -> 20 confirmations on the fakechain -> operator payout on devnet
     (one receipt per nonce) -> payout retried after a simulated lost reply (same nonce: recovered from the receipt, not paid twice)
     -> duplicate submission refused by the program -> operator restart from its journal mid-payout -> reconciliation:
     mint supply == vault + holder balances + withheld fees; vault == locked + reserve; private outstanding == credits - burns.
  6. Evidence: every signature with explorer links, account snapshots before/after, the backend journal, and a table of which
     parts were REAL (program, Token-2022 mint, RPC finality, fees) versus MOCK (the Monero side stays the offline fakechain; the
     issuer is the lab issuer; no price, liquidity or production policy).

Network differences to label in the report: devnet finality and fee markets differ from mainnet-beta; the test mint is not any
XMR20 mint; the program is a fresh deployment, not the production custody deployment.
