// Public negotiation/authentication only. No wallet key or native signing API.
import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {exact,need,hex,hash,domain,join,uint,le} from '../xn1/bytes.mjs';
import {publicPoint,legacyHashToPoint,claimChallenge,ORDER,verifyClaim,verifyRecipient} from '../xn1/proofs.mjs';
import {decodeOffer,encodeOffer,offerId,verifyAuthorization,encodeAction} from '../native-offers/codec.mjs';
import {decodeCarrier,inspectCarrier} from '../xn1/carrier.mjs';
import {encodeRecord} from '../xn1/records.mjs';
import {signatureBundleMetadata} from '../wallet/signature-journal.mjs';
export const LIMITS=Object.freeze({sessions:128,events:2048,bytes:32*1024*1024,requestBytes:4*1024*1024,sessionSeconds:900,perOffer:8,
 transactionBytes:20000,sessionEvents:10,sessionBytes:192*1024});
const ZERO='00'.repeat(32),Point=ed25519.ExtendedPoint;
export const decimal=value=>{need(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value),'Exact bounded integer required');const n=BigInt(value);need(n<=0xffffffffffffffffn,'Integer exceeds range');return n;};
export function canonical(value){
 const seen=new Set();let nodes=0,size=0;
 function sorted(v,depth=0){
  need(++nodes<=200000&&depth<=32,'Wire value exceeds structural bounds');
  if(typeof v==='string'){size+=v.length;need(size<=LIMITS.bytes,'Wire strings exceed bounds');return v;}
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isSafeInteger(v),'Safe integer required');return v;}
  need(v&&typeof v==='object'&&!seen.has(v),'Plain acyclic wire value required');seen.add(v);
  let result;if(Array.isArray(v))result=v.map(x=>sorted(x,depth+1));else{
   need(Object.getPrototypeOf(v)===Object.prototype,'Plain wire value required');result=Object.fromEntries(Object.keys(v).sort().map(k=>{size+=k.length;need(size<=LIMITS.bytes,'Wire strings exceed bounds');return [k,sorted(v[k],depth+1)];}));
  }
  seen.delete(v);return result;
 }
 return JSON.stringify(sorted(value));
}
export const digest=value=>hash(Buffer.from(canonical(value))).toString('hex');
export const clone=value=>JSON.parse(canonical(value));
const nonzero=value=>{hex(value);need(value!==ZERO,'Nonzero identifier required');return value;};
const proof=value=>{exact(value,['c','s']);hex(value.c);hex(value.s);return value;};
const nativeBytes=value=>{need(typeof value==='string'&&/^(?:[0-9a-f]{2})+$/.test(value)&&value.length<=4000000,'Bounded native transaction required');return Buffer.from(value,'hex');};
const same=(a,b)=>canonical(a)===canonical(b);
export function creation(value){exact(value,['offerId','buyerKey','nonce','expiresAt']);hex(value.offerId);publicPoint(value.buyerKey);nonzero(value.nonce);decimal(value.expiresAt);return value;}
export function sessionId(payload){return hash(domain('XMR20-NATIVE-TRADE-SESSION-1'),Buffer.from(canonical(creation(payload)))).toString('hex');}
export function constructionSession(identity,sellerKey){hex(identity);publicPoint(sellerKey);return hash(domain('XMR20-NATIVE-TRADE-CONSTRUCTION-1'),hex(identity),hex(sellerKey)).toString('hex');}
export function requestMessage(input){
 exact(input,['version','sessionId','role','revision','requestId','kind','payload','key']);need(input.version===1,'Unsupported trade request version');hex(input.sessionId);publicPoint(input.key);
 need(['buyer','seller'].includes(input.role)&&Number.isSafeInteger(input.revision)&&input.revision>=0&&input.revision<=LIMITS.events,'Invalid role/revision');
 need(typeof input.requestId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId),'Bounded request ID required');
 need(['create','join','proposal','proof','finalize','hold','signature','transaction','abort','read'].includes(input.kind),'Unknown negotiation request');
 need(input.payload&&Object.getPrototypeOf(input.payload)===Object.prototype,'Typed payload required');const encoded=Buffer.from(canonical(input));need(encoded.length<=LIMITS.requestBytes,'Negotiation request exceeds bounds');
 return join(domain('XMR20-NATIVE-TRADE-MAILBOX-1'),encoded);
}
export function authenticated(input){
 exact(input,['version','sessionId','role','revision','requestId','kind','payload','key','signature']);hex(input.signature,64);const {signature,...request}=input;
 need(ed25519.verify(hex(signature,64),requestMessage(request),hex(request.key),{zip215:false}),'Invalid mailbox signature');return clone(input);
}
export function publicOffer(offerBytes,authorization){const offer=decodeOffer(nativeBytes(offerBytes));need(verifyAuthorization(offer,proof(authorization)),'Invalid published offer ownership');return offer;}
export function validateContribution(c,state){
 exact(c,['session','checkpoint','height','source','globalIndex','amount','key','commitment','image','indices','ownershipProof','amountProof']);
 exact(c.source,['txid','vout']);hex(c.source.txid);const vout=decimal(c.source.vout);need(vout<=0xffffffffn,'Source index exceeds range');
 const offer=publicOffer(state.offerBytes,state.offerProof);need(c.session===constructionSession(state.id,state.sellerKey),'Contribution belongs to another mailbox');
 hex(c.checkpoint);const height=decimal(c.height),globalIndex=decimal(c.globalIndex),amount=decimal(c.amount);need(amount>0n,'Carrier amount required');
 publicPoint(c.key);publicPoint(c.image);publicPoint(c.commitment);proof(c.ownershipProof);exact(c.amountProof,['r','s']);publicPoint(c.amountProof.r);hex(c.amountProof.s);need(le(hex(c.amountProof.s))<ORDER,'Noncanonical amount proof');
 need(c.source.txid===offer.source.txid&&vout===BigInt(offer.source.vout)&&c.key===offer.outputKey&&c.image===offer.keyImage&&globalIndex===offer.provenance.globalIndex,'Contribution differs from signed offer source');
 need(Array.isArray(c.indices)&&c.indices.length===16,'Sixteen public ring indexes required');const indices=c.indices.map(decimal);need(indices.every((n,i)=>i===0||n>indices[i-1])&&indices.includes(globalIndex),'Invalid carrier ring');
 const statement=hash(domain('XMR20-NATIVE-CONSTRUCTION-CARRIER-V1'),hex(c.session),hex(c.checkpoint),uint(height,8),hex(c.source.txid),uint(vout,8),uint(globalIndex,8),uint(amount,8),hex(c.key),hex(c.commitment),hex(c.image),...indices.map(n=>uint(n,8)));
 const challenge=le(hex(c.ownershipProof.c)),response=le(hex(c.ownershipProof.s));need(challenge<ORDER&&response<ORDER,'Noncanonical carrier ownership proof');
 const a=Point.BASE.multiplyUnsafe(response).add(publicPoint(c.key).multiplyUnsafe(challenge));
 const b=legacyHashToPoint(c.key).multiplyUnsafe(response).add(publicPoint(c.image).multiplyUnsafe(challenge));
 need(challenge===claimChallenge(statement,c.key,c.image,a,b),'Seller mailbox is not authorized by the native carrier owner');
 // This authenticates the mailbox, not carrier spendability/amount. The buyer's
 // private constructor independently verifies the amount proof, ring and chain.
 return clone(c);
}
export function inspectProposal(transaction,state,{blank=false}={}){
 const tx=inspectCarrier(nativeBytes(transaction)),decoded=decodeCarrier(tx),offer=publicOffer(state.offerBytes,state.offerProof);
 need(tx.inputs.length<=16,'Native wallet supports at most sixteen inputs');
 need(tx.data.length<=LIMITS.transactionBytes,'Native negotiation transaction exceeds wallet transport budget');
 need(decoded?.record.op==='MOVE'&&decoded.record.manifest===offer.manifest,'Wrong token operation');const record=decoded.record;
 need(record.claims.length===1&&record.allocations.length===1,'One whole-lot claim/allocation required');const c=record.claims[0],a=record.allocations[0];
 need(c.source.txid===offer.source.txid&&c.source.vout===offer.source.vout&&tx.inputs[c.vin]?.keyImage===offer.keyImage&&tx.inputs[c.vin]?.offsets[c.ringPos]===offer.provenance.globalIndex,'Wrong native token source');
 need(a.amount===offer.quantity&&a.vout<tx.outputs.length,'Whole signed quantity required');
 if(blank)need([c.c,c.s,a.c,a.s].every(v=>v===ZERO),'Proposal proof slots must be empty');
 return {tx,decoded,offer,claim:c,allocation:a};
}
export function verifyTradeProof(value,state,role){
 proof(value);const {tx,decoded,offer,claim,allocation}=inspectProposal(state.proposal.transaction,state);
 const okay=role==='seller'?verifyClaim({manifest:offer.manifest,context:decoded.context,claim:{...claim,...value},outputKey:offer.outputKey,keyImage:offer.keyImage,op:'MOVE'}):
  verifyRecipient({manifest:offer.manifest,context:decoded.context,allocation:{...allocation,...value},outputKey:tx.outputs[allocation.vout].key});
 need(okay,'Invalid token trade proof');return clone(value);
}
export function validateFinal(transaction,state){
 const before=inspectProposal(state.proposal.transaction,state),after=inspectProposal(transaction,state);
 const expected=structuredClone(before.decoded.record);Object.assign(expected.claims[0],state.proofs.seller);Object.assign(expected.allocations[0],state.proofs.buyer);
 need(encodeRecord(after.decoded.record).equals(encodeRecord(expected))&&after.decoded.context===before.decoded.context,'Final token proofs/context changed');
 // Prefix up to extra-length, native RingCT base and complete prunable bytes
 // must remain exact. Only the canonical token proof fields may differ.
 const normalized=bytes=>{const t=inspectCarrier(bytes);return {inputs:t.inputs.map(i=>({...i,offsets:i.offsets.map(String)})),outputs:t.outputs,fee:String(t.fee),body:t.data.subarray(t.prefixEnd).toString('hex')};};
 need(same(normalized(before.tx.data),normalized(after.tx.data)),'Native transaction body changed');
 need(verifyTradeProof(state.proofs.seller,state,'seller')&&verifyTradeProof(state.proofs.buyer,state,'buyer'),'Final token proofs missing');
 return {transaction,signatureHash:after.tx.signatureHash};
}
export function validateHold(payload,state){exact(payload,['action','proof']);encodeAction(payload.action);const offer=publicOffer(state.offerBytes,state.offerProof);need(payload.action.type==='signature-released'&&payload.action.offerId===offerId(offer)&&payload.action.proposalHash===state.final.signatureHash,'Hold differs from finalized sale');need(verifyAuthorization(offer,proof(payload.proof),payload.action),'Invalid seller signature-release proof');return clone(payload);}
export function validateBundle(value,state,role){
 const data=nativeBytes(value);need(data.length<=9834,'Signature bundle exceeds limit');const meta=signatureBundleMetadata(data),{tx,claim}=inspectProposal(state.final.transaction,state);
 need(meta.signatureHash===state.final.signatureHash,'Native bundle signs another proposal');const vins=Array.from({length:meta.count},(_,i)=>data.readUInt16LE(74+i*610));
 const expected=role==='seller'?[claim.vin]:tx.inputs.map((_,i)=>i).filter(i=>i!==claim.vin);need(same(vins,expected),'Signature bundle contains another party inputs');
 return value;
}
export function validateAssembled(transaction,state){
 const candidate=inspectProposal(transaction,state),final=inspectProposal(state.final.transaction,state);
 need(candidate.tx.signatureHash===state.final.signatureHash&&candidate.decoded.context===final.decoded.context&&encodeRecord(candidate.decoded.record).equals(encodeRecord(final.decoded.record)),'Assembled transaction differs from finalized sale');
 // Bind the entire serialized transaction to exactly the two exchanged bundles.
 // This is wire verification, not a replacement for the private wallet's CLSAG,
 // range-proof, commitment-balance and independent native chain validation.
 const expected=Buffer.from(final.tx.data),count=final.tx.inputs.length;
 for(const role of ['buyer','seller']){
  validateBundle(state.signatures[role],state,role);const b=Buffer.from(state.signatures[role],'hex'),n=b.readUInt16LE(72);
  for(let i=0;i<n;i++){const start=74+i*610,vin=b.readUInt16LE(start);b.subarray(start+34,start+610).copy(expected,final.tx.proofEnd+vin*576);b.subarray(start+2,start+34).copy(expected,final.tx.proofEnd+count*576+vin*32);}
 }
 need(candidate.tx.data.equals(expected),'Assembled bytes do not match the exchanged signature bundles');
 return {transaction,txid:candidate.tx.txid,signatureHash:candidate.tx.signatureHash};
}
export function advance(state,request,now,{offerBytes,offerProof,holdReceipt}={}){
 const r=authenticated(request);need(r.kind!=='read','Read is not a mutation');
 if(!state){
  need(r.kind==='create'&&r.role==='buyer'&&r.revision===0,'Buyer creation required');creation(r.payload);need(r.key===r.payload.buyerKey&&r.sessionId===sessionId(r.payload),'Buyer session binding differs');
  const offer=publicOffer(offerBytes,offerProof),expires=decimal(r.payload.expiresAt);need(offerId(offer)===r.payload.offerId&&expires>now&&expires<=now+BigInt(LIMITS.sessionSeconds)&&expires<=offer.expiresAt,'Trade session expiry/offer invalid');
  return {id:r.sessionId,revision:1,phase:'requested',offerId:r.payload.offerId,offerBytes,offerProof:clone(offerProof),buyerKey:r.key,sellerKey:null,expiresAt:r.payload.expiresAt,
   contribution:null,proposal:null,proofs:{buyer:null,seller:null},final:null,hold:null,signatures:{buyer:null,seller:null},assembled:null};
 }
 need(r.sessionId===state.id&&r.revision===state.revision,'Trade session revision changed');const next=clone(state),offer=publicOffer(state.offerBytes,state.offerProof);
 need(state.phase!=='aborted','Trade session was aborted');
 const key=r.role==='buyer'?state.buyerKey:state.sellerKey;
 if(r.kind==='join'){
  need(r.role==='seller'&&state.phase==='requested'&&state.sellerKey===null,'Seller can join only an open request');exact(r.payload,['contribution']);next.sellerKey=r.key;next.contribution=validateContribution(r.payload.contribution,next);next.phase='contributed';
 }else{
  need(key&&key===r.key,'Mailbox key does not own this role');
  if(r.kind==='proposal'){
   need(r.role==='buyer'&&state.phase==='contributed','Buyer proposal out of sequence');exact(r.payload,['transaction']);inspectProposal(r.payload.transaction,state,{blank:true});next.proposal=clone(r.payload);next.phase='proposed';
  }else if(r.kind==='proof'){
   need(state.phase==='proposed'&&!state.proofs[r.role],'Token proof out of sequence');exact(r.payload,['proof']);next.proofs[r.role]=verifyTradeProof(r.payload.proof,state,r.role);
  }else if(r.kind==='finalize'){
   need(r.role==='buyer'&&state.phase==='proposed'&&state.proofs.buyer&&state.proofs.seller,'Both token proofs required');exact(r.payload,['transaction']);next.final=validateFinal(r.payload.transaction,state);next.phase='finalized';
  }else if(r.kind==='hold'){
   need(r.role==='seller'&&state.phase==='finalized','Seller hold out of sequence');validateHold(r.payload,state);need(holdReceipt&&typeof holdReceipt.requestId==='string'&&Number.isSafeInteger(holdReceipt.sequence)&&holdReceipt.sequence>0,'Durable offer hold receipt required');hex(holdReceipt.hash);next.hold={...clone(r.payload),receipt:clone(holdReceipt)};next.phase='held';
  }else if(r.kind==='signature'){
   need(state.phase==='held'&&!state.signatures[r.role]&&state.hold,'Durable hold required before sharing signatures');exact(r.payload,['bundle']);next.signatures[r.role]=validateBundle(r.payload.bundle,state,r.role);if(next.signatures.buyer&&next.signatures.seller)next.phase='signed';
  }else if(r.kind==='transaction'){
   need(state.phase==='signed'&&state.hold&&state.signatures.buyer&&state.signatures.seller,'Both released signature bundles are required before assembly');exact(r.payload,['transaction']);next.assembled=validateAssembled(r.payload.transaction,state);next.phase='assembled';
  }else if(r.kind==='abort'){
   exact(r.payload,[]);need(['requested','contributed','proposed'].includes(state.phase),'Finalized or held sale cannot be abandoned by deleting the session');next.phase='aborted';
  }else throw Error('Invalid negotiation transition');
 }
 if(!['hold','signature','transaction'].includes(r.kind))need(decimal(state.expiresAt)>now&&offer.expiresAt>now,'Negotiation expired');
 next.revision++;return next;
}
export function authorizeRead(state,input){const r=authenticated(input);need(r.kind==='read'&&r.sessionId===state.id&&r.revision===state.revision,'Read must bind current exact revision');exact(r.payload,[]);need(r.key===(r.role==='buyer'?state.buyerKey:state.sellerKey),'Mailbox read is not authorized');return r;}
