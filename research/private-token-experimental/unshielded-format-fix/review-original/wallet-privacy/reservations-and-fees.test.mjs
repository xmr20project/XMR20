// Narrow review reproductions using unchanged candidate exports. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reservedTokens,reservedNative} from '../../wallet-extension/src/token-format.js';
import {xmr} from '../../wallet-extension/src/holder-carrier.js';

test('refusing the second carrier releases token notes although the operation is resumable',()=>{
 const operation={kind:'private',inputKind:'shielded',status:'partial',reserved:['shielded-note'],wires:['part-A','part-B'],recordIds:['A','B'],nativeInputs:['KI-A','KI-B'],carriers:[{status:'published',keyImage:'KI-A'},{status:'signed',keyImage:'KI-B'}]};
 const account={pending:{operation}};
 assert.equal(reservedTokens(account).has('shielded-note'),true);
 // State written by applyPublishOutcome for a refusal on part B (token-format.js:98-99).
 operation.carriers[1].status='refused';operation.status='refused';
 assert.equal(reservedTokens(account).has('shielded-note'),false);
 assert.equal(reservedNative(account).has('KI-A'),true);
 assert.equal(reservedNative(account).has('KI-B'),true);
 // A conflict in part B has exactly the same token-reservation loss.
 operation.carriers[1].status='conflicted';operation.status='conflicted';
 assert.equal(reservedTokens(account).has('shielded-note'),false);
 console.log(JSON.stringify({carrierA:'published',carrierB:'refused-or-conflicted',operationStillPending:true,tokenReservation:false,nativeReservations:[...reservedNative(account)]}));
});

test('fee approval formatter understates non-micro-XMR-aligned quotes',()=>{
 const fee=49_520_000n; // Synthetic quote with ordinary piconero precision.
 const shown=xmr(fee);
 const shownPiconero=BigInt(shown.replace('.',''))*1_000_000n;
 assert.equal(shown,'0.000049');
 assert.equal(shownPiconero<fee,true);
 assert.equal(fee-shownPiconero,520_000n);
 console.log(JSON.stringify({feePiconero:String(fee),approvalText:shown+' XMR',understatementPiconero:String(fee-shownPiconero)}));
});
