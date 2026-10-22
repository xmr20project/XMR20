// Public bytes and proof verification only. No wallet keys or signing API.
import {Buffer} from 'buffer';
import {checkMoneroAddress} from '../../../shared/xmr20/address.js';
import {domain, exact, hash, hex, join, need, Reader, uint} from '../xn1/bytes.mjs';
import {LOCAL_PROFILE, CIRCULATING_PROFILE, OFFLINE_RECEIVER_PROFILE, EXPIRING_CREDIT_PROFILE, outpointKey} from '../xn1/records.mjs';
import {claimMessage, publicPoint, verifyClaim} from '../xn1/proofs.mjs';

const TAG=domain('XN1-LOCAL-S2-OFFER');
const positive=value=>{need(typeof value==='bigint'&&value>0n,'Positive bigint amount required');return uint(value,8);};
const nonzero=value=>{const b=hex(value);need(b.some(x=>x!==0),'Nonzero identifier required');return b;};
export function encodeOffer(offer){
 exact(offer,['version','profile','manifest','genesis','source','outputKey','keyImage','quantity','pricePiconero','paymentAddress','expiresAt','nonce','provenance']);
 exact(offer.source,['txid','vout']);exact(offer.provenance,['recordId','height','globalIndex']);
 need(offer.version===1&&[LOCAL_PROFILE,CIRCULATING_PROFILE,OFFLINE_RECEIVER_PROFILE,EXPIRING_CREDIT_PROFILE].includes(offer.profile),'Unsupported native token offer profile');
 publicPoint(offer.outputKey);publicPoint(offer.keyImage);
 const address=checkMoneroAddress(offer.paymentAddress,'mainnet');
 // Fakechain uses mainnet address encoding; the signed genesis identifies the
 // chain. This does not enable mainnet or make an address a source-of-funds proof.
 need(address.valid&&address.kind!=='integrated','Valid standard address or subaddress required');
 need(typeof offer.expiresAt==='bigint'&&offer.expiresAt>0n,'Expiry must be a positive Unix second');
 return join(TAG,uint(1,1),uint(offer.profile,2),hex(offer.manifest),hex(offer.genesis),
  Buffer.from(outpointKey(offer.source),'hex'),hex(offer.outputKey),hex(offer.keyImage),
  positive(offer.quantity),positive(offer.pricePiconero),Buffer.from(offer.paymentAddress,'ascii'),
  uint(offer.expiresAt,8),nonzero(offer.nonce),hex(offer.provenance.recordId),
  uint(offer.provenance.height,8),uint(offer.provenance.globalIndex,8));
}
export function decodeOffer(bytes){
 const r=new Reader(bytes);need(r.take(TAG.length).equals(TAG),'Unknown offer domain');
 const offer={version:r.u(1),profile:r.u(2),manifest:r.hex(),genesis:r.hex(),source:{txid:r.hex(),vout:r.u(4)},
  outputKey:r.hex(),keyImage:r.hex(),quantity:r.u(8),pricePiconero:r.u(8),paymentAddress:r.take(95).toString('ascii'),
  expiresAt:r.u(8),nonce:r.hex(),provenance:{recordId:r.hex(),height:r.u(8),globalIndex:r.u(8)}};
 r.done();need(encodeOffer(offer).equals(Buffer.from(bytes)),'Noncanonical offer');return offer;
}
export const offerId=offer=>hash(encodeOffer(offer)).toString('hex');
export function encodeAction(action){
 need(action?.type==='cancel'||action?.type==='signature-released','Unknown seller action');
 exact(action,action.type==='cancel'?['type','offerId','nonce']:['type','offerId','nonce','proposalHash']);
 return join(domain('XN1-LOCAL-S2-OFFER-ACTION'),uint(action.type==='cancel'?1:2,1),
  hex(action.offerId),nonzero(action.nonce),...(action.type==='signature-released'?[nonzero(action.proposalHash)]:[]));
}
function proofContext(offer,action){
 encodeOffer(offer);
 if(action){need(action.offerId===offerId(offer),'Action belongs to another offer');return hash(encodeAction(action)).toString('hex');}
 return hash(domain('XN1-LOCAL-S2-OFFER-AUTH'),encodeOffer(offer)).toString('hex');
}
function proofArguments(offer,proof,action){
 exact(proof,['c','s']);hex(proof.c);hex(proof.s);
 return {manifest:offer.manifest,context:proofContext(offer,action),claim:{vin:0,ringPos:0,source:offer.source,...proof},outputKey:offer.outputKey,keyImage:offer.keyImage,op:'MOVE'};
}
// Use the existing tested DLEQ verifier unchanged. Its synthetic
// MOVE claim has a domain-separated offer/action context, never a tx context.
export function authorizationMessage(offer,action){
 const a=proofArguments(offer,{c:'00'.repeat(32),s:'00'.repeat(32)},action);
 return claimMessage(a.manifest,a.context,a.claim,a.outputKey,a.keyImage,a.op);
}
export function verifyAuthorization(offer,proof,action){
 try{return verifyClaim(proofArguments(offer,proof,action));}catch{return false;}
}
