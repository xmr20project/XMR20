import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { WXMR, SOL, SLIPPAGE_BPS } from "./amounts.js";
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const SHARED = Buffer.from([209, 152, 83, 147, 124, 254, 216, 233]),
  ROUTE = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);
const eq = (a, b) => new PublicKey(a).equals(new PublicKey(b));
const same = (a, b) =>
  a.programId.equals(b.programId) &&
  a.data.equals(b.data) &&
  a.keys.length === b.keys.length &&
  a.keys.every(
    (k, i) =>
      k.pubkey.equals(b.keys[i].pubkey) &&
      k.isSigner === b.keys[i].isSigner &&
      k.isWritable === b.keys[i].isWritable,
  );
export const deserializeIx = (i) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner === true,
      isWritable: k.isWritable === true,
    })),
    data: Buffer.from(i.data, "base64"),
  });
export function validateQuote(q, { wallet, inputMint, outputMint, amount }) {
  if (
    !q ||
    q.inputMint !== inputMint ||
    q.outputMint !== outputMint ||
    q.inAmount !== String(amount) ||
    q.swapMode !== "ExactIn" ||
    q.slippageBps !== SLIPPAGE_BPS ||
    !/^\d+$/.test(q.outAmount) ||
    !/^\d+$/.test(q.otherAmountThreshold) ||
    !Array.isArray(q.routePlan) ||
    !q.routePlan.length
  )
    throw Error("Jupiter quote does not match the requested trade.");
  const out = BigInt(q.outAmount),
    floor = (out * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
    threshold = BigInt(q.otherAmountThreshold);
  if (
    out <= 0n ||
    floor <= 0n ||
    threshold < floor ||
    threshold > floor + 1n ||
    q.platformFee?.feeBps > 0 ||
    !Number.isFinite(Number(q.priceImpactPct)) ||
    Math.abs(Number(q.priceImpactPct)) > 0.05
  )
    throw Error("Jupiter quote exceeds the bridge price/fee limits.");
  return {
    // Preserve the validated provider threshold, including its one-unit
    // rounding. Recomputing floor here disagrees with the funding review.
    minimumOut: threshold.toString(),
    inputMint,
    outputMint,
    amount: String(amount),
    wallet,
  };
}
export function bridgeInstructions(payload, review) {
  const { wallet, inputMint, outputMint, amount } = review,
    owner = new PublicKey(wallet),
    input = new PublicKey(inputMint),
    output = new PublicKey(outputMint);
  if (
    ![WXMR, SOL].includes(inputMint) ||
    ![WXMR, SOL].includes(outputMint) ||
    inputMint === outputMint ||
    BigInt(amount) <= 0n
  )
    throw Error("Unsupported bridge pair.");
  const quote = validateQuote(payload, review);
  if (quote.minimumOut !== review.minimumOut)
    throw Error("Minimum output changed.");
  if (
    payload.tokenLedgerInstruction ||
    payload.otherInstructions?.length ||
    payload.tipInstruction ||
    !payload.swapInstruction
  )
    throw Error("Unsupported Jupiter instructions.");
  const src = getAssociatedTokenAddressSync(input, owner),
    dst = getAssociatedTokenAddressSync(output, owner),
    wsol = getAssociatedTokenAddressSync(new PublicKey(SOL), owner);
  const swap = deserializeIx(payload.swapInstruction),
    d = swap.data,
    shared = d.subarray(0, 8).equals(SHARED),
    route = d.subarray(0, 8).equals(ROUTE);
  if (!swap.programId.equals(JUP) || (!shared && !route))
    throw Error(
      "Unsupported Jupiter swap version. Execution remains disabled for this route.",
    );
  const offset = shared ? 9 : 8;
  if (
    d.length < offset + 26 ||
    d.readBigUInt64LE(offset) !== BigInt(amount) ||
    d.readBigUInt64LE(offset + 8) !== BigInt(payload.outAmount) ||
    d.readUInt16LE(offset + 16) !== SLIPPAGE_BPS ||
    d.readUInt16LE(offset + 18) !== 0 ||
    d.readUInt16LE(offset + 20) !== 0
  )
    throw Error("Jupiter instruction amount, slippage or fees changed.");
  const keys = swap.keys,
    indices = shared ? [1, 2, 5, 6, 7, 8, 9, 11] : [0, 1, 2, 3, 4, 5, 6, 9];
  for (const [i, k] of [
    owner,
    src,
    dst,
    input,
    output,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    JUP,
  ].entries())
    if (!keys[indices[i]]?.pubkey.equals(k))
      throw Error(
        "Jupiter route uses an unexpected owner, token account or mint.",
      );
  if (
    !keys[indices[0]].isSigner ||
    swap.keys.some((k) => k.isSigner && !k.pubkey.equals(owner))
  )
    throw Error("Unexpected swap signer.");
  if (route && !keys[7]?.pubkey.equals(JUP) && !keys[7]?.pubkey.equals(dst))
    throw Error("Unexpected destination override.");
  const allowed = [
    createAssociatedTokenAccountIdempotentInstruction(owner, src, owner, input),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      dst,
      owner,
      output,
    ),
  ];
  if (inputMint === SOL)
    allowed.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: wsol,
        lamports: BigInt(amount),
      }),
      createSyncNativeInstruction(wsol),
    );
  const setup = (payload.setupInstructions || []).map(deserializeIx),
    seen = new Set();
  for (const ix of setup) {
    const index = allowed.findIndex((a) => same(ix, a));
    if (index < 0 || seen.has(index))
      throw Error("Unexpected or duplicate Jupiter setup instruction.");
    seen.add(index);
  }
  if (inputMint === SOL && (!seen.has(2) || !seen.has(3)))
    throw Error("Missing exact SOL wrap instruction.");
  const close = createCloseAccountInstruction(wsol, owner, owner);
  if (
    !payload.cleanupInstruction ||
    !same(deserializeIx(payload.cleanupInstruction), close)
  )
    throw Error("SOL cleanup destination is not the connected wallet.");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    ...setup,
    swap,
    close,
  ];
  if (review.direction === "withdraw") {
    if (
      inputMint !== WXMR ||
      BigInt(review.depositLamports) <= 0n ||
      BigInt(review.depositLamports) > BigInt(review.minimumOut) ||
      !review.payinAddress ||
      eq(review.payinAddress, wallet)
    )
      throw Error("Invalid ChangeNOW deposit.");
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: new PublicKey(review.payinAddress),
        lamports: BigInt(review.depositLamports),
      }),
    );
  } else if (review.direction !== "deposit" || inputMint !== SOL)
    throw Error("Unexpected bridge direction.");
  return instructions;
}
export function lookupTables(records) {
  return records.map(
    (r) =>
      new AddressLookupTableAccount({
        key: new PublicKey(r.key),
        state: {
          deactivationSlot: 18446744073709551615n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: r.addresses.map((k) => new PublicKey(k)),
        },
      }),
  );
}
export function validatePrepared(prepared, wallet) {
  const { review, payload, tables } = prepared;
  if (wallet !== review.wallet)
    throw Error("Reconnect the original bridge wallet.");
  const tx = VersionedTransaction.deserialize(
    Buffer.from(prepared.transaction, "base64"),
  );
  if (
    tx.message.version !== 0 ||
    tx.message.header.numRequiredSignatures !== 1 ||
    !tx.message.staticAccountKeys[0].equals(new PublicKey(wallet))
  )
    throw Error("Unexpected bridge fee payer.");
  const expected = new TransactionMessage({
    payerKey: new PublicKey(wallet),
    recentBlockhash: tx.message.recentBlockhash,
    instructions: bridgeInstructions(payload, review),
  }).compileToV0Message(lookupTables(tables));
  if (
    !Buffer.from(expected.serialize()).equals(
      Buffer.from(tx.message.serialize()),
    )
  )
    throw Error("Bridge transaction differs from the reviewed route.");
  return tx;
}
