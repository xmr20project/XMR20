import bs58 from 'bs58';
import {VersionedTransaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {addresses,transaction,approveExternal,approveRegistrationExternal} from './sdk.mjs';
import {canonical,digest,message,payload,commitment} from './records.mjs';
import {verifyLinkProof} from './link-proof.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const terms=p=>{need(Buffer.from(p.transaction.message.serialize()).equals(Buffer.from(transaction(p.config,p.proposal).message.serialize())),'Transaction differs from its exact review.');const {blockhash,lastValidBlockHeight,...proposal}=p.proposal;return canonical({config:p.config,proposal,envelope:p.envelope});};
// Shared owner controller for extension-local and external-provider signing.
// Store is scoped to this owner/mint/program and contains public receipts only.
export function createWalletClient({manifest,runtime,provider,moneroSigner,signatureVerifier,store,verifyDeployment,proofChain,onProgress=()=>{}}){
 need(manifest?.abi===3&&runtime&&provider&&moneroSigner?.address&&moneroSigner?.sign&&signatureVerifier?.verify&&store?.load&&store?.save&&typeof verifyDeployment==='function'&&proofChain?.readAccount&&proofChain?.verifyProgram,'Explicit transferable wallet adapters and independent custody reads required.');
 const owner=provider.publicKey.toBase58(),config={abi:3,network:manifest.network,program:manifest.program,mint:manifest.mint,verifier:manifest.verifier,owner,binding:digest(moneroSigner.address)},scope=digest(canonical(config));let busy=false,poisoned=false;
 const current=()=>{need(!poisoned,'Public receipt storage failed. Reopen and reconcile.');provider.assertCurrent?.();need(provider.publicKey?.toBase58()===owner,'Selected Solana account changed.');};
 const load=()=>{current();const s=store.load()??{schema:'joint-owner-v3',scope,config,moneroOwner:moneroSigner.address,proofs:{},operations:{}};need(s.schema==='joint-owner-v3'&&s.scope===scope&&canonical(s.config)===canonical(config)&&s.moneroOwner===moneroSigner.address,'Recover the matching account’s saved receipts.');return s;};
 const save=s=>{try{store.save(structuredClone(s));}catch{poisoned=true;throw Error('Public recovery receipt could not be saved. Nothing further was submitted.');}};
 const run=async f=>{current();need(!busy,'Another wallet approval is running.');busy=true;try{return await f();}finally{busy=false;}};
 const record=(op,nonce,rest={})=>({p:'xmr20-joint',v:3,net:'mainnet',op,owner:moneroSigner.address,mint:manifest.mint,program:manifest.program,nonce,...rest});
 async function verifyRecipient(c,address,preparedLink){const envelope=preparedLink??(await runtime.snapshot()).accepted?.find(e=>e.envelope.record.op==='link'&&e.envelope.record.owner===address&&e.envelope.record.to===c.owner)?.envelope;need(envelope,'Public recipient ownership proof unavailable.');await verifyLinkProof({config:c,moneroAddress:address,envelope,chain:proofChain,signatureVerifier});current();}
 async function signed(r){await verifyDeployment(config);current();const m=message(r),signature=await moneroSigner.sign({record:r,message:m});current();need(await signatureVerifier.verify(m,r.owner,signature),'Monero signature differs from the visible review.');const envelope={record:r,signature};payload(envelope);return envelope;}
 async function registrationProof(envelope,nonce){
  payload(envelope);need(canonical(envelope.record)===canonical(record('link',nonce,{to:owner}))&&await signatureVerifier.verify(message(envelope.record),moneroSigner.address,envelope.signature),'Saved registration proof differs from the linked wallets.');current();
 }
 async function saveOutcome(s,id,result){
  const job=s.operations[id],a=result.publicApproval;need(job&&(!result.operationId||result.operationId===id),'Saved operation identity changed.');
  if(a){
   need(job.proposal.operation==='register'&&a.proposal.operation==='register'&&canonical(job.config)===canonical(config)&&canonical(a.config)===canonical(config)&&a.proposal.nonce===job.proposal.nonce&&canonical(job.envelope.record)===canonical(record('link',a.proposal.nonce,{to:owner}))&&id===addresses(config).position.toBase58()+':register:'+a.proposal.nonce,'Recovered registration differs from this account.');
   await registrationProof(a.envelope,a.proposal.nonce);need(a.proposal.commitment===commitment(a.envelope),'Recovered registration commitment changed.');
   const tx=VersionedTransaction.deserialize(Buffer.from(a.bytes,'base64')),msg=tx.message.serialize(),expected=transaction(config,a.proposal),keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
   need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize()))&&keys.length===2&&tx.signatures.length===2&&keys.every((k,i)=>ed25519.verify(tx.signatures[i],msg,k.toBytes())),'Recovered registration approvals are invalid.');
   const signature=bs58.encode(tx.signatures[0]),localTx=VersionedTransaction.deserialize(Buffer.from(job.bytes,'base64'));
   need(bs58.encode(localTx.signatures[0])===job.ownerSignature,'Saved owner signature changed.');
   if(job.ownerSignature!==signature){
    // Preserve the newer local approval until independent chain reads prove it
    // cannot still land. The service cannot discard an unresolved approval.
    need(proofChain.ownerApprovalOutcome,'Independent owner-approval recovery is unavailable.');
    const previous=await proofChain.ownerApprovalOutcome({config:job.config,proposal:job.proposal,bytes:Buffer.from(job.bytes,'base64')});
    need(['expired','failed'].includes(previous.kind),'A different saved approval is still unresolved. Check its status again.');
   }
   if(result.retryApprovalRequired){need(proofChain.pendingOutcome,'Independent expiry verification is unavailable.');const out=await proofChain.pendingOutcome({bytes:tx.serialize(),lastValidBlockHeight:a.proposal.lastValidBlockHeight});need(['expired','failed'].includes(out.kind),'Registration expiry is not independently confirmed.');}
   if(result.confirmed){need(proofChain.finalizedOperation&&await proofChain.finalizedOperation({config:a.config,proposal:a.proposal,bytes:tx.serialize()}),'Recovered registration is not finalized.');}
   current();if(job.ownerSignature!==signature)(job.supersededApprovals??=[]).push({config:job.config,proposal:job.proposal,envelope:job.envelope,bytes:job.bytes,ownerSignature:job.ownerSignature,phase:job.phase});
   Object.assign(job,{config:a.config,proposal:a.proposal,envelope:a.envelope,bytes:a.bytes,ownerSignature:signature});s.proofs[a.proposal.nonce]={envelope:a.envelope,phase:'signed'};
  }
  if(!a&&result.retryApprovalRequired){need(proofChain.pendingOutcome,'Independent expiry verification is unavailable.');const outcome=await proofChain.pendingOutcome({bytes:Buffer.from(job.bytes,'base64'),lastValidBlockHeight:job.proposal.lastValidBlockHeight});need(['expired','failed'].includes(outcome.kind),'Approval expiry is not independently confirmed.');current();}
  const {publicApproval,...out}=result;job.result=out;job.phase=out.confirmed?'finalized':out.retryApprovalRequired?'approval-expired':'submission-unknown';save(s);return out;
 }
 async function reconcileSaved(s,id){return saveOutcome(s,id,await runtime.reconcile(id));}
 async function approve(initial,request){
  const frozen=terms(initial);await verifyDeployment(initial.config);current();if(initial.proposal.operation!=='register')await verifyRecipient(initial.config,initial.envelope.record.owner,initial.recipientLink);
  if(initial.proposal.operation==='transfer')await verifyRecipient({...initial.config,owner:initial.proposal.toOwner,binding:digest(initial.envelope.record.to)},initial.envelope.record.to);
  const registration=initial.proposal.operation==='register';
  onProgress(registration?'Checking the bridge and obtaining its registration signature…':'Checking the reviewed transaction…');
  const p=registration?await runtime.authorizeRegistration(request.envelope):await runtime.prepare(request);current();need(terms(p)===frozen,'Amount, destination, fee or ownership changed. Review again.');
  onProgress(registration?'Signing your wallet registration…':'Signing your reviewed transaction…');
  const tx=await (registration?approveRegistrationExternal:approveExternal)(p.config,p.proposal,p.transaction.serialize(),provider),s=load(),id=addresses(p.config).position.toBase58()+':'+p.proposal.operation+':'+p.proposal.nonce;
  const previous=s.operations[id];s.operations[id]={phase:'submission-unknown',config:p.config,proposal:p.proposal,envelope:p.envelope,bytes:Buffer.from(tx.serialize()).toString('base64'),ownerSignature:bs58.encode(tx.signatures[0]),...(previous?{supersededApprovals:[...(previous.supersededApprovals??[]),{config:previous.config,proposal:previous.proposal,envelope:previous.envelope,bytes:previous.bytes,ownerSignature:previous.ownerSignature,phase:previous.phase}]}:{})};save(s);
  onProgress('Sending your saved signed transaction…');
  const result=await runtime.submit({config:p.config,proposal:p.proposal,envelope:p.envelope,ownerSigned:tx.serialize()});s.operations[id].result=result;save(s);return {...result,operationId:id};
 }
 return Object.freeze({
  async backgroundStatus(operationId){return run(async()=>{
   const s=load(),job=s.operations[operationId];need(job,'Saved owner approval required.');
   const r=await runtime.progress(operationId);current();
   need(r?.schema==='joint-progress-v3'&&r.operationId===operationId&&typeof r.accepted==='boolean'&&typeof r.backgroundEnabled==='boolean','Invalid background progress.');
   if(!r.accepted){delete job.background;save(s);return r;}
   need(r.ownerSignature===job.ownerSignature&&r.operation===job.proposal.operation&&['solana-pending','publishing','monero-pending','complete','approval-required','delayed','needs-attention'].includes(r.phase),'Background receipt differs from the saved approval.');
   need(r.checkedAt===null||Number.isSafeInteger(r.checkedAt)&&r.checkedAt>=0,'Invalid progress timestamp.');
   if(r.publication)need(/^[a-f0-9]{64}$/.test(r.publication.txid)&&typeof r.publication.confirmed==='boolean','Invalid public Monero receipt.');
   // Informational only: this cannot mark balances spendable or an approval
   // expired. Those transitions still use the independent reconciliation path.
   job.background={enabled:r.backgroundEnabled,phase:r.phase,checkedAt:r.checkedAt};
   if(r.publication)job.publication=r.publication;
   save(s);return r;
  });},
  async reviewRegistration(nonce){return run(async()=>{
   const s=load(),id=addresses(config).position.toBase58()+':register:'+nonce;
   if(s.operations[id]){const r=await reconcileSaved(s,id);need(r.retryApprovalRequired,'Saved registration needs reconciliation before replacement.');}
   let envelope=s.proofs[nonce]?.envelope;
   if(envelope)await registrationProof(envelope,nonce);
   else{envelope=await signed(record('link',nonce,{to:owner}));s.proofs[nonce]={envelope,phase:'signed'};save(s);}
   return runtime.prepare({operation:'register',envelope});
  });},
  async approveRegistration(review){return run(async()=>{const proof=load().proofs[review.proposal.nonce];need(proof&&canonical(proof.envelope)===canonical(review.envelope)&&canonical(review.config)===canonical(config)&&review.envelope.record.op==='link'&&review.envelope.record.owner===moneroSigner.address&&review.envelope.record.to===owner,'Registration differs from the saved linked-wallet proof.');return approve(review,{operation:'register',envelope:review.envelope});});},
  async reviewCredit({recipient=moneroSigner.address,amount,nonce}){return run(async()=>{const operation=recipient===moneroSigner.address?'deposit':'donate';const p=await runtime.prepare({operation,actor:owner,recipient,amount,nonce});need(p.proposal.actor===owner&&p.proposal.amount===amount&&p.envelope.record.owner===recipient&&p.envelope.record.by===owner&&p.proposal.nonce===nonce&&p.config.binding===digest(recipient),'Funding review differs from the selected recipient.');terms(p);return p;});},
  async approveCredit(review){return run(async()=>{need(['deposit','donate'].includes(review.proposal.operation)&&review.proposal.actor===owner&&review.envelope.record.by===owner&&review.config.binding===digest(review.envelope.record.owner)&&(review.proposal.operation==='donate'||canonical(review.config)===canonical(config)),'Funding account or recipient changed.');return approve(review,{operation:review.proposal.operation,actor:owner,recipient:review.envelope.record.owner,amount:review.proposal.amount,nonce:review.proposal.nonce});});},
  async publishMove({to,amount,nonce}){return run(async()=>{
   const report=await runtime.snapshot();need(report.complete===true,'Confirmed native history required.');const from=addresses(config).position.toBase58(),source=report.positions.find(p=>p.position===from);need(source?.moneroOwner===moneroSigner.address&&source.solanaOwner===owner&&BigInt(source.available)>=BigInt(amount),'Confirmed selected-wallet balance required.');
   let r;if(to){const dest=report.positions.find(p=>p.moneroOwner===to);need(dest&&dest.position!==from,'Registered recipient required.');r=record('transfer',nonce,{to,amount,from,into:dest.position});}else r=record('burn',nonce,{to:owner,amount,from});
   const envelope=await signed(r),s=load();need(!s.proofs[nonce],'Recover this saved nonce before creating another proof.');s.proofs[nonce]={envelope,phase:'publication-unknown'};save(s);const result=await runtime.publish(envelope);s.proofs[nonce].result=result;save(s);return result;
  });},
  async retryProof(nonce){return run(async()=>{const s=load(),p=s.proofs[nonce];need(p,'Saved exact native proof required.');const r=await runtime.publish(p.envelope);p.result=r;save(s);return r;});},
  async reviewMove(nonce){return run(async()=>{const s=load(),envelope=s.proofs[nonce]?.envelope;need(['transfer','burn'].includes(envelope?.record.op),'Saved holder proof required.');return runtime.prepare({operation:envelope.record.op==='transfer'?'transfer':'release',envelope});});},
  async approveMove(review){return run(async()=>{const s=load(),p=s.proofs[review.envelope.record.nonce];need(p&&canonical(p.envelope)===canonical(review.envelope)&&canonical(review.config)===canonical(config)&&review.envelope.record.from===addresses(config).position.toBase58()&&review.proposal.amount===review.envelope.record.amount,'Move differs from the saved selected-wallet proof.');return approve(review,{operation:review.proposal.operation,envelope:review.envelope});});},
  async check(operationId){return run(async()=>{const s=load();need(s.operations[operationId],'Saved owner approval required.');return reconcileSaved(s,operationId);});},
  async publishCreditOrLink(operationId){return run(async()=>{const s=load(),job=s.operations[operationId];need(job?.phase==='finalized'&&['link','credit'].includes(job.envelope.record.op),'Finalized funded receipt or link required.');const r=await runtime.publish(job.envelope);job.publication=r;save(s);return r;});},
  async retrySubmission(operationId){return run(async()=>{const s=load(),job=s.operations[operationId];need(job?.phase==='submission-unknown','Saved unresolved approval required.');await verifyDeployment(job.config);current();
   try{const r=await reconcileSaved(s,operationId);return r.pending?saveOutcome(s,operationId,await runtime.retry(operationId)):r;}catch(e){if(e.message!=='Saved public operation required.')throw e;}
   // Lost request before service journaling: reuse the exact owner approval.
   return saveOutcome(s,operationId,await runtime.submit({config:job.config,proposal:job.proposal,envelope:job.envelope,ownerSigned:Buffer.from(job.bytes,'base64')}));
  });},
  snapshot:()=>runtime.snapshot(),receipt:()=>structuredClone(load()),scope
 });
}
