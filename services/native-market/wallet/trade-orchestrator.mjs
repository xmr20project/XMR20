// Explicit user-driven stages between a private wallet client and its durable
// authenticated mailbox. Polling only reads. This module never broadcasts.
import {Buffer} from 'buffer';
import {hex,need} from '../xn1/bytes.mjs';
import {encodeOffer,offerId} from '../native-offers/codec.mjs';
import {encodeRecord} from '../xn1/records.mjs';
import {inspectCarrier} from '../xn1/carrier.mjs';
import {clone,canonical,decimal,publicOffer,constructionSession,validateContribution,
 inspectProposal,verifyTradeProof,validateFinal,validateHold,validateBundle,validateAssembled,LIMITS} from '../trade-sessions/protocol.mjs';

const ZERO='00'.repeat(32),same=(a,b)=>canonical(a)===canonical(b);
const native=transaction=>{need(typeof transaction==='string'&&/^(?:[0-9a-f]{2})+$/.test(transaction)&&transaction.length<=4000000,'Bounded native transaction required');return inspectCarrier(Buffer.from(transaction,'hex'));};
const fragments=record=>{const bytes=encodeRecord(record),count=Math.ceil(bytes.length/240);need(count>0&&count<=4,'Bounded token metadata required');return Array.from({length:count},(_,i)=>Buffer.concat([Buffer.from('XN1'),Buffer.from([i,count]),bytes.subarray(i*240,(i+1)*240)]).toString('hex'));};
const positive=value=>{need(decimal(value)>0n,'Positive exact budget required');return value;};
const termsFor=offer=>({manifest:offer.manifest,genesis:offer.genesis,source:{txid:offer.source.txid,vout:String(offer.source.vout)},quantity:String(offer.quantity),pricePiconero:String(offer.pricePiconero),paymentAddress:offer.paymentAddress,expiresAt:String(offer.expiresAt),nonce:offer.nonce,recordId:offer.provenance.recordId,height:String(offer.provenance.height),globalIndex:String(offer.provenance.globalIndex)});
const handle=value=>{need(Number.isSafeInteger(value)&&value>0&&value<=0xffffffff,'Private wallet handle required');return value;};

