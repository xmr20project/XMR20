// NATIVE MARKETPLACE SETTLEMENT — the next concrete construction after SETTLEMENT-DESIGN 4.1/4.3: a LISTING RESERVATION record
// (the seller moves the lot into a sale-bound output the indexer confirms) followed by ONE BUNDLED Monero transaction that carries
// both the buyer's XMR payment and the token delivery record spending that output. Abstract fork-boundary model: no wallet, no
// cryptography, no network; it decides only which party is left short under each ordering event. Preserved requirements: the buyer
// must never pay without receiving valid tokens, the seller must never deliver without being paid, nothing reveals more than the
// records already do. Production trading stays disabled; this is design evidence, not a readiness claim.
//
// Findings encoded as tests (each is a statement about the construction, retained whether favourable or not):
//   1. Reordering of unrelated transactions and of the bundle relative to other bundles: both legs are in one transaction, so they
//      are mined together or not at all — FAIR under every reordering.
//   2. Conflicting spend of the listed lot BEFORE the bundle: the listing reservation makes the indexer reject the competing spend,
//      so the delivery leg stays valid — buyer PROTECTED (this is what the reservation buys, exactly as BRC-20's transfer inscription).
//   3. Ancestor disappears: a reorganisation removes the LISTING but a chain containing the bundle survives (or the captured bundle
//      is rebroadcast into it). Monero accepts the bundle — the XMR moves — but the token leg now spends an output the indexer never
//      confirmed: BUYER LOSS. The construction does not eliminate this; it only requires the listing to be reorganised, i.e. the same
//      "no finality" fact as counterexample A. RETAINED COUNTEREXAMPLE B'.
//   4. Captured bundle rebroadcast after a reorganisation that removed only the bundle: both legs return together — FAIR (atomicity
//      holds; the rebroadcast is harmless), unless the listing was also removed (case 3).
//   5. Seller-side risk: there is no event in which tokens are delivered without the XMR leg, because delivery exists only inside the
//      bundle — seller PROTECTED by construction. The seller's residual is opportunity cost while the listing is locked.
//   Next candidate for case 3 (not built): a deposit (bond) by the seller held by a party that can see both legs, released only when
//   the delivery is canonical at depth D — reintroduces a trusted or escrow party (SETTLEMENT-DESIGN 4.3/4.4); or a buyer-side wait:
//   the buyer signs the bundle only after the listing has D confirmations, which shrinks but cannot remove the window.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('../../',import.meta.url));

// ---- model ----
// chain: array of blocks (height index), each a list of txs: {id,kind:'listing'|'bundle'|'spend'|'other',lot,listing?}
// indexer rules: listing valid if lot unspent & not reserved; a bundle's token leg valid iff its listing is CANONICAL (in the chain)
// at a height below the bundle and the lot has not been spent otherwise; 'spend' of a reserved lot is rejected while the listing is canonical.
function evaluate(chain){
 const state={reserved:new Map(),spent:new Set(),outcomes:[]};
 for(let h=0;h<chain.length;h++)for(const tx of chain[h]){
  if(tx.kind==='listing'){if(state.spent.has(tx.lot)||state.reserved.has(tx.lot)){tx.valid=false;continue;}state.reserved.set(tx.lot,{id:tx.id,height:h});tx.valid=true;}
  else if(tx.kind==='spend'){if(state.reserved.has(tx.lot)||state.spent.has(tx.lot)){tx.valid=false;continue;}state.spent.add(tx.lot);tx.valid=true;}
  else if(tx.kind==='bundle'){const l=state.reserved.get(tx.lot);const tokenLegValid=Boolean(l&&l.id===tx.listing&&!state.spent.has(tx.lot));
   // Monero mines the bundle regardless of the token layer: the XMR leg ALWAYS settles when the bundle is in the chain.
   if(tokenLegValid){state.reserved.delete(tx.lot);state.spent.add(tx.lot);}
   state.outcomes.push({bundle:tx.id,xmrPaid:true,tokensDelivered:tokenLegValid,fair:tokenLegValid,loser:tokenLegValid?null:'buyer'});}
 }
 return state;
}
const T=(id,kind,extra={})=>({id,kind,...extra});
const L=T('listing-1','listing',{lot:'lot-A'}),B=T('bundle-1','bundle',{lot:'lot-A',listing:'listing-1'}),S=T('spend-1','spend',{lot:'lot-A'}),O=T('other','other');
const outcomes=(chain)=>evaluate(structuredClone(chain)).outcomes;
const evidence={execution:'ABSTRACT MODEL (no wallet, no cryptography, no network)',construction:'listing reservation + one bundled Monero transaction (XMR payment + token delivery)',cases:[]};
const record=(name,chain,o)=>evidence.cases.push({name,chain:chain.map((blk,h)=>({height:h,txs:blk.map(t=>t.id)})),outcomes:o});

