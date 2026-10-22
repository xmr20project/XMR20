// Public synthetic overlay fixtures; no native consensus or real funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PrototypeIndex} from './replay.mjs';
import {fixtureManifest, fundedIndex, sale, authorize, creditRecord, observation, append, label} from './test-fixtures.mjs';

test('bounded rewind preserves old holdings and exact recent state without retaining every block snapshot', () => {
  const {index, manifest, credit} = fundedIndex(), beforeSale = index.snapshot();
  const move = sale(credit, manifest); append(index, [observation(move, 200n)]);
  const afterSale = index.snapshot();
  for (let i = 0; i < 120; i++) append(index);
  const recent = index.snapshot(), recentHash = index.stateHash();
  index.rewind(afterSale.height, afterSale.blockHash);
  assert.deepEqual(index.snapshot(), afterSale);
  index.rewind(beforeSale.height, beforeSale.blockHash);
  assert.deepEqual(index.snapshot(), beforeSale);
  append(index, [observation(move, 200n)]);
  for (let i = 0; i < 120; i++) append(index);
  assert.deepEqual(index.snapshot(), recent); assert.equal(index.stateHash(), recentHash);
  for (let i = 0; i < 1000; i++) append(index);
  assert.equal(index.rewindWindow().retainedBlocks, 128);
  assert.equal(index.rewindWindow().oldestHeight, index.checkpoint().height - 128n);
  const stable = index.stateHash();
  assert.throws(() => index.rewind(manifest.height, manifest.blockHash), /rebuild required/);
  assert.equal(index.stateHash(), stable);
  assert.deepEqual(index.snapshot().lots, recent.lots);
  assert.deepEqual(index.snapshot().spends, recent.spends);
  assert.deepEqual(index.displaySnapshot().lots, recent.lots);
});

test('confirmation display retains its complete configured depth even beyond the normal rewind window', () => {
  const manifest = {...fixtureManifest(), depth: 200}, index = new PrototypeIndex(manifest);
  const credit = authorize(creditRecord(manifest)); append(index, [observation(credit)]);
  const credited = index.snapshot();
  for (let i = 0; i < 199; i++) append(index);
  assert.deepEqual(index.displaySnapshot(), credited);
  for (let i = 0; i < 200; i++) append(index);
  assert.equal(index.rewindWindow().retainedBlocks, 200);
  assert.equal(index.displaySnapshot().height, index.checkpoint().height - 199n);
  const detached = index.displaySnapshot(); detached.lots.values().next().value.amount = 0n;
  assert.equal(index.snapshot().lots.values().next().value.amount, 1000n);
});

test('asynchronous admission exposes only the previous committed state and discards staged changes on policy failure', async () => {
  const manifest = fixtureManifest(), index = new PrototypeIndex(manifest), credit = authorize(creditRecord(manifest));
  const before = index.snapshot(), expected = index.stateHash(); let sawAccepted = false;
  const block = {height: 1n, hash: label('async-block'), parent: before.blockHash, transactions: [observation(credit)]};
  await assert.rejects(index.applyBlockWithPolicy(block, {
    beforeTransaction: async () => assert.deepEqual(index.snapshot(), before),
    authorizeRecord: async () => true,
    afterTransaction: async event => {
      sawAccepted = event.result.status === 'accepted';
      await Promise.resolve(); assert.deepEqual(index.snapshot(), before);
      assert.equal(index.stateHash(), expected); throw Error('fixture policy offline');
    }
  }), /policy offline/);
  assert.ok(sawAccepted); assert.deepEqual(index.snapshot(), before);
  assert.equal(index.rewindWindow().retainedBlocks, 0);
  assert.equal(index.applyBlock(block)[0].status, 'accepted');
  index.rewind(before.height, before.blockHash); assert.deepEqual(index.snapshot(), before);
});

test('late malformed native observation cannot commit an earlier token allocation from the same block', () => {
  const manifest = fixtureManifest(), index = new PrototypeIndex(manifest), credit = authorize(creditRecord(manifest));
  const before = index.snapshot();
  assert.throws(() => append(index, [observation(credit), observation(credit)]), /Repeated native transaction/);
  assert.deepEqual(index.snapshot(), before); assert.equal(index.rewindWindow().retainedBlocks, 0);
  assert.equal(append(index, [observation(credit)])[0].status, 'accepted');
});