export async function createTradeOrchestrator({wallet,mailbox,role,offerBytes,offerProof,maximumFee,carrier='1000000',assertCurrent,crypto=globalThis.crypto,now=()=>BigInt(Math.floor(Date.now()/1000))}){
 need(wallet&&mailbox&&typeof assertCurrent==='function'&&crypto?.getRandomValues,'Private wallet, durable mailbox and active account required');
 need(role==='buyer'||role==='seller','Explicit trade role required');positive(maximumFee);positive(carrier);
 const offer=publicOffer(offerBytes,offerProof),identity=offerId(offer),envelope={offer,proof:clone(offerProof)},terms=termsFor(offer);
 need(encodeOffer(offer).toString('hex')===offerBytes,'Canonical offer bytes required');
 let closed=false,busy=false,bound=null,mailIdentity,last=null,build=null,proposal=null,localProof=null,finalized=null,reviewed=null,signed=null,hold=null,assembled=null,recoveryRequired=false;
 let buildAttempted=false,reviewAttempted=false,signAttempted=false,assemblyAttempted=false,needsRebase=false,recoveredNative=false,recoveryNeedsSync=false;
 const current=()=>{need(!closed,'Trade controller closed');const result=assertCurrent();need(result!==false&&!(result&&typeof result.then==='function'),'Wallet account changed');};
 const after=async promise=>{const result=await promise;current();return result;};
 const exclusive=async work=>{current();need(!busy,'Trade action already in progress');busy=true;try{return await work();}finally{busy=false;}};
 const operation=async(name,args)=>{current();need(typeof wallet[name]==='function','Private wallet operation is unavailable');return after(wallet[name](args));};
 const random=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
 const requireNative=()=>need(!recoveryRequired,'Private trade recovery is required; existing wallet reservations remain protected');
 const requireNoPending=async()=>need(!await after(mailbox.pending()),'Retry the saved mailbox request before another trade action');
 async function identityState(){
  const value=await after(mailbox.identity());
  need(value.scope?.role===role&&value.scope.offerId===identity&&value.scope.genesis===offer.genesis,'Mailbox belongs to another wallet role, chain or offer');hex(value.key);
  if(mailIdentity)need(value.key===mailIdentity.key&&same(value.scope,mailIdentity.scope),'Mailbox identity changed');
  if(bound)need(value.sessionId===bound,'Trade session changed');if(value.sessionId){hex(value.sessionId);bound=value.sessionId;}mailIdentity=value;return value;
 }
 function stateValue(value){
  const state=clone(value);need(state.id===bound&&state.offerId===identity&&state[role+'Key']===mailIdentity.key&&state.offerBytes===offerBytes&&same(state.offerProof,offerProof),'Trade response differs from the approved offer or mailbox');
  need(Number.isSafeInteger(state.revision)&&state.revision>0,'Invalid trade revision');publicOffer(state.offerBytes,state.offerProof);
  if(state.contribution)validateContribution(state.contribution,state);
  if(state.proposal){inspectProposal(state.proposal.transaction,state,{blank:true});if(proposal)need(state.proposal.transaction===proposal,'Published proposal changed');}
  for(const party of ['buyer','seller'])if(state.proofs?.[party])verifyTradeProof(state.proofs[party],state,party);
  if(state.final){need(same(validateFinal(state.final.transaction,state),state.final),'Finalized transaction changed');if(finalized)need(state.final.transaction===finalized,'Locally finalized transaction changed');}
  if(state.hold){const {receipt,...authorization}=state.hold;validateHold(authorization,state);need(receipt&&/^trade-hold-[0-9a-f]{64}$/.test(receipt.requestId)&&Number.isSafeInteger(receipt.sequence)&&receipt.sequence>0,'Durable offer hold receipt required');hex(receipt.hash);}
  for(const party of ['buyer','seller'])if(state.signatures?.[party])validateBundle(state.signatures[party],state,party);
  if(state.assembled)need(same(validateAssembled(state.assembled.transaction,state),state.assembled),'Assembled transaction changed');
  const phases=['requested','contributed','proposed','finalized','held','signed','assembled','aborted'];need(phases.includes(state.phase),'Unknown trade phase');
  const at=phases.indexOf(state.phase);if(at>=1&&at<7)need(state.contribution,'Seller contribution missing');if(at>=2&&at<7)need(state.proposal,'Trade proposal missing');if(at>=3&&at<7)need(state.final,'Final transaction missing');if(at>=4&&at<7)need(state.hold,'Signature hold missing');if(at>=5&&at<7)need(state.signatures.buyer&&state.signatures.seller,'Counterpart signatures missing');if(at===6)need(state.assembled,'Assembled result missing');
  if(last)need(state.revision>=last.revision,'Trade response moved backwards');
  // A mailbox receipt cannot restore private ephemeral construction/review state.
  if(role==='buyer'&&['proposed','finalized','held','signed'].includes(state.phase)&&!build&&!recoveredNative)recoveryRequired=true;
  if(role==='seller'&&state.phase==='held'&&!signed&&!state.signatures.seller)recoveryRequired=true;
  last=state;return state;
 }
 async function read(){await identityState();need(bound,'Create or accept a trade first');return stateValue(await after(mailbox.read()));}
 const approval=state=>{const {tx,allocation}=inspectProposal(state.proposal.transaction,state);return {role,envelope,maximumFee,recipient:{vout:allocation.vout,outputKey:tx.outputs[allocation.vout].key,keyImage:allocation.image}};};
 function summary(state,pending=null){
  const phase=state?.phase??(bound?'joining':'unbound');let actions=[];
  if(pending)actions=needsRebase?['retry','rebasePending']:['retry'];
  else if(recoveryRequired){
   if(role==='seller'&&phase==='finalized')actions=['recoverRelease'];
   else if(['held','signed'].includes(phase)&&(role==='buyer'||!state.signatures.seller))actions=['recoverSignature'];
  }else if(!recoveryRequired){
   if(!bound)actions=role==='buyer'?['create']:['accept'];
   else if(phase==='contributed'&&role==='buyer')actions=['prepare'];
   else if(phase==='proposed'){if(!state.proofs[role])actions=['authorizeProof'];else if(role==='buyer'&&state.proofs.buyer&&state.proofs.seller)actions=['finalize'];}
   else if(['finalized','held'].includes(phase)&&!state.signatures[role]){
    if(!reviewed)actions=role==='seller'&&phase==='finalized'?['review','recoverRelease']:['review'];else if(!signed&&(role==='seller'||phase==='held'))actions=['sign'];else if(signed&&phase==='finalized'&&role==='seller')actions=['sign'];else if(signed&&phase==='held')actions=['shareSignature'];
   }else if(phase==='signed'&&role==='buyer')actions=[recoveredNative&&recoveryNeedsSync?'syncRecovered':'assemble'];else if(phase==='assembled')actions=['result'];
  }
  return {role,sessionId:bound,offerId:identity,phase,revision:state?.revision??null,actions,pending:pending?clone(pending):null,recoveryRequired,
   ...(state?.assembled?{status:'awaiting-broadcast',txid:state.assembled.txid}:{})};
 }
 async function poll(){await identityState();const pending=await after(mailbox.pending());if(pending)return summary(last,pending);return summary(bound?await read():null);}
 async function submit(state,kind,payload){await after(mailbox.submit({revision:state.revision,kind,payload}));return summary(await read());}
 function matchingReview(state){need(reviewed&&reviewed.signatureHash===state.final.signatureHash,'Review this exact final transaction first');}
 function quote(state,result){return {role,sessionId:bound,offerId:identity,signatureHash:state.final.signatureHash,quantity:String(offer.quantity),pricePiconero:String(offer.pricePiconero),feePiconero:result.fee,debitPiconero:result.debit,receivePiconero:result.receive,carrierPiconero:carrier,maximumFee};}
 await identityState();current();
 return Object.freeze({
  poll:()=>exclusive(poll),
  create:({expiresAt}={})=>exclusive(async()=>{
   await requireNoPending();await identityState();need(role==='buyer'&&!bound,'Only an unbound buyer may create a trade');const clock=now();need(typeof clock==='bigint','Exact clock required');
   const end=expiresAt??String(offer.expiresAt<clock+BigInt(LIMITS.sessionSeconds)?offer.expiresAt:clock+BigInt(LIMITS.sessionSeconds));need(decimal(end)>clock&&decimal(end)<=offer.expiresAt&&decimal(end)<=clock+BigInt(LIMITS.sessionSeconds),'Trade expiry exceeds approved offer');
   await after(mailbox.create({expiresAt:end}));return poll();
  }),
  accept:request=>exclusive(async()=>{
   await requireNoPending();requireNative();await identityState();need(role==='seller'&&!bound,'Only an unbound seller may accept');
   need(request?.offerId===identity&&request.revision===1&&decimal(request.expiresAt)>now(),'Trade request is unavailable');hex(request.id);hex(request.buyerKey);
   const session=constructionSession(request.id,mailIdentity.key),contribution=await operation('prepareSaleContribution',{session,source:offer.source});
   validateContribution(contribution,{id:request.id,sellerKey:mailIdentity.key,offerBytes,offerProof});
   await after(mailbox.join({sessionId:request.id,revision:request.revision,contribution}));return poll();
  }),
  prepare:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(role==='buyer'&&state.phase==='contributed','Buyer construction is out of sequence');
   if(!build){need(!buildAttempted,'Private construction recovery is required');buildAttempted=true;
    try{build=await operation('constructSale',{contribution:state.contribution,request:{session:constructionSession(bound,state.sellerKey),pricePiconero:String(offer.pricePiconero),carrier,maximumFee,sellerAddress:offer.paymentAddress,data:fragments({op:'MOVE',manifest:offer.manifest,claims:[{vin:0,ringPos:0,source:offer.source,c:ZERO,s:ZERO}],allocations:[{vout:1,amount:offer.quantity,image:offer.keyImage,c:ZERO,s:ZERO}]})}});handle(build.buildHandle);}
    catch(error){recoveryRequired=true;throw error;}
   }
   if(!proposal){const tx=native(build.transaction),vout=Number(decimal(String(build.tokenVout)));need(vout<tx.outputs.length&&tx.fee<=decimal(maximumFee),'Constructed budget or recipient is invalid');
    const recipient=await operation('proposedRecipient',{transaction:build.transaction,vout});need(recipient.outputKey===tx.outputs[vout].key,'Private recipient differs from constructed output');hex(recipient.keyImage);
    const vin=tx.inputs.findIndex(i=>i.keyImage===offer.keyImage);need(vin>=0,'Seller native source missing');const ringPos=tx.inputs[vin].offsets.findIndex(i=>i===offer.provenance.globalIndex);need(ringPos>=0,'Seller ring source missing');
    const record={op:'MOVE',manifest:offer.manifest,claims:[{vin,ringPos,source:offer.source,c:ZERO,s:ZERO}],allocations:[{vout,amount:offer.quantity,image:recipient.keyImage,c:ZERO,s:ZERO}]};
    const changed=await operation('replaceConstructionData',{buildHandle:build.buildHandle,data:fragments(record)});inspectProposal(changed.transaction,state,{blank:true});proposal=changed.transaction;
   }return submit(state,'proposal',{transaction:proposal});
  }),
  authorizeProof:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(state.phase==='proposed'&&!state.proofs[role],'Token proof is out of sequence');
   if(role==='buyer')need(build,'Private buyer construction is unavailable; recovery is required');
   const {claim,allocation}=inspectProposal(state.proposal.transaction,state);
   if(!localProof){localProof=await operation('authorizeTokenProof',{transaction:state.proposal.transaction,approval:approval(state),request:role==='seller'?{kind:'claim',source:{...claim.source,vout:String(claim.source.vout)},vin:String(claim.vin),ringPos:String(claim.ringPos)}:{kind:'recipient',vout:String(allocation.vout),quantity:String(allocation.amount)}});verifyTradeProof(localProof,state,role);}
   return submit(state,'proof',{proof:localProof});
  }),
  finalize:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(role==='buyer'&&build&&state.phase==='proposed'&&state.proofs.buyer&&state.proofs.seller,'Both token proofs and the private construction are required');
   if(!finalized){const {decoded}=inspectProposal(state.proposal.transaction,state),record=structuredClone(decoded.record);Object.assign(record.claims[0],state.proofs.seller);Object.assign(record.allocations[0],state.proofs.buyer);
    const changed=await operation('replaceConstructionData',{buildHandle:build.buildHandle,data:fragments(record)});validateFinal(changed.transaction,state);finalized=changed.transaction;}
   return submit(state,'finalize',{transaction:finalized});
  }),
  review:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(['finalized','held'].includes(state.phase),'Final transaction is not ready for review');
   if(!reviewed){need(!reviewAttempted,'Private review recovery is required');if(role==='buyer')need(build,'Private buyer construction unavailable; recovery is required');reviewAttempted=true;
    try{reviewed=await operation(role==='buyer'?'reviewConstructedSale':'reviewSellerSale',{...(role==='buyer'?{buildHandle:build.buildHandle}:{}),transaction:state.final.transaction,approval:approval(state)});handle(reviewed.handle);need(reviewed.signatureHash===state.final.signatureHash&&decimal(reviewed.fee)===native(state.final.transaction).fee,'Private review differs from final transaction');decimal(reviewed.debit);decimal(reviewed.receive);}
    catch(error){recoveryRequired=true;throw error;}
   }matchingReview(state);return quote(state,reviewed);
  }),
  sign:({signatureHash})=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(['finalized','held'].includes(state.phase)&&!state.signatures[role],'Signature is out of sequence');matchingReview(state);need(signatureHash===reviewed.signatureHash,'Explicit approval of the reviewed transaction required');if(role==='buyer')need(state.hold&&state.phase==='held','Seller durable hold is required before buyer signing');
   if(!signed){need(!signAttempted,'Unknown native signing outcome; private recovery is required');signAttempted=true;
    try{signed=await operation('signConstructedSale',{reviewHandle:reviewed.handle});need(typeof signed.reservationId==='string'&&signed.reservationId.length>0,'Durable native receipt required');validateBundle(signed.bundle,state,role);}
    catch(error){recoveryRequired=true;throw error;}
   }
   const receipt=await operation('recoveryStatus',{reservationId:signed.reservationId});need(receipt.state==='signed'&&receipt.reservationId===signed.reservationId,'Private signature receipt is not committed');
   if(role==='seller'&&!state.hold){
    if(!hold){const action={type:'signature-released',offerId:identity,nonce:random(),proposalHash:state.final.signatureHash};const proof=await operation('authorizeOfferAction',{terms,action,reservationId:signed.reservationId});hold={action,proof};validateHold(hold,state);}
    return submit(state,'hold',hold);
   }return summary(state);
  }),
  recoverRelease:()=>exclusive(async()=>{
   await requireNoPending();const state=await read();need(role==='seller'&&state.phase==='finalized'&&!state.hold,'Only a finalized seller release may recover');
   const recovered=await operation('recoverSaleRelease',{offerId:identity,signatureHash:state.final.signatureHash});
   const payload={action:recovered.action,proof:recovered.proof};validateHold(payload,state);hold=payload;
   return submit(state,'hold',payload);
  }),
  recoverSignature:()=>exclusive(async()=>{
   await requireNoPending();const state=await read();need(['held','signed'].includes(state.phase)&&state.hold,'Authenticated hold required before signature recovery');
   const result=await operation('recoverSaleSignature',{sessionId:bound,role,offerId:identity,signatureHash:state.final.signatureHash});
   validateBundle(result.bundle,state,role);need(typeof result.reservationId==='string'&&result.reservationId.length>0&&result.quote?.signatureHash===state.final.signatureHash&&result.quote.role===role&&result.quote.offerId===identity&&result.quote.sessionId===bound,'Recovered private receipt differs from this trade');
   signed={bundle:result.bundle,reservationId:result.reservationId};reviewed={signatureHash:state.final.signatureHash};recoveredNative=true;recoveryNeedsSync=result.requiresSync===true;recoveryRequired=false;
   return {...summary(state),quote:result.quote,requiresSync:recoveryNeedsSync};
  }),
  syncRecovered:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(role==='buyer'&&recoveredNative&&recoveryNeedsSync&&state.phase==='signed','Only recovered assembly may sync here');
   const sync=await operation('sync',{});need(typeof sync.ready==='boolean','Private sync result missing');recoveryNeedsSync=!sync.ready;
   return {...summary(state),sync};
  }),
  shareSignature:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(state.phase==='held'&&state.hold&&!state.signatures[role],'Authenticated durable hold required before sharing');need(signed&&reviewed,'Private signed receipt unavailable; recovery is required');matchingReview(state);validateBundle(signed.bundle,state,role);return submit(state,'signature',{bundle:signed.bundle});
  }),
  assemble:()=>exclusive(async()=>{
   await requireNoPending();requireNative();const state=await read();need(role==='buyer'&&state.phase==='signed'&&state.hold,'Both held signatures are required');need(!recoveryNeedsSync,'Sync private native history before recovered assembly');matchingReview(state);need(signed&&state.signatures.buyer===signed.bundle,'Mailbox changed the locally signed buyer bundle');
   if(!assembled){need(!assemblyAttempted,'Private assembly recovery is required');assemblyAttempted=true;try{const bundles=[state.signatures.seller,state.signatures.buyer];const result=await operation(recoveredNative?'assembleRecoveredSale':'assembleConstructedSale',recoveredNative?{sessionId:bound,role,offerId:identity,signatureHash:state.final.signatureHash,bundles}:{reviewHandle:reviewed.handle,bundles});assembled=validateAssembled(result.transaction,state);}catch(error){recoveryRequired=true;throw error;}}
   return submit(state,'transaction',{transaction:assembled.transaction});
  }),
  retry:()=>exclusive(async()=>{
   need(await after(mailbox.pending()),'No saved mailbox request');try{await after(mailbox.retry());needsRebase=false;}catch(error){if(error.status===400)needsRebase=true;throw error;}return poll();
  }),
  rebasePending:()=>exclusive(async()=>{
   need(needsRebase&&typeof mailbox.rebasePending==='function','Retry the exact request before explicitly rebasing');need(await after(mailbox.pending()),'No saved mailbox request');await after(mailbox.rebasePending());needsRebase=false;return poll();
  }),
  result:()=>exclusive(async()=>{const state=await read();need(state.phase==='assembled'&&state.assembled,'Transaction has not been assembled');return {...clone(state.assembled),status:'awaiting-broadcast',broadcast:false};}),
  close(){closed=true;build=null;reviewed=null;signed=null;hold=null;assembled=null;localProof=null;}
 });
}