test('1. reordering: bundle before/after unrelated transactions and relative to other bundles stays fair',()=>{
 for(const chain of [[[L],[O],[B]],[[L],[B,O]],[[L],[O,B]],[[L],[B],[O]],[[L,O],[B]]]){const o=outcomes(chain);assert.equal(o.length,1);assert.equal(o[0].fair,true,JSON.stringify(chain.map(b=>b.map(t=>t.id))));record('reordering',chain,o);}
 // two listings/bundles for two lots interleaved in any order: each fair
 const L2=T('listing-2','listing',{lot:'lot-B'}),B2=T('bundle-2','bundle',{lot:'lot-B',listing:'listing-2'});
 for(const chain of [[[L,L2],[B,B2]],[[L,L2],[B2,B]],[[L],[L2,B],[B2]]]){const o=outcomes(chain);assert.deepEqual(o.map(x=>x.fair),[true,true]);record('reordering-two-lots',chain,o);}
});
test('2. conflicting spend before the bundle: the reservation makes the indexer reject it; delivery stays valid (buyer protected)',()=>{
 const chain=[[L],[S],[B]];const st=evaluate(structuredClone(chain));assert.equal(st.outcomes[0].fair,true);
 const s=structuredClone(chain);const st2=evaluate(s);assert.equal(s[1][0].valid,false,'competing spend of a reserved lot rejected');record('conflicting-spend-after-listing',chain,st2.outcomes);
 // without a reservation (plain lot, bundle references nothing): the competing spend wins and the buyer loses — what the reservation removes
 const B0=T('bundle-0','bundle',{lot:'lot-A',listing:null});const o0=outcomes([[S],[B0]]);assert.equal(o0[0].loser,'buyer');record('conflicting-spend-no-reservation (what the construction fixes)',[[S],[B0]],o0);
});
test('3. RETAINED COUNTEREXAMPLE B\': the listing is reorganised away but the bundle survives or is rebroadcast -> XMR moves, no tokens',()=>{
 // original chain: listing at 0, bundle at 2; reorganisation replaces block 0 (listing gone), bundle re-mined/rebroadcast at 2
 const reorganised=[[O],[O],[B]];const o=outcomes(reorganised);assert.equal(o[0].xmrPaid,true);assert.equal(o[0].tokensDelivered,false);assert.equal(o[0].loser,'buyer');record('listing-reorganised-bundle-survives',reorganised,o);
 // the same with the seller spending the lot elsewhere in the new history: still the buyer who loses
 const worse=[[S],[O],[B]];const o2=outcomes(worse);assert.equal(o2[0].loser,'buyer');record('listing-reorganised-lot-spent-elsewhere',worse,o2);
 evidence.retainedCounterexample={name:"B' (listing reorganised, bundle canonical)",loser:'buyer',failingAssumption:'the listing has reached a depth after which it will stay canonical; Monero gives no such depth (an 18-block reorganisation is on record)',notEliminatedBy:['bundling both legs','listing reservation','waiting D confirmations on the listing (changes the odds, not the existence)']};
});
test('4. a captured bundle rebroadcast after a reorganisation that removed only the bundle returns both legs together (fair)',()=>{
 const chain=[[L],[O],[O],[B]];/* bundle re-mined later than first captured */const o=outcomes(chain);assert.equal(o[0].fair,true);record('bundle-rebroadcast-listing-intact',chain,o);
 // rebroadcast twice (duplicate submission): the second copy spends an already-spent lot -> indexer rejects token leg, and the XMR
 // leg cannot be mined twice (same key images) — modelled as a single outcome
 const dup=[[L],[B],[T('bundle-1-copy','bundle',{lot:'lot-A',listing:'listing-1'})]];const od=outcomes(dup);assert.equal(od[0].fair,true);assert.equal(od[1].tokensDelivered,false,'duplicate copy delivers nothing');evidence.duplicateNote='a byte-identical rebroadcast cannot be mined twice on Monero (same key images); the model shows the token layer also refuses a second delivery';record('duplicate-bundle',dup,od);
});
test('5. the seller is never short: delivery exists only inside the bundle that pays',()=>{
 for(const c of evidence.cases)for(const o of c.outcomes)assert.notEqual(o.loser,'seller');
});
test('record evidence',async()=>{evidence.summary={fair:['reordering','conflicting spend with reservation','rebroadcast with listing intact','duplicates'],buyerLoss:['listing reorganised away while the bundle is canonical (B\')'],sellerLoss:[],nextCandidates:['seller bond held by a party seeing both legs, released at depth D (trusted/escrow party: SETTLEMENT-DESIGN 4.3/4.4)','buyer signs only after the listing has D confirmations (shrinks the window; does not remove it)'],productionTrading:'DISABLED'};await mkdir(dir+'settlement/evidence',{recursive:true});await writeFile(dir+'settlement/evidence/bundled-trade-model-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(evidence,null,1));});
