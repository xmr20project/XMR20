import test from 'node:test';
import assert from 'node:assert/strict';
import {compareReports,digest,verificationReport} from '../src/verification.mjs';
function report(){return verificationReport({policy:{operatorAddress:'synthetic'},scanStartHeight:1,checkpoint:{height:100,hash:'a'.repeat(64)}},{tokens:new Map(),credits:new Set(),transfers:new Map(),burns:new Map()},[]);}
test('identical report data compares deterministically',()=>{assert.equal(compareReports(report(),report()).status,'MATCH');});
test('different chain checkpoints never look like balance disagreement',()=>{const a=report(),b=report();b.moneroCheckpoint.height++;assert.equal(compareReports(a,b).status,'NOT_COMPARABLE');});
test('different policy is not comparable',()=>{const a=report(),b=report();b.policySha256='f'.repeat(64);assert.equal(compareReports(a,b).status,'NOT_COMPARABLE');});
test('tampered report content is rejected',()=>{const a=report(),b=report();b.ledger.credits.push('b'.repeat(64));assert.equal(compareReports(a,b).status,'INVALID_REPORT');});
test('same checkpoint with different computed state is a mismatch',()=>{const a=report(),b=report();b.ledger.credits.push('b'.repeat(64));b.ledgerSha256=digest(b.ledger);assert.deepEqual(compareReports(a,b),{status:'MISMATCH',component:'monero-ledger'});});
test('backing requires matching Solana checkpoints',()=>{const a=report(),b=report();b.backing=[{deployment:'b'.repeat(64),solanaSlot:3}];b.backingSha256=digest(b.backing);b.solanaCheckpoints=[{deployment:'b'.repeat(64),slot:3}];assert.equal(compareReports(a,b).status,'LEDGER_MATCH_BACKING_NOT_COMPARABLE');});
test('reported checkpoints must agree with hashed backing evidence',()=>{const a=report(),b=report();b.solanaCheckpoints=[{deployment:'b'.repeat(64),slot:3}];assert.equal(compareReports(a,b).status,'INVALID_REPORT');});
