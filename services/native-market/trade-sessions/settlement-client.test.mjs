import test from 'node:test';
import assert from 'node:assert/strict';
import {ed25519} from '@noble/curves/ed25519';
import {settlementMessage} from '../settlement/protocol.mjs';
import {digest} from './protocol.mjs';
import {openTradeSettlement,validateSettlementResponse} from './settlement-client.mjs';
const seed=Buffer.alloc(32,91); // Public synthetic mailbox key, never a wallet.
function fixture(action='broadcast'){
 const unsigned={version:1,sessionId:'11'.repeat(32),role:'buyer',key:Buffer.from(ed25519.getPublicKey(seed)).toString('hex'),revision:10,requestId:'public-transport-fixture',action,txid:'22'.repeat(32),signatureHash:'33'.repeat(32)};
 const request={...unsigned,signature:Buffer.from(ed25519.sign(settlementMessage(unsigned),seed)).toString('hex')};
 const response={sessionId:request.sessionId,txid:request.txid,signatureHash:request.signatureHash,requestId:request.requestId,requestDigest:digest(request),status:'accepted',confirmed:false,mature:false,tokenAllocated:false,confirmations:'0',requiredMaturityBlocks:'10',submissionAttempted:true};
 return {request,response};
}
test('settlement client requires typed mailbox, CSRF and current account dependencies',async()=>{
 await assert.rejects(openTradeSettlement(),/Typed mailbox/);
});
test('native acceptance and a confirmed token allocation have distinct exact response states',()=>{
 const {request,response}=fixture();assert.equal(validateSettlementResponse(response,request).confirmed,false);
 assert.equal(validateSettlementResponse({...response,status:'confirmed',confirmed:true,tokenAllocated:true,confirmations:'1'},request).mature,false);
 assert.equal(validateSettlementResponse({...response,status:'mature',confirmed:true,mature:true,tokenAllocated:true,confirmations:'10'},request).mature,true);
 for(const patch of [{status:'accepted',confirmed:true,tokenAllocated:true,confirmations:'1'},{status:'confirmed',confirmed:true,tokenAllocated:false,confirmations:'1'},{status:'mature',confirmed:true,mature:true,tokenAllocated:true,confirmations:'9'},{confirmations:'01'},{status:'complete'},{url:'https://untrusted.invalid'}])assert.throws(()=>validateSettlementResponse({...response,...patch},request));
});
test('settlement acknowledgments bind exact signed authorization and transaction',()=>{
 const {request,response}=fixture();
 for(const field of ['sessionId','txid','signatureHash','requestId','requestDigest'])assert.throws(()=>validateSettlementResponse({...response,[field]:'44'.repeat(32)},request),/exact transaction/);
 const receipt={requestId:request.requestId,requestDigest:digest(request),attempts:1,outcome:'accepted'};
 assert.equal(validateSettlementResponse({...response,receipt},request).receipt.attempts,1);
 for(const patch of [{requestId:'another'},{requestDigest:'55'.repeat(32)},{attempts:0},{outcome:'confirmed'}])assert.throws(()=>validateSettlementResponse({...response,receipt:{...receipt,...patch}},request),/receipt changed/);
});
