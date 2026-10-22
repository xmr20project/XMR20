// PUBLIC TEST MATERIAL ONLY. These keys are fixed integers/bytes, not wallets.
// Native signatures and range proofs below are ZERO PLACEHOLDERS and INVALID.
// This exercises overlay code, never Monero consensus or real-money settlement.
import {ed25519} from '@noble/curves/ed25519';
import assert from 'node:assert/strict';
import {hash, hex, join, uint, varint} from './bytes.mjs';
import {LOCAL_PROFILE, encodeRecord, manifestId} from './records.mjs';
import {creditMessage, claimMessage, claimChallenge, recipientMessage, legacyHashToPoint, ORDER} from './proofs.mjs';
import {decodeCarrier, framePayload, inspectCarrier} from './carrier.mjs';
import {PrototypeIndex} from './replay.mjs';

export const ZERO = '00'.repeat(32);
export const label = text => hash(Buffer.from(text)).toString('hex');
const publicFixtureSecrets = new Map();
export const key = scalar => {
  const publicKey = Buffer.from(ed25519.ExtendedPoint.BASE.multiply(BigInt(scalar)).toRawBytes()).toString('hex');
  publicFixtureSecrets.set(publicKey, BigInt(scalar)); return publicKey;
};
export const keyImage = scalar => Buffer.from(legacyHashToPoint(key(scalar)).multiply(BigInt(scalar)).toRawBytes()).toString('hex');
export const issuers = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)].map(seed =>
  ({seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex')})).sort((a, b) => a.publicKey.localeCompare(b.publicKey));
export function fixtureManifest() {
  return {genesis: label('XN1 fixture genesis - not a real network'), asset: label('fixture asset'), height: 0n,
    blockHash: label('checkpoint'), decimals: 6, cap: 1000000n, depth: 10, profile: LOCAL_PROFILE,
    issuerScheme: 1, threshold: 2, issuers: issuers.map(i => i.publicKey), recovery: 0, identity: 0xfd,
    bridgeDomain: label('fixture bridge')};
}
export function creditRecord(manifest, overrides = {}) {
  return {op: 'CREDIT', manifest: manifestId(manifest), issuance: label('issue-1'), lock: label('lock-1'),
    epoch: 0, vout: 0, amount: 1000n, image: keyImage(11), c: ZERO, s: ZERO,
    signatures: issuers.map((_, signer) => ({signer, signature: ZERO + ZERO})), ...overrides};
}
export function claimFor(txid, overrides = {}) {
  return {vin: 0, ringPos: 0, source: {txid, vout: 0}, c: ZERO, s: ZERO, ...overrides};
}
export function nativeFixture(record, {serial = 1, outputKeys = [key(11), key(12)], inputs, fee = 10000n, extra, nativeSignatureByte = 0} = {}) {
  const nativeInputs = inputs ?? [{keyImage: key(10000 + serial), offsets: Array.from({length: 16}, (_, i) => BigInt(i))}];
  const nonce = extra ?? framePayload(encodeRecord(record));
  const fullExtra = join(Buffer.from([1]), hex(key(20000 + serial)), nonce);
  const prefix = join(varint(2), varint(0), varint(nativeInputs.length), ...nativeInputs.map(input => join(
    Buffer.from([2]), varint(0), varint(16), ...input.offsets.map((offset, i) => varint(i ? offset - input.offsets[i - 1] : offset)), hex(input.keyImage))),
  varint(outputKeys.length), ...outputKeys.map(k => join(varint(0), Buffer.from([3]), hex(k), Buffer.from([0]))), varint(fullExtra.length), fullExtra);
  const rounds = 6 + Math.ceil(Math.log2(outputKeys.length));
  const base = join(Buffer.from([6]), varint(fee), Buffer.alloc(outputKeys.length * 8), ...outputKeys.map((_, i) => hex(key(30000 + serial + i))));
  const rangeProof = join(varint(1), Buffer.alloc(192), varint(rounds), Buffer.alloc(rounds * 32), varint(rounds), Buffer.alloc(rounds * 32));
  return join(prefix, base, rangeProof, Buffer.alloc(nativeInputs.length * (16 * 32 + 64), nativeSignatureByte), Buffer.alloc(nativeInputs.length * 32));
}
export function authorize(inputRecord, options = {}, secrets = [11n], {preserveRecipientProofs = false} = {}) {
  const record = structuredClone(inputRecord), outputKeys = options.outputKeys ?? [key(11), key(12)];
  const allocations = record.op === 'CREDIT' ? [record] : record.allocations;
  for (const a of allocations) {
    if (!preserveRecipientProofs) {
      const secret = publicFixtureSecrets.get(outputKeys[a.vout]); assert.ok(secret);
      Object.assign(a, {image: keyImage(secret), c: ZERO, s: ZERO});
    }
  }
  const unsigned = nativeFixture(record, options), tx = inspectCarrier(unsigned), context = decodeCarrier(tx).context;
  const signed = structuredClone(record);
  function proof(secret, message, image, nonce) {
    const outputKey = key(secret), a = ed25519.ExtendedPoint.BASE.multiply(nonce), b = legacyHashToPoint(outputKey).multiply(nonce);
    const c = claimChallenge(message, outputKey, image, a, b), s = ((nonce - c * secret) % ORDER + ORDER) % ORDER;
    return {c: uint(c, 32).toString('hex'), s: uint(s, 32).toString('hex')};
  }
  if (!preserveRecipientProofs) {
    for (const a of signed.op === 'CREDIT' ? [signed] : signed.allocations) {
      const outputKey = tx.outputs[a.vout].key, secret = publicFixtureSecrets.get(outputKey);
      Object.assign(a, proof(secret, recipientMessage(record.manifest, context, a, outputKey), a.image, 50000n + BigInt(a.vout)));
    }
  }
  if (record.op === 'CREDIT') {
    signed.signatures = record.signatures.map(s => ({signer: s.signer, signature: Buffer.from(ed25519.sign(
      creditMessage(record, context, tx.outputs[record.vout].key), issuers[s.signer].seed)).toString('hex')}));
  } else {
    signed.claims = record.claims.map((claim, i) => {
      const secret = BigInt(secrets[i]), outputKey = key(secret), image = keyImage(secret);
      // Deliberately fixed NONCES FOR PUBLIC FIXTURES ONLY, not a signing design.
      const nonce = 40000n + BigInt(i);
      const message = claimMessage(record.manifest, context, claim, outputKey, image, record.op);
      return {...claim, ...proof(secret, message, image, nonce)};
    });
  }
  const data = nativeFixture(signed, options);
  assert.equal(decodeCarrier(inspectCarrier(data)).context, context);
  return {record: signed, bytes: data, txid: inspectCarrier(data).txid, context};
}
export function append(index, transactions = [], name = '') {
  const state = index.snapshot(), height = state.height + 1n;
  return index.applyBlock({height, hash: label(`block:${height}:${state.blockHash}:${name}`), parent: state.blockHash, transactions});
}
export const observation = (tx, start = 100n) => ({bytes: tx.bytes,
  outputIndices: inspectCarrier(tx.bytes).outputs.map((_, i) => start + BigInt(i))});
export function fundedIndex() {
  const manifest = fixtureManifest(), index = new PrototypeIndex(manifest), credit = authorize(creditRecord(manifest));
  assert.equal(append(index, [observation(credit)])[0].status, 'accepted');
  while (index.snapshot().height < 10n) append(index);
  return {index, manifest, credit};
}
export function sale(credit, manifest, overrides = {}, options = {}) {
  const record = {op: 'MOVE', manifest: manifestId(manifest), claims: [claimFor(credit.txid)],
    allocations: [{vout: 0, amount: 1000n}], ...overrides};
  const nativeOptions = {serial: 2, outputKeys: [key(22), key(23)], inputs: [
    {keyImage: keyImage(11), offsets: Array.from({length: 16}, (_, i) => 100n + BigInt(i))},
    {keyImage: key(10002), offsets: Array.from({length: 16}, (_, i) => BigInt(i))}], ...options};
  return {...authorize(record, nativeOptions), options: nativeOptions};
}
