import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifiedCarrierExtra} from '../src/native-carrier-transaction.js';
const fixtures=JSON.parse(readFileSync(new URL('../services/native-market/xn1/fixtures/historical-public-transactions.json',import.meta.url))).fixtures;
test('ordinary-send protection authenticates older full and pruned transaction extras',()=>{
 for(const f of fixtures)for(const row of f.rows){
  assert.equal(Buffer.from(verifiedCarrierExtra(row,f.txid)).toString('hex'),f.expectedExtra);
  assert.throws(()=>verifiedCarrierExtra(row,'00'.repeat(32)),/identity/);
 }
});
test('unknown, altered or absent historical proofs cannot classify funding as ordinary',()=>{
 const f=fixtures.find(f=>f.rows.some(r=>!r.as_hex&&!r.prunable_as_hex)),pruned=f.rows.find(r=>!r.as_hex&&!r.prunable_as_hex);
 for(const altered of [
  {...pruned,prunable_hash:'ff'.repeat(32)},
  {...pruned,prunable_hash:undefined},
  {...pruned,pruned_as_hex:pruned.pruned_as_hex.slice(0,80)},
  {tx_hash:f.txid,as_json:JSON.stringify({extra:[]})},
 ])assert.throws(()=>verifiedCarrierExtra(altered,f.txid));
});
