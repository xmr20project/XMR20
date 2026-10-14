import {randomUUID,createHash} from 'node:crypto';
import * as web3 from '@solana/web3.js';
import * as token from '@solana/spl-token';
import * as metadata from '@solana/spl-token-metadata';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import bs58 from 'bs58';
import {createLaunchBuilders} from '../vendor/shared/meteora/instructions.js';
import {createQuickReview} from '../vendor/shared/meteora/quick-review.js';
import {BUY_FLOW,validateInitialSol} from '../vendor/shared/meteora/initial-buy.js';
import {XMR20_PRESET} from '../vendor/shared/meteora/preset.js';

const need=(v,code)=>{if(!v)throw Error(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const FIELDS=['flow','initialSolLamports','id','mint','creatorNft','platformNft','name','symbol','metadataHash','metadataUri'];
export class LaunchPilot {
  constructor({vault,owner,gateway,connection,signer,journal,now=Date.now,review,signal}) {
    Object.assign(this,{vault,owner,gateway,connection,signer,journal,now,signal});
    this.review=review||createQuickReview({web3,sdk,builders:createLaunchBuilders({web3,token,metadata,sdk,BN,Decimal}),connection});
  }
  get(id){const d=this.vault.state.launches?.[id];need(d?.owner===this.owner&&d.state!=='deleted','LAUNCH_NOT_FOUND');return structuredClone(d);}
  save(d){this.vault.transaction(s=>{s.launches??={};s.launches[d.id]=structuredClone(d);});return d;}
  create({name,symbol,initialSolLamports,imageBase64}) {
    need(typeof name==='string'&&name.trim()===name&&Buffer.byteLength(name)>0&&Buffer.byteLength(name)<=32&&/^[A-Z][A-Z0-9]{0,9}$/.test(symbol),'LAUNCH_DETAILS');
    validateInitialSol(initialSolLamports);
    need(typeof imageBase64==='string'&&imageBase64.length>0&&imageBase64.length<350000,'LAUNCH_IMAGE_REQUIRED');
    const mint=web3.Keypair.generate(),creator=web3.Keypair.generate(),platform=web3.Keypair.generate();
    // Only brand-new mint/position keys live here. The funded wallet key stays
    // in Turnkey. These temporary identities are saved before any remote call.
    return this.save({id:randomUUID(),owner:this.owner,mode:'xmr20',flow:BUY_FLOW,name,symbol,initialSolLamports,imageBase64,mint:mint.publicKey.toBase58(),creatorNft:creator.publicKey.toBase58(),platformNft:platform.publicKey.toBase58(),mintKey:Array.from(mint.secretKey),creatorNftKey:Array.from(creator.secretKey),platformNftKey:Array.from(platform.secretKey),state:'draft',attempt:0,bundle:[],createdAt:this.now()}).id;
  }
  async account(){const r=await this.gateway.call('meteoraAccount',{});need(Array.isArray(r?.launches),'LAUNCH_ACCOUNT');return r.launches;}
  bind(d,row){need(row?.owner===this.owner&&FIELDS.every(k=>row[k]===d[k]),'LAUNCH_BINDING');return row;}
  async prepare(id) {
    const d=this.get(id);need(!d.bundle.length&&!['signing','submitted','attention'].includes(d.state),'LAUNCH_RECOVERY_REQUIRED');
    // A zero initial buy still needs account rent and launch/network fees.
    // Check before remote preparation, preserving this saved token on failure.
    const startingBalance=await this.connection.getBalance(new web3.PublicKey(this.owner),'finalized');
    need(startingBalance>0,'LAUNCH_BALANCE_ZERO');
    let row=(await this.account()).find(r=>r.id===id);
    if(!d.metadataHash){need(!row,'LAUNCH_METADATA_MISSING');const m=await this.gateway.call('meteoraMetadata',{name:d.name,symbol:d.symbol,imageBase64:d.imageBase64});
      need(/^[a-f0-9]{64}$/.test(m?.metadataHash)&&m.metadataUri===`https://api.xmr20.org/mainnet/m/${Buffer.from(m.metadataHash,'hex').toString('base64url')}`,'LAUNCH_METADATA');
      d.metadataHash=m.metadataHash;d.metadataUri=m.metadataUri;this.save(d);
    }
    if(!row) row=await this.gateway.call('meteoraReserve',Object.fromEntries(FIELDS.map(k=>[k,d[k]])));
    this.bind(d,row);need(row.flow===BUY_FLOW,'LAUNCH_MODE');
    if(row.pool){d.row=row;d.state=row.state;this.save(d);return {complete:true,row};}
    const p=await this.gateway.call('meteoraPrepare',{id});
    if(p.pending){d.state='preparing';this.save(d);return {pending:true};}
    await this.review(row,p);
    // Cap the whole approval, not each component separately.
    need(p.review.maximumSolDebitLamports===Number(BigInt(d.initialSolLamports)+250000000n),'LAUNCH_DEBIT');
    const balance=await this.connection.getBalance(new web3.PublicKey(this.owner),'finalized');
    need(balance>=p.review.estimatedSolDebitLamports,'LAUNCH_BALANCE');
    d.row=row;d.prepared=p;d.expiresAt=this.now()+45000;d.state='review';d.attempt++;d.signingAttempt=d.attempt;this.save(d);
    return {id,mint:d.mint,name:d.name,symbol:d.symbol,initialSolLamports:d.initialSolLamports,estimatedSolDebitLamports:p.review.estimatedSolDebitLamports,maximumSolDebitLamports:p.review.maximumSolDebitLamports,minimumTokenRaw:p.minimumTokenRaw,expiresAt:d.expiresAt,attempt:d.attempt};
  }
  async approve(id,attempt) {
    const d=this.get(id);need(d.state==='review'&&d.attempt===attempt&&d.expiresAt>this.now(),'LAUNCH_REVIEW_EXPIRED');
    const row=this.bind(d,(await this.account()).find(r=>r.id===id));
    need(!row.signature&&!row.pool&&!row.receipts?.some(r=>!d.row.receipts?.some(old=>old.signature===r.signature)),'LAUNCH_STATE_CHANGED');
    const txs=await this.review(row,d.prepared);
    d.state='signing';this.save(d);
    try {
      for(let i=0;i<txs.length;i++){
        need(!this.signal?.aborted,'STOPPED');
        const tx=txs[i],step=d.prepared.items[i].step;
        need(['mint','pool'].includes(step),'LAUNCH_STEP');
        tx.sign((step==='mint'?['mintKey']:['creatorNftKey','platformNftKey']).map(k=>web3.Keypair.fromSecretKey(Uint8Array.from(d[k]))));
        const operationId=`launch:${id}:${d.signingAttempt||attempt}:${step}`,messageSha256=hash(tx.message.serialize());
        let signed;const previous=this.journal?.get(operationId);
        if(previous){
          need(previous.state==='signed'&&previous.address===this.owner&&previous.messageSha256===messageSha256&&previous.request.parameters.unsignedTransaction===Buffer.from(tx.serialize()).toString('hex'),'LAUNCH_RECONCILE');
          signed={transaction:Buffer.from(previous.receipt.signedTransactionHex,'hex')};
        }else signed=await this.signer.signReviewed({operationId,address:this.owner,transaction:Buffer.from(tx.serialize()),messageSha256,expiresAt:d.expiresAt});
        const parsed=web3.VersionedTransaction.deserialize(signed.transaction);
        const entry={step,operationId,transaction:Buffer.from(signed.transaction).toString('base64'),signature:bs58.encode(parsed.signatures[0])};
        const existing=d.bundle.find(b=>b.step===step);need(!existing||existing.transaction===entry.transaction,'LAUNCH_RECONCILE');
        if(!existing)d.bundle.push(entry);this.save(d);
      }
      // Both exact signed transactions are durable before the first send.
      need(!this.signal?.aborted,'STOPPED');
      d.state='submitted';this.save(d);
      const fresh=await this.gateway.call('meteoraSubmit',{id,transactions:d.bundle.map(b=>b.transaction)});
      this.bind(d,fresh);d.row=fresh;d.state=fresh.state;this.save(d);return fresh;
    } catch {
      // Preserve reservations/partial signatures; never produce a replacement.
      d.state='attention';this.save(d);throw Error('LAUNCH_RECONCILE');
    }
  }
  async resume(id) {
    const d=this.get(id);need(['attention','signing'].includes(d.state)&&d.prepared?.items?.length,'LAUNCH_RECOVERY_REQUIRED');
    d.signingAttempt??=d.attempt;
    for(const item of d.prepared.items){const op=`launch:${id}:${d.signingAttempt||d.attempt}:${item.step}`,record=this.journal?.get(op);if(record?.state==='reserved'){
      const result=await this.signer.reconcile(op);need(result.state==='signed','LAUNCH_RECONCILE');
    }}
    const row=this.bind(d,(await this.account()).find(r=>r.id===id));need(!row.signature&&!row.pool,'LAUNCH_STATE_CHANGED');
    await this.review(row,d.prepared);d.expiresAt=this.now()+45000;d.attempt++;d.state='review';this.save(d);
    return {id,mint:d.mint,name:d.name,symbol:d.symbol,initialSolLamports:d.initialSolLamports,estimatedSolDebitLamports:d.prepared.review.estimatedSolDebitLamports,maximumSolDebitLamports:d.prepared.review.maximumSolDebitLamports,minimumTokenRaw:d.prepared.minimumTokenRaw,expiresAt:d.expiresAt,attempt:d.attempt};
  }
  async status(id) {
    const d=this.get(id);let row=this.bind(d,(await this.account()).find(r=>r.id===id));
    if(d.bundle.length===d.prepared?.items?.length&&!row.pool&&!row.signature&&!['complete','pool-confirmed'].includes(row.state)) {
      // An ambiguous submit may be retried only with this complete exact batch.
      row=await this.gateway.call('meteoraSubmit',{id,transactions:d.bundle.map(b=>b.transaction)});
    }
    row=this.bind(d,await this.gateway.call('meteoraStatus',{id}));
    const unresolvedLocal=['attention','signing'].includes(d.state)&&d.bundle.length!==d.prepared?.items?.length;
    d.row=row;
    // A backend with no submitted batch cannot clear a local provider timeout.
    // Otherwise a harmless status click would permit replacement signing.
    if(!unresolvedLocal&&d.state!=='review')d.state=row.state;
    this.save(d);return unresolvedLocal?{...row,state:'attention',reason:'Local signing outcome requires reconciliation.'}:row;
  }
  async recover(id) {
    const d=this.get(id);need(d.state!=='signing','LAUNCH_RECONCILE');
    // Existing backend proves historical expiry/failure and unchanged accounts.
    // Local partial signatures require separate provider reconciliation first.
    need(d.bundle.length>0&&d.bundle.length===d.prepared?.items?.length,'LAUNCH_PARTIAL_APPROVAL');
    const row=this.bind(d,await this.gateway.call('meteoraRecover',{id}));
    need(d.bundle.every(b=>row.receipts?.some(r=>r.signature===b.signature)||row.recoveries?.some(r=>r.signature===b.signature)),'LAUNCH_RECOVERY_EVIDENCE');
    d.history??=[];d.history.push({bundle:d.bundle,prepared:d.prepared});d.bundle=[];d.prepared=null;d.row=row;d.state='draft';this.save(d);return row;
  }
}
export {XMR20_PRESET};
