// UNSHIELDED-FORMAT COPY (25 Oct 2026) of research/privacy-integration-20261022/migration.mjs: the claim owner may be the unified
// token address (xmr20t1…) whose public owner key receives the PUBLIC migration credit. The earlier lab's file is unchanged.
// Legacy S5 (output-bound, deferred-image) entitlement snapshot and one-time
// plain-signature claims. Reuses the real XN1 PrototypeIndex replay and the
// successor lab's verifier of Monero's ordinary generate_signature scheme.
// The claim proves knowledge of the OLD OUTPUT KEY P only: no key image, ring
// position, native source or unspentness proof is published or required.
// Signing here uses PUBLIC fixture scalars (11/22/99) and is TEST ONLY.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PrototypeIndex} from '../../privacy-integration-20261022/legacy/xn1/replay.mjs';
import {EXPIRING_CREDIT_PROFILE,outpointKey} from '../../privacy-integration-20261022/legacy/xn1/records.mjs';
import {fixtureManifest,creditRecord,authorize,append,observation,key,keyImage,ZERO,label,nativeFixture,claimFor} from '../../privacy-integration-20261022/legacy/xn1/test-fixtures.mjs';
import {manifestId} from '../../privacy-integration-20261022/legacy/xn1/records.mjs';
import {projectLegacyRights,digest,legacyMessageHash,PROFILE,RIGHTS_POLICY} from '../../privacy-successor-20261021/model.mjs';
import {verifyLegacyAuthorization,ed25519,keccak_256} from '../../privacy-successor-20261021/signature-lab.mjs';
import {ORDER} from '../../privacy-integration-20261022/legacy/xn1/proofs.mjs';
import {le,uint} from '../../privacy-integration-20261022/legacy/xn1/bytes.mjs';
export {PROFILE,RIGHTS_POLICY,digest,legacyMessageHash,verifyLegacyAuthorization,key,keyImage,outpointKey};
const deferred={image:ZERO,c:ZERO,s:ZERO};
// lots: [{scalar, amount}] with PUBLIC fixture scalars only.
export function buildLegacy(lots,{indexer=null}={}){
 const manifest={...fixtureManifest(),cap:100000000000000000n,profile:EXPIRING_CREDIT_PROFILE,identity:0xfc};
 const index=indexer??new PrototypeIndex(manifest),credits=[];
 lots.forEach((lot,i)=>{
  // lot.pub: a wallet-derived output key (signer.mjs); lot.scalar: public fixture only.
  const P=lot.pub??key(lot.scalar);
  const credit=authorize({...creditRecord(manifest),amount:BigInt(lot.amount),epoch:720,issuance:label('issue-'+i),lock:label('lock-'+i),...deferred},{serial:10+i,outputKeys:[P,key(12)]},[],{preserveRecipientProofs:true});
  assert.equal(append(index,[observation(credit,100n+20n*BigInt(i))])[0].status,'accepted');
  credits.push({...lot,P,txid:credit.txid,lot:outpointKey({txid:credit.txid,vout:0}),outputIndex:100n+20n*BigInt(i)});
 });
 while(index.snapshot().height<11n)append(index);
 return {index,manifest,credits};
}
// An ordinary native XMR spend of the lot's output (no token record). Public
// S5 state cannot see the image; the test knows the public fixture secret.
export function strand(legacy,scalarOrImage,serial=90){
 const image=typeof scalarOrImage==='string'?scalarOrImage:keyImage(scalarOrImage);
 const bytes=nativeFixture(creditRecord(legacy.manifest),{serial,extra:Buffer.alloc(0),inputs:[{keyImage:image,offsets:Array.from({length:16},(_,i)=>100n+BigInt(i))}],outputKeys:[key(70+serial),key(71+serial)]});
 assert.equal(append(legacy.index,[{bytes,outputIndices:[900n+10n*BigInt(serial),901n+10n*BigInt(serial)]}])[0].status,'no-record');
 const state=legacy.index.snapshot();assert.ok(state.spends.has(image));
}
// Old-format MOVE of a lot by its secret x (publishes the lot's key image: the
// very disclosure the private format removes). Used only to rehearse cutover
// rules; the successor never relies on it.
export function legacyMove(legacy,credit,secretX,toPub,serial){
 const record={op:'MOVE',manifest:manifestId(legacy.manifest),claims:[claimFor(credit.txid)],allocations:[{vout:0,amount:BigInt(credit.amount),...deferred}]};
 const options={serial,outputKeys:[toPub,key(12)],inputs:[{keyImage:keyImage(secretX),offsets:Array.from({length:16},(_,i)=>credit.outputIndex+BigInt(i))},{keyImage:key(10000+serial),offsets:Array.from({length:16},(_,i)=>BigInt(i))}]};
 const move=authorize(record,options,[secretX],{preserveRecipientProofs:true});
 const result=append(legacy.index,[observation(move,5000n+20n*BigInt(serial))])[0];
 return {status:result.status,reason:result.reason??result.error??result,txid:move.txid,lot:outpointKey({txid:move.txid,vout:0}),keyImagePublished:keyImage(secretX)};
}
export const snapshot=legacy=>projectLegacyRights(legacy.index);
export const snapshotId=s=>digest(s);
// TEST-ONLY signer: accepts only the explicitly public fixture scalars.
export function publicFixtureSignature(body,scalar){
 assert.ok([11n,22n,99n].includes(BigInt(scalar)),'public fixture scalar only');
 let nonce,c,r;
 do{nonce=le(randomBytes(64))%ORDER;if(!nonce)continue;const R=ed25519.ExtendedPoint.BASE.multiply(nonce).toRawBytes();
  c=le(keccak_256(Buffer.concat([Buffer.from(legacyMessageHash(body),'hex'),Buffer.from(key(scalar),'hex'),Buffer.from(R)])))%ORDER;r=((nonce-c*BigInt(scalar))%ORDER+ORDER)%ORDER;}while(!c||!r);
 return Buffer.concat([uint(c,32),uint(r,32)]).toString('hex');
}
// signer: (messageHash, P) => signature. Use HolderSigner from signer.mjs for
// wallet-derived keys; publicFixtureSignature remains available for fixtures.
export function claim(snap,row,signer,newOwnerTokenAddress){
 const body={profile:PROFILE,manifest:snapshotId(snap),kind:'MIGRATE',claim:row.claim,amount:row.amount,owner:newOwnerTokenAddress};
 const legacySignature=typeof signer==='bigint'?publicFixtureSignature(body,signer):signer(legacyMessageHash(body),row.legacyOwner);
 return {body,legacySignature};
}
// Cutover: rights are fixed by the snapshot at the checkpoint. Lots consumed by
// an accepted old-format MOVE/BURN before the checkpoint are excluded and the
// MOVE's new lot is included; old-format activity AFTER the checkpoint is not
// honoured by the successor or the bridge. These rules cannot stop old software
// from publishing old proofs; they only decide what the successor recognises.
export function cutover(legacy){const snap=snapshot(legacy);return {snapshot:snap,registry:new Registry(snap),checkpoint:snap.checkpoint,legacyStateHash:snap.legacyStateHash};}
// Operator-side claim registry: each snapshot row is consumed at most once.
export class Registry{
 #snap;#id;#rows;#consumed=new Map();
 constructor(snap){this.#snap=snap;this.#id=snapshotId(snap);this.#rows=new Map(snap.rows.map(r=>[r.claim,r]));}
 get id(){return this.#id;}
 get rows(){return [...this.#rows.values()];}
 verify({body,legacySignature}){
  assert.equal(body.profile,PROFILE,'profile');assert.equal(body.manifest,this.#id,'snapshot');assert.equal(body.kind,'MIGRATE');
  const row=this.#rows.get(body.claim);assert.ok(row,'Unknown claim');assert.equal(body.amount,row.amount,'Claim amount must equal the snapshot row');
  assert.ok(typeof body.owner==='string'&&(body.owner.startsWith('xmr20t1')||body.owner.startsWith('penumbra')),'Token address required (xmr20t1… unified or penumbra1…)');
  assert.ok(verifyLegacyAuthorization(legacyMessageHash(body),row.legacyOwner,legacySignature),'Legacy signature rejected');
  assert.ok(!this.#consumed.has(body.claim),'Claim already consumed');
  return row;
 }
 consume(claimId,record){assert.ok(!this.#consumed.has(claimId),'Claim already consumed');this.#consumed.set(claimId,record);}
 unclaimed(){return this.rows.filter(r=>!this.#consumed.has(r.claim)).reduce((n,r)=>n+BigInt(r.amount),0n);}
 claimed(){return [...this.#consumed.values()].reduce((n,r)=>n+BigInt(r.amount),0n);}
 consumedIds(){return [...this.#consumed.keys()];}
}
