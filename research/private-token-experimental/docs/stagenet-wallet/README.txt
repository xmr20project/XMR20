XMR20 STAGENET — TEST FUNDS ONLY: a separate test wallet you can open and try yourself
research/privacy-stagenet-wallet-20261024, 24 October 2026. Experimental research build. Not audited. Not for real funds.

WHAT THIS IS
  The private-token wallet popup (the same extension code as the research candidates, built with
  XMR20_PRIVATE_HOLDER_TEST=stagenet) bound to Monero STAGENET through the isolated local node in
  operations/stagenet-node-20261023. It is a separate extension ("XMR20 Stagenet — Test funds only", version 0.1.94,
  its own extension id) that only talks to 127.0.0.1:8961 (the local stagenet test service) and 127.0.0.1:38091 (the
  isolated stagenet node). Mainnet nodes are refused by the worker before anything is scanned. It never replaces or
  touches your installed XMR20 Wallet or your normal browser profiles.

WHAT WORKS IN THE POPUP
  - Private-by-default tokens: keys derived in the extension from the account's recovery phrase (XMR20-TKD1); notes
    scanned locally from the public stagenet chain; proofs made in the extension; exact change back to you.
  - Holder-paid carriers: the exact stagenet XMR fee is shown and must be approved BEFORE anything is proved.
  - Pending/confirmed states: "published", "mined · n of 10 confirmations", "confirmed"; never "confirmed" early.
  - Lookup before retry: after an uncertain broadcast (no reply from the node) the wallet asks the node whether it
    already holds the carrier and re-sends the SAME signed transaction only if the node does not know it. Inputs spent
    by unconfirmed transactions in the node's pool are never chosen again. Nothing is re-sent blindly.
  - Test services (labelled): "Request stagenet XMR … from the public faucet" (0.01 sXMR per address per hour,
    cypherfaucet.com) and "Request 10 X test tokens from the test issuer" (the lab issuer publishes a credit to your
    private address and pays that carrier's fee). No bridge, no payouts, no trading in this build.

HOW TO TRY IT (about 10 minutes of clicking, plus stagenet block times)
  1. cd research/privacy-stagenet-wallet-20261024 && ./launch.sh
     The launcher checks the stagenet node (starts it with its own start.sh only if it is down and >= 20 GB are free),
     builds the extension if needed, starts the test service (the lab issuer/indexer replay the pool from block
     2,235,745; about a minute) and opens Playwright's Chromium with a DEDICATED profile under ./profiles with the
     extension loaded. The popup opens as a tab. Closing the window stops the service; the node keeps running.
     (Manual alternative: open a NEW Chrome profile, chrome://extensions, Developer mode, Load unpacked,
     wallet-extension/extension-stagenet-test; run `node backend/stagenet-service.mjs` yourself. Never load it in the
     profile that holds your real wallet.)
  2. "Create a wallet": choose a password; the account gets a Solana key and a 25-word Monero phrase (keep both; this is
     a test wallet, but the phrase alone recovers the tokens). Skip the mainnet balances on the home screen: the badge
     says STAGENET · TEST FUNDS ONLY and the Solana/XMR rows are not used here.
  3. Open the "X" row (XMR20 private (stagenet test)). You see your private token address (receive here), your
     account's STAGENET XMR address (fees), the XMR-for-fees line and the test-service buttons.
  4. Click "Request stagenet XMR …" once (the faucet pays 0.01 sXMR; it unlocks after 10 blocks, 20-60 minutes).
     Click "Request 10 X test tokens …" once or twice (each credit is one 10 X note; visible after it is mined).
     Press Refresh (↻) now and then; confirmations arrive with real stagenet blocks (typically 2-10 minutes apart).
  5. Send: "Send" -> paste another account's private token address -> amount -> "Send" -> read the fee review ->
     "Approve fee and send". Proving takes ~30 s. The pending list shows the carrier txid and its state until it is
     confirmed; the recent-operations list keeps the history. A second account (Accounts -> add) in the same popup is
     the easiest way to test receiving.
  6. Recovery: in a FRESH profile (./launch.sh --profile profiles/second) import the same phrase: the balance and the
     notes come back from the chain alone; the pending journal is per installation and does not travel.

WHAT TO EXPECT ON STAGENET
  Fees were 50,660,000-50,780,000 piconero per carrier at 20,000 piconero/byte (stagenet rate; mainnet differs).
  Each carrier is ~2.5 kB with a 1,056-byte tx_extra. Confirmation = 10 stagenet blocks. Faucet coins are worthless.

EVIDENCE OF THE AUTOMATED RUNS (see RESULTS.txt)
  browser-carrier.test.mjs: SIMULATED (offline fakechain) real-popup suite with the ported lookup-before-retry.
  browser-stagenet.test.mjs: EXECUTED ON STAGENET: two fresh accounts in the real popup — issuer credits received,
  send with exact change, an ACTUAL lost broadcast reply recovered without re-sending, close/reopen and lock/unlock
  without re-sending, confirmation, exact balances and fees, recovery into a fresh installation. Evidence under
  evidence/stagenet-popup-*/ (screenshots never show a phrase) and runs/stagenet-popup-results.json.

STAYS GATED / UNCHANGED
  Bridge payouts and native XMR trading are not present in this build and remain gated elsewhere. Readiness is
  unchanged: NO-GO for real funds (disposable single-party proving parameters, no independent security review,
  unresolved bridge/trading rollback-loss counterexamples; see research/privacy-stagenet-roles-20261023/review/).
  Nothing here deploys, merges or replaces anything.
