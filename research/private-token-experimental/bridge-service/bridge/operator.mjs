// OPERATOR CORE for the unshielded format (service version of the lab operator of research/token-format-unshielded-20261025).
// Single-operator bridge controller: operator-verified, NOT trustless. The journal holds public records only (txids, blobs,
// Solana addresses, amounts); key material lives in the issuer role process (params/<set>/issuer.secret.json) and the custody
// adapter (operator keypair file). Exactly-once credits = one journal entry per receipt nonce / claim id, 'built' persisted
// BEFORE publication, idempotent re-publication of the SAME carrier on recovery. Exactly-once payouts = durable 'submitting'
// mark before the Solana transaction, the program's one-receipt-per-nonce rule, receipt lookup on recovery. Reorganisation
// detection pauses payouts until an explicit resume; a payout whose burn vanished after the Solana transaction HALTS the
// operator (the preserved loss counterexample; nothing is revoked). Exposure limits bound a single payout and a block window.
// Changes vs the lab: reads the INDEXER SERVICE summary (persistent follower) instead of a replay-everything scan; deposits are
// discovered from finalized custody receipts bound to an owner key (bindingFor) so a holder needs no prior registration;
// an optional second node (observer) must agree before a payout; everything the operator decides is appended to an audit log.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import {PublicKey} from '@solana/web3.js';
import {durableJSON,recoverJSON} from '../../privacy-integration-20261022/journal.mjs';
export const DEFAULT_CONFIRMATIONS=10;// provisional risk policy (10 lab default; 20 exercised in the release candidate); NOT finality
export const DEFAULT_EXPOSURE={maxSinglePayout:'100000000',maxPaidPerWindow:'200000000',windowBlocks:20};
const sum=xs=>xs.reduce((n,x)=>n+BigInt(x),0n);
export const redeemBindingFor=(destination,request)=>createHash('sha256').update(Buffer.concat([Buffer.from('XMR20-UNSHIELDED-REDEEM-BINDING-v1\n'),new PublicKey(destination).toBuffer(),Buffer.from(request,'hex')])).digest('hex');
// Deposit binding: ties a Solana deposit receipt to the OWNER KEY that must receive the public credit. Anyone can compute it from
// the owner key and the nonce; the operator credits a finalized receipt only when its binding matches a known owner key.
export const depositBindingFor=(ownerKeyHex,nonceHex)=>createHash('sha256').update(Buffer.concat([Buffer.from('XMR20-UNSHIELDED-DEPOSIT-BINDING-v1\0'),Buffer.from(ownerKeyHex,'hex'),Buffer.from(nonceHex,'hex')])).digest('hex');
export class Operator{
 // asset: pool asset id (hex); custody: adapter (litesvm|rpc); issuer: roles issuer client (call({op})); indexer: client; registry: migration registry|null
 constructor({file,auditFile,custody,issuer,indexer,registry=null,asset,confirmations=DEFAULT_CONFIRMATIONS,exposure=DEFAULT_EXPOSURE,observers=[],requireObservers=false,inject=()=>{}}){
  assert.match(asset,/^[0-9a-f]{64}$/);Object.assign(this,{file,auditFile,custody,issuer,indexer,registry,asset,confirmations,exposure,observers,requireObservers,inject});
  this.state={version:4,asset,halted:false,paused:false,incidents:[],credits:{},payouts:{},requests:{},owners:{},exposure,confirmations};this.last=null;}
 static async open(opts){const o=new Operator(opts);if(existsSync(opts.file)){o.state=await recoverJSON(opts.file);assert.equal(o.state.asset,opts.asset,'Journal belongs to another asset');o.state.owners??={};}await o.audit({event:'open',credits:Object.keys(o.state.credits).length,payouts:Object.keys(o.state.payouts).length,halted:o.state.halted,paused:o.state.paused});return o;}
 async audit(line){if(this.auditFile)await appendFile(this.auditFile,JSON.stringify({at:new Date().toISOString(),asset:this.asset.slice(0,12),...line})+'\n').catch(()=>{});}
 async persist(){await durableJSON(this.file,this.state);}
 pool(summary){const s=summary.state;return {tip:summary.tip,credits:(s.credits||[]).filter(c=>c.asset===this.asset),redemptions:(s.redemptions||[]).filter(r=>r.asset===this.asset),minted:s.minted?.[this.asset]??'0',burned:s.burned?.[this.asset]??'0',publicSupply:s.publicSupply?.[this.asset]??'0',shieldedSupply:s.shieldedSupply?.[this.asset]??'0'};}
 assertLive(){assert.ok(!this.state.halted,'Operator halted after incident: '+JSON.stringify(this.state.incidents.at(-1)));}
 assertPayoutsOpen(){this.assertLive();assert.ok(!this.state.paused,'Operator paused after a reorganisation incident; review the incident and resume explicitly: '+JSON.stringify(this.state.incidents.filter(i=>/reorg|vanish/i.test(i.kind)).at(-1)));}
 async pause(note='operator pause'){this.state.paused=true;this.state.incidents.push({kind:'paused',at:new Date().toISOString(),note});await this.persist();await this.audit({event:'pause',note});return {paused:true};}
 async resume(note='operator reviewed the reorganisation incident'){assert.ok(!this.state.halted,'Cannot resume a halted operator (loss incident)');this.state.paused=false;this.state.incidents.push({kind:'resumed',at:new Date().toISOString(),note});await this.persist();await this.audit({event:'resume',note});return {paused:false};}
 // Owner registration: a Solana account's deposits are credited to this owner key. Public data; the holder proves nothing here
 // because the deposit binding (receipt field) already commits to the owner key; registration only lets the service precompute it.
 async registerOwner({ownerKey,solana,tokenAddress}){assert.match(ownerKey,/^[0-9a-f]{64}$/);new PublicKey(solana);this.state.owners[ownerKey]={solana,tokenAddress,at:new Date().toISOString()};await this.persist();}
 ownerForBinding(binding,nonce){for(const o of Object.keys(this.state.owners))if(depositBindingFor(o,nonce)===binding)return o;return null;}
 // Deposit credit: one PUBLIC note for exactly the receipt's net amount, to the owner key the receipt's binding commits to.
 async creditDeposit(receipt){this.assertLive();assert.equal(receipt.kind,10);const binding=receipt.nonce;assert.ok(!this.state.credits[binding],'Receipt already credited by this operator');
  const owner=this.ownerForBinding(receipt.binding,receipt.nonce);assert.ok(owner,'Deposit receipt is not bound to a known owner key (holder must register the owner key that produced the binding)');
  const built=await this.issuer.call({op:'credit',owner,amount:String(receipt.net),kind:1,binding,asset:this.asset});
  this.state.credits[binding]={kind:1,amount:String(receipt.net),owner,txid:built.txid,blob:built.blob,fee:built.fee,status:'built',at:new Date().toISOString()};await this.persist();await this.audit({event:'credit-built',kind:1,binding,owner,amount:String(receipt.net),txid:built.txid,fee:built.fee});
  return this.publishCredit(binding);}
 // Migration credit: one PUBLIC note for exactly the snapshot row's amount (registry verifies the legacy signature).
 async creditClaim(envelope,tokenAddress,owner){this.assertLive();assert.ok(this.registry,'No migration registry configured');const row=this.registry.verify(envelope);assert.equal(envelope.body.owner,tokenAddress);const binding=row.claim;assert.ok(!this.state.credits[binding],'Claim already credited by this operator');
  const built=await this.issuer.call({op:'credit',owner,amount:row.amount,kind:2,binding,asset:this.asset});this.inject('afterClaimBuild',binding);
  this.state.credits[binding]={kind:2,amount:row.amount,owner,tokenAddress,txid:built.txid,blob:built.blob,fee:built.fee,status:'built',at:new Date().toISOString()};await this.persist();this.registry.consume(binding,{amount:row.amount,txid:built.txid});this.inject('afterConsume',binding);
  await this.audit({event:'credit-built',kind:2,binding,owner,amount:row.amount,txid:built.txid});return this.publishCredit(binding);}
 async publishCredit(binding){const c=this.state.credits[binding];const r=await this.issuer.call({op:'publishBlob',blob:c.blob});assert.equal(r.txid,c.txid);c.status='published';c.publishedAt=new Date().toISOString();await this.persist();await this.audit({event:'credit-published',binding,txid:c.txid});return c;}
 // Recovery: a credit journaled as built/published but not indexed is re-published (identical carrier; idempotent on the daemon).
 async retryCredit(binding,summary){const c=this.state.credits[binding];assert.ok(c,'Unknown credit');if(this.pool(summary).credits.some(x=>x.binding===binding)){c.status='indexed';await this.persist();return {...c,resubmitted:false};}
  try{await this.issuer.call({op:'publishBlob',blob:c.blob});}catch(e){if(!/already|duplicate|rejected/i.test(e.message))throw e;}c.status='published';c.retries=(c.retries||0)+1;await this.persist();await this.audit({event:'credit-republished',binding,txid:c.txid,retries:c.retries});return {...c,resubmitted:true};}
 paidInWindow(tip){return Object.values(this.state.payouts).filter(p=>p.status==='paid'&&p.paidAtTip!==undefined&&tip-p.paidAtTip<this.exposure.windowBlocks).reduce((n,p)=>n+BigInt(p.amount),0n);}
 async registerRedemption(binding,destination,request){assert.equal(redeemBindingFor(destination,request),binding,'Redemption binding does not match destination/request');this.state.requests[binding]={destination,request,at:new Date().toISOString()};await this.persist();}
 // Reconcile the journal against the indexer summary. Never deletes history.
 async reconcile(summary){const pool=this.pool(summary),tip=pool.tip;this.last=summary;
  if(this.registry)for(const [binding,c]of Object.entries(this.state.credits))if(c.kind===2&&!this.registry.consumedIds().includes(binding))this.registry.consume(binding,{amount:c.amount,txid:c.txid,recovered:true});
  const credits=new Map(pool.credits.map(c=>[c.binding,c]));
  for(const [binding,c]of Object.entries(this.state.credits)){const seen=credits.get(binding);if(seen){c.height=seen.height;c.confirmations=tip-seen.height+1;c.status=c.confirmations>=this.confirmations?'confirmed':'indexed';}else if(c.status!=='built'&&c.status!=='published')c.status='orphaned';}
  const redemptions=new Map(pool.redemptions.map(r=>[r.txid,r]));
  for(const r of redemptions.values()){const p=this.state.payouts[r.txid]??(this.state.payouts[r.txid]={amount:r.amount,binding:r.binding,owner:r.owner,status:'pending',seenAt:new Date().toISOString()});
   if(p.height!==undefined&&p.height!==r.height&&p.status!=='paid'){this.state.incidents.push({kind:'burnReorganised',txid:r.txid,previousHeight:p.height,newHeight:r.height,tip,at:new Date().toISOString(),note:'The burn moved to another height (reorganisation). Payout confirmations restart from the new height; payouts paused until resume.'});this.state.paused=true;await this.audit({event:'incident',kind:'burnReorganised',txid:r.txid});}
   p.height=r.height;p.confirmations=tip-r.height+1;if(p.status==='orphaned'||p.status==='conflicted')p.status='pending';}
  for(const [txid,p]of Object.entries(this.state.payouts)){if(redemptions.has(txid))continue;p.confirmations=0;
   if(p.status==='paid'){if(!this.state.incidents.some(i=>i.txid===txid&&i.kind==='paidWithoutBurn')){this.state.incidents.push({kind:'paidWithoutBurn',txid,amount:p.amount,tip,at:new Date().toISOString(),note:'Solana payout is final; the Monero burn left canonical history. Cannot be revoked. Operator HALTED.'});this.state.halted=true;await this.audit({event:'incident',kind:'paidWithoutBurn',txid,amount:p.amount});}}
   else if(p.status!=='submitting'){if(p.height!==undefined&&p.status==='pending'){this.state.incidents.push({kind:'burnVanished',txid,previousHeight:p.height,tip,at:new Date().toISOString(),note:'A burn with recorded confirmations left canonical history before payout (reorganisation). Nothing was paid; payouts paused until resume.'});this.state.paused=true;await this.audit({event:'incident',kind:'burnVanished',txid});}p.status='orphaned';}}
  await this.persist();
  return {tip,eligible:Object.entries(this.state.payouts).filter(([,p])=>p.status==='pending'&&p.confirmations>=this.confirmations&&this.state.requests[p.binding]).map(([t])=>t),awaitingRequest:Object.entries(this.state.payouts).filter(([,p])=>p.status==='pending'&&!this.state.requests[p.binding]).map(([t])=>t),halted:this.state.halted,paused:this.state.paused,incidents:this.state.incidents.length};}
 // Independent observation gate: every configured observer must report the burn at the same height with the same block hash and
 // >= confirmations. Disagreement withholds the payout. Does NOT remove the loss counterexample (honest nodes follow the same reorg).
 async observe(txid){const view=async(url)=>{try{const r=await (await fetch(url+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:false,prune:true}),signal:AbortSignal.timeout(20000)})).json();const t=(r.txs||[])[0];if(!t)return {url,known:false};
    const hdr=t.in_pool?null:await (await fetch(url+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'o',method:'get_block_header_by_height',params:{height:t.block_height}})})).json();return {url,known:true,inPool:Boolean(t.in_pool),height:t.in_pool?null:t.block_height,confirmations:t.in_pool?0:Number(t.confirmations||0),blockHash:hdr?.result?.block_header?.hash||null};}catch(e){return {url,error:String(e.message).slice(0,120)};}};
  const primary=await view(this.primaryRpc);const others=await Promise.all(this.observers.map(view));
  const agree=o=>o.known&&!o.inPool&&o.height===primary.height&&o.blockHash===primary.blockHash&&o.confirmations>=this.confirmations;
  const ok=primary.known&&!primary.inPool&&primary.confirmations>=this.confirmations&&(!this.requireObservers||this.observers.length>0)&&others.every(agree);
  return {ok,primary,observers:others,reason:ok?null:!primary.known?'primary node does not know the burn':this.requireObservers&&!this.observers.length?'no independent observer configured':others.filter(o=>!agree(o)).map(o=>o.url+': '+(o.error||(!o.known?'unknown':o.inPool?'in pool':'different block or depth'))).join('; ')||'primary below confirmations'};}
 async payout(txid){this.assertLive();const p=this.state.payouts[txid];assert.ok(p,'Unknown redemption');
  if(p.status==='paid')return {repeated:true,...p};
  this.assertPayoutsOpen();assert.ok(['pending','submitting'].includes(p.status),'Redemption not payable: '+p.status);
  const existing=await this.custody.redemptionReceipt(txid);if(existing){p.status='paid';p.receipt=existing;p.recovered=true;await this.persist();await this.audit({event:'payout-recovered',txid});return {recovered:true,...p};}
  assert.ok(p.confirmations>=this.confirmations,`Only ${p.confirmations} confirmations`);
  const req=this.state.requests[p.binding];assert.ok(req,'No destination registered for this redemption binding');assert.equal(redeemBindingFor(req.destination,req.request),p.binding);
  if(this.observers.length||this.requireObservers){const obs=await this.observe(txid);await this.audit({event:'observe',txid,ok:obs.ok,reason:obs.reason});assert.ok(obs.ok,'Payout withheld: independent observation does not confirm the burn ('+obs.reason+')');}
  const tip=this.last?.tip??0;assert.ok(BigInt(p.amount)<=BigInt(this.exposure.maxSinglePayout),'Exposure: single payout above limit');assert.ok(this.paidInWindow(tip)+BigInt(p.amount)<=BigInt(this.exposure.maxPaidPerWindow),'Exposure: window payout limit reached; wait for more blocks');
  p.status='submitting';p.destination=req.destination;p.paidAtTip=tip;p.submittedAt=new Date().toISOString();await this.persist();this.inject('beforeSubmit',txid);await this.audit({event:'payout-submitting',txid,amount:p.amount,destination:req.destination});
  const r=await this.custody.redeem(req.destination,BigInt(p.amount),txid);assert.ok(r.ok,(r.logs||[]).join('\n')||'custody refused');this.inject('afterSubmit',txid);
  p.status='paid';p.receipt=r.receipt;p.signature=r.signature||null;p.paidAt=new Date().toISOString();await this.persist();await this.audit({event:'payout-paid',txid,amount:p.amount,signature:p.signature});return p;}
 // Backing buckets: every unit of reserve is owed to exactly one bucket.
 async liabilities(summary){const pool=this.pool(summary);const credited=new Set(pool.credits.map(c=>c.binding));
  const receipts=await this.custody.receipts();const awaitingDeposits=sum(receipts.filter(r=>r.kind===10&&!credited.has(r.nonce)).map(r=>r.net));
  const claimedIds=new Set(this.registry?this.registry.consumedIds():[]);const awaitingClaims=sum(Object.entries(this.state.credits).filter(([b,c])=>c.kind===2&&claimedIds.has(b)&&!credited.has(b)).map(([,c])=>c.amount));
  const paid=new Set(Object.entries(this.state.payouts).filter(([,p])=>p.status==='paid').map(([t])=>t));const pendingPayout=sum(pool.redemptions.filter(r=>!paid.has(r.txid)).map(r=>r.amount));
  const unclaimed=this.registry?this.registry.unclaimed():0n,outstanding=BigInt(pool.minted)-BigInt(pool.burned);const reserve=BigInt(await this.custody.reserve()),owed=unclaimed+awaitingDeposits+awaitingClaims+outstanding+pendingPayout;
  return {asset:this.asset,reserve:reserve.toString(),owed:owed.toString(),ok:reserve===owed,shortfall:(owed-reserve).toString(),buckets:{unclaimedLegacyRights:unclaimed.toString(),depositsAwaitingCredit:awaitingDeposits.toString(),claimsAwaitingCredit:awaitingClaims.toString(),outstandingNotes:outstanding.toString(),publicSupply:pool.publicSupply,shieldedSupply:pool.shieldedSupply,confirmedBurnsAwaitingPayout:pendingPayout.toString()},minted:pool.minted,burned:pool.burned,incidents:this.state.incidents.length,halted:this.state.halted,paused:this.state.paused};}
}
