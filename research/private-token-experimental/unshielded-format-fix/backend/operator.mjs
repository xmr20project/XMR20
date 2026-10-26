// UNSHIELDED-FORMAT COPY (25 Oct 2026) of the release candidate's operator.mjs — credits are PUBLIC (XC1) to the holder's owner key;
// payouts follow PUBLIC burns (XR1) keyed by the burn carrier txid. The earlier candidates keep their files unchanged.
// Additions here: (1) the confirmation depth is per instance (DEFAULT 10; the candidate exercises 20 as a PROVISIONAL risk policy,
// not finality); (2) REORGANISATION DETECTION: a pending payout whose burn changes height or leaves canonical history records an
// incident and PAUSES payouts (distinct from the loss latch `halted`) until an explicit `resume`; after resume every payout is
// re-validated against the burn's CURRENT height. (3) `paidWithoutBurn` remains the preserved loss counterexample (halt, no revoke).
// FIX CANDIDATE (26 Oct 2026, review findings H1 + H2):
//  H1  a paid payout whose burn left canonical history ALWAYS latches `halted` (independent of incident deduplication, which is
//      now by kind + txid); the halt persists in the journal and survives reloads.
//  H2  exposure is RESERVED durably before custody submission ('submitting' counts in the window cap until resolved); unresolved
//      submissions are reconciled against custody receipts before any new admission; admission + reservation are serialized per
//      operator (one gate), so concurrent payout calls cannot both pass the cap; a reservation is released only on DEFINITE
//      failure (custody returned ok:false), never on an uncertain outcome (exception after submit) — that needs receipt recovery
//      or an explicit operator decision (abandonSubmission) after custody confirms no receipt exists.
// Single-operator bridge controller for the rehearsal. Operator-verified, NOT
// trustless: the operator decides credits and payouts. Its journal holds only
// public records (blobs, txids, Solana addresses, amounts); never key material.
// Exactly-once payout = durable 'submitting' mark before the Solana transaction,
// the compiled program's one-receipt-per-nonce rule, and receipt lookup on recovery.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {durableJSON,recoverJSON} from '../../privacy-integration-20261022/journal.mjs';
export const CONFIRMATIONS=10; // LAB SETTING. Not a reviewed mainnet depth; an 18-block mainnet reorg is on record.
export const bindingFor=(destination,request)=>createHash('sha256').update(Buffer.concat([Buffer.from('XMR20-MIGRATION-REHEARSAL-REDEEM-BINDING-v1\n'),new PublicKey(destination).toBuffer(),Buffer.from(request,'hex')])).digest('hex');
const sum=xs=>xs.reduce((n,x)=>n+BigInt(x),0n);
// LAB exposure limits. They bound how much a single reorganization after payout
// can cost this operator's backing; they are not insurance and do not revoke a
// payout. Loss, if it happens, falls on the backing shared by all holders.
export const EXPOSURE={maxSinglePayout:'100000000',maxPaidPerWindow:'200000000',windowBlocks:20};
export class Operator{
 // One operator instance per asset: `asset` is the private pool asset id (hex)
 // and `bridge` the compiled custody for that asset's Solana mint.
 constructor({file,bridge,node,registry,asset,confirmations=CONFIRMATIONS,exposure=EXPOSURE,inject=()=>{}}){assert.match(asset,/^[0-9a-f]{64}$/);Object.assign(this,{file,bridge,node,registry,asset,confirmations,exposure,inject});this.state={version:3,asset,halted:false,paused:false,incidents:[],credits:{},payouts:{},requests:{},exposure,confirmations};this.last=null;}
 static async open(opts){const o=new Operator(opts);if(existsSync(opts.file)){o.state=await recoverJSON(opts.file);assert.equal(o.state.asset,opts.asset,'Journal belongs to another asset');}return o;}
 pool(scan){const s=scan.public.state;return {credits:s.credits.filter(c=>c.asset===this.asset),redemptions:s.redemptions.filter(r=>r.asset===this.asset),minted:s.minted[this.asset]??'0',burned:s.burned[this.asset]??'0'};}
 async persist(){await durableJSON(this.file,this.state);}
 assertLive(){assert.ok(!this.state.halted,'Operator halted after incident: '+JSON.stringify(this.state.incidents.at(-1)));}
 assertPayoutsOpen(){this.assertLive();assert.ok(!this.state.paused,'Operator paused after a reorganisation incident; review the incident and resume explicitly: '+JSON.stringify(this.state.incidents.filter(i=>/reorg|vanish/i.test(i.kind)).at(-1)));}
 // Explicit recovery step after a reorganisation incident. Nothing is paid here; the next payout re-validates the burn's current depth.
 async resume(note='operator reviewed the reorganisation incident'){assert.ok(!this.state.halted,'Cannot resume a halted operator (loss incident)');this.state.paused=false;this.state.incidents.push({kind:'resumed',at:new Date().toISOString(),note});await this.persist();return {paused:false};}
 // Deposit credit: one private note for exactly the Solana receipt's net amount.
 async creditDeposit(receipt,to){this.assertLive();const binding=receipt.nonce;assert.equal(receipt.kind,10);assert.ok(!this.state.credits[binding],'Receipt already credited by this operator');
  const built=await this.node.call({op:'credit',owner:to,amount:receipt.net,kind:1,binding,asset:this.asset});
  this.state.credits[binding]={kind:1,amount:receipt.net,to,txid:built.txid,blob:built.blob,status:'built'};await this.persist();
  return this.publishCredit(binding);}
 // Migration credit: one private note for exactly the snapshot row's amount.
 async creditClaim(envelope,to,owner=to){this.assertLive();const row=this.registry.verify(envelope);assert.equal(envelope.body.owner,to);const binding=row.claim;assert.ok(!this.state.credits[binding],'Claim already credited by this operator');
  const built=await this.node.call({op:'credit',owner,amount:row.amount,kind:2,binding,asset:this.asset});
  this.inject('afterClaimBuild',binding);
  this.state.credits[binding]={kind:2,amount:row.amount,to,txid:built.txid,blob:built.blob,status:'built'};await this.persist();
  this.registry.consume(binding,{amount:row.amount,txid:built.txid});this.inject('afterConsume',binding);
  return this.publishCredit(binding);}
 async publishCredit(binding){const c=this.state.credits[binding];const r=await this.node.call({op:'publishBlob',blob:c.blob});assert.equal(r.txid,c.txid);c.status='published';await this.persist();return c;}
 // Lost acknowledgement: a credit whose publish reply never arrived is retried
 // idempotently; the daemon already has the identical transaction or it is mined.
 async retryCredit(binding,scan){const c=this.state.credits[binding];assert.ok(c,'Unknown credit');if(this.pool(scan).credits.some(x=>x.binding===binding)){c.status='indexed';await this.persist();return {...c,resubmitted:false};}try{await this.node.call({op:'publishBlob',blob:c.blob});}catch(e){if(!/already|duplicate|rejected/i.test(e.message))throw e;}c.status='published';await this.persist();return {...c,resubmitted:true};}
 // Exposure in the window: PAID payouts inside the window PLUS every unresolved submission (reserved, whatever its age).
 exposureInWindow(tip){return Object.values(this.state.payouts).filter(p=>p.status==='submitting'||(p.status==='paid'&&p.paidAtTip!==undefined&&tip-p.paidAtTip<this.exposure.windowBlocks)).reduce((n,p)=>n+BigInt(p.amount),0n);}
 paidInWindow(tip){return this.exposureInWindow(tip);}
 // Deduplicated incident record: one entry per (kind, txid).
 incident(kind,txid,extra){if(this.state.incidents.some(i=>i.kind===kind&&i.txid===txid))return false;this.state.incidents.push({kind,txid,at:new Date().toISOString(),...extra});return true;}
 // Resolve unresolved submissions against custody BEFORE admitting new exposure: a receipt means paid (recovered); no receipt keeps
 // the reservation (uncertain). Nothing here pays.
 async recoverSubmissions(){let changed=false;for(const [txid,p] of Object.entries(this.state.payouts)){if(p.status!=='submitting')continue;const existing=await this.bridge.redemptionReceipt(txid);if(existing){p.status='paid';p.receipt=existing;p.recovered=true;changed=true;}}if(changed)await this.persist();return changed;}
 // Operator decision after custody confirmed that no receipt exists for an uncertain submission: release the reservation so the
 // burn becomes payable again. Refused while a receipt exists.
 async abandonSubmission(txid,note='operator confirmed no custody receipt'){const p=this.state.payouts[txid];assert.ok(p&&p.status==='submitting','Not an unresolved submission');assert.ok(!(await this.bridge.redemptionReceipt(txid)),'Custody holds a receipt: recover it instead');p.status='pending';p.abandonedSubmissions=(p.abandonedSubmissions||0)+1;this.incident('submissionAbandoned',txid,{amount:p.amount,note});await this.persist();return p;}
 registerRedemption(binding,destination,request){assert.equal(bindingFor(destination,request),binding,'Redemption binding does not match destination/request');this.state.requests[binding]={destination,request};}
 // Reconcile the journal against a fresh public scan. Never deletes history.
 async reconcile(scan){await this.recoverSubmissions();const pool=this.pool(scan),tip=scan.public.tip;this.last=scan;
  // Recovery of an interrupted claim: a credit journaled as built means the
  // registry row was consumed at build time; re-consume after a restart.
  for(const [binding,c]of Object.entries(this.state.credits))if(c.kind===2&&!this.registry.consumedIds().includes(binding))this.registry.consume(binding,{amount:c.amount,txid:c.txid,recovered:true});
  const credits=new Map(pool.credits.map(c=>[c.binding,c]));
  for(const [binding,c]of Object.entries(this.state.credits)){const seen=credits.get(binding);if(seen){c.height=seen.height;c.confirmations=tip-seen.height+1;c.status=c.confirmations>=this.confirmations?'confirmed':'indexed';}else if(c.status!=='built')c.status='orphaned';}
  const redemptions=new Map(pool.redemptions.map(r=>[r.txid,r]));
  for(const r of redemptions.values()){const p=this.state.payouts[r.txid]??(this.state.payouts[r.txid]={amount:r.amount,binding:r.binding,status:'pending'});
   if(p.height!==undefined&&p.height!==r.height&&p.status!=='paid'){this.state.incidents.push({kind:'burnReorganised',txid:r.txid,previousHeight:p.height,newHeight:r.height,tip,note:'The burn moved to another height (reorganisation). Payout confirmations restart from the new height; payouts paused until resume.'});this.state.paused=true;}
   p.height=r.height;p.confirmations=tip-r.height+1;if(p.status==='orphaned'||p.status==='conflicted')p.status='pending';}
  for(const [txid,p]of Object.entries(this.state.payouts)){if(redemptions.has(txid))continue;p.confirmations=0;
   if(p.status==='paid'){this.state.halted=true;this.incident('paidWithoutBurn',txid,{amount:p.amount,tip,note:'Solana payout is final; the Monero burn left canonical history. Cannot be revoked. Operator HALTED (latched independently of earlier incidents).'});}
   else if(p.status!=='submitting'){if(p.height!==undefined&&p.status==='pending'){this.state.incidents.push({kind:'burnVanished',txid,previousHeight:p.height,tip,note:'A burn with recorded confirmations left canonical history before payout (reorganisation). Nothing was paid; payouts paused until resume.'});this.state.paused=true;}p.status=this.state.payouts[txid].conflict?'conflicted':'orphaned';}}
  await this.persist();
  return {eligible:Object.entries(this.state.payouts).filter(([,p])=>p.status==='pending'&&p.confirmations>=this.confirmations).map(([t])=>t),halted:this.state.halted,paused:this.state.paused,incidents:this.state.incidents.length};}
 markConflict(txid){const p=this.state.payouts[txid];if(p){p.conflict=true;if(p.status==='orphaned')p.status='conflicted';}}
 // Admission, reservation and submission run under ONE gate per operator: two concurrent calls are processed one after the other,
 // each seeing the other's durable reservation.
 payout(txid){const run=()=>this.#payout(txid);const p=(this.gate??=Promise.resolve()).then(run,run);this.gate=p.catch(()=>{});return p;}
 async #payout(txid){this.assertLive();const p=this.state.payouts[txid];assert.ok(p,'Unknown redemption');
  if(p.status==='paid')return {repeated:true,...p};
  this.assertPayoutsOpen();
  assert.ok(['pending','submitting'].includes(p.status),'Redemption not payable: '+p.status);
  // Unresolved submissions (this one or others) are resolved against custody first; an unresolved one keeps its reservation.
  await this.recoverSubmissions();if(p.status==='paid')return {recovered:true,...p};
  if(p.status==='submitting')throw Error('Unresolved submission: custody holds no receipt yet; the reservation stays until a receipt appears or the operator abandons the submission after confirming with custody');
  assert.ok(p.confirmations>=this.confirmations,`Only ${p.confirmations} confirmations`);
  const req=this.state.requests[p.binding];assert.ok(req,'No destination registered for this redemption binding');assert.equal(bindingFor(req.destination,req.request),p.binding);
  const tip=this.last?.public?.tip??0;assert.ok(BigInt(p.amount)<=BigInt(this.exposure.maxSinglePayout),'Exposure: single payout above lab limit');
  assert.ok(this.exposureInWindow(tip)+BigInt(p.amount)<=BigInt(this.exposure.maxPaidPerWindow),'Exposure: window payout limit reached (paid + unresolved submissions); wait for more blocks or resolve submissions');
  // DURABLE RESERVATION before custody is touched: from here the amount counts against the window until resolved.
  p.status='submitting';p.destination=req.destination;p.paidAtTip=tip;p.submittedAt=new Date().toISOString();await this.persist();this.inject('beforeSubmit',txid);
  let r;try{r=await this.bridge.redeem(req.destination,BigInt(p.amount),txid);}
  catch(e){// UNCERTAIN: custody may or may not have executed. The reservation stays; recovery resolves it.
   p.lastError='custody call failed: '+e.message;await this.persist();throw Error('Submission outcome uncertain ('+e.message+'); reservation kept until custody receipt recovery or an explicit operator decision');}
  if(!r.ok){// DEFINITE failure reported by custody (no receipt was created): release the reservation.
   p.status='pending';p.lastError=(r.logs||[]).join('\n')||'custody refused';await this.persist();throw Error('Custody refused the payout: '+p.lastError);}
  this.inject('afterSubmit',txid);
  p.status='paid';p.receipt=r.receipt;await this.persist();return p;}
 // Backing/liability buckets. Every unit of operator reserve must be owed to
 // exactly one bucket. Deposit receipts are read from the compiled program.
 liabilities(scan){const pool=this.pool(scan);const credited=new Set(pool.credits.map(c=>c.binding));
  const awaitingDeposits=sum(this.bridge.receipts.filter(r=>r.kind===10&&!credited.has(r.nonce)).map(r=>r.net));
  const claimedIds=new Set(this.registry.consumedIds());const awaitingClaims=sum(Object.entries(this.state.credits).filter(([b,c])=>c.kind===2&&claimedIds.has(b)&&!credited.has(b)).map(([,c])=>c.amount));
  const paid=new Set(Object.entries(this.state.payouts).filter(([,p])=>p.status==='paid').map(([t])=>t));
  const pendingPayout=sum(pool.redemptions.filter(r=>!paid.has(r.txid)).map(r=>r.amount));
  const unclaimed=this.registry.unclaimed(),outstanding=BigInt(pool.minted)-BigInt(pool.burned);
  const reserve=BigInt(this.bridge.state().reserve),owed=unclaimed+awaitingDeposits+awaitingClaims+outstanding+pendingPayout;
  return {asset:this.asset,reserve:reserve.toString(),owed:owed.toString(),ok:reserve===owed,shortfall:(owed-reserve).toString(),lossBearer:'operator backing shared by all holders (no per-holder insurance)',buckets:{unclaimedLegacyRights:unclaimed.toString(),depositsAwaitingCredit:awaitingDeposits.toString(),claimsAwaitingCredit:awaitingClaims.toString(),outstandingPrivateNotes:outstanding.toString(),confirmedBurnsAwaitingPayout:pendingPayout.toString()},minted:pool.minted,burned:pool.burned,incidents:this.state.incidents.length,halted:this.state.halted};}
}
