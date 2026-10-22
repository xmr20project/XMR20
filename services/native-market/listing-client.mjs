// Public signed listing transport. A server capability never supplies private
// wallet policy. Requests persist before submission and retries reuse bytes/ID.
import {decodeOffer,encodeAction,encodeOffer,offerId,verifyAuthorization} from './native-offers/codec.mjs';
import {Buffer} from 'buffer';
const need=(v,m)=>{if(!v)throw Error(m);};
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
export function publicOffer(value){
 need(value?.offer&&value?.proof,'Signed listing missing');const offer=structuredClone(value.offer);
 for(const field of ['quantity','pricePiconero','expiresAt']){need(typeof offer[field]==='string'&&/^[0-9]{1,20}$/.test(offer[field]),'Invalid listing amount');offer[field]=BigInt(offer[field]);}
 for(const field of ['height','globalIndex']){need(typeof offer.provenance?.[field]==='string'&&/^[0-9]{1,20}$/.test(offer.provenance[field]),'Invalid listing provenance');offer.provenance[field]=BigInt(offer.provenance[field]);}
 const canonical=decodeOffer(encodeOffer(offer));need(value.id===offerId(canonical)&&verifyAuthorization(canonical,value.proof),'Listing ownership proof failed');
 return {...value,offer:canonical,proof:structuredClone(value.proof)};
}
export function createListingClient({fetcher=fetch,storage,lockManager,scope,assertCurrent=()=>{}}={}){
 const key='xmr20-native-market:public-request:'+scope;
 const actionKey=key+':seller-action';
 const current=()=>assertCurrent();
 async function exclusive(fn){
  current();const locks=lockManager??globalThis.navigator?.locks;need(typeof locks?.request==='function','Browser coordination is unavailable. Use a browser with Web Locks before publishing.');
  return locks.request(key,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is updating this wallet’s market requests. Retry here after it finishes.');current();return fn();});
 }
 const local=()=>storage??globalThis.localStorage;
 function stored(name){current();try{return local().getItem(name);}catch{throw Error('Browser storage is unavailable. Enable it before publishing a signed market request.');}}
 function save(name,value){current();try{local().setItem(name,value);need(local().getItem(name)===value,'Saved request differs');}catch{throw Error('Market retry receipt could not be saved. No request was submitted.');}}
 function acknowledged(result,body,offer){
  need(result.id===offerId(offer)&&result.receipt?.requestId===body.requestId&&Number.isSafeInteger(result.receipt.sequence)&&result.receipt.sequence>0&&/^[0-9a-f]{64}$/.test(result.receipt.hash),'Market persistence was not confirmed');
 }
 async function request(path,body,csrf,{allowUnavailable=false}={}){
  current();const response=await fetcher('/api/native-market/'+path,{method:body?'POST':'GET',credentials:'omit',redirect:'error',headers:body?{'content-type':'application/json','x-native-market-token':csrf}:{},...(body?{body:stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  current();const text=await response.text();need(text.length<=4*1024*1024,'Market response exceeds limit');const data=JSON.parse(text);need((response.ok&&!data.error)||(allowUnavailable&&response.status===503&&data.code==='replay-unavailable'&&typeof data.csrf==='string'),data.error||'Market service is unavailable.');return data;
 }
 async function retry(){
  current();const saved=stored(key);need(saved&&saved.length<=20000,'No pending listing request');const body=JSON.parse(saved);
  // Persisted public bytes are verified again. They cannot become a signing
  // request or alter the active wallet's independently approved inventory.
  const offer=decodeOffer(Buffer.from(body.offerBytes,'hex'));need(verifyAuthorization(offer,body.proof),'Saved listing signature is invalid');
  const state=await request('status');need(state.listingAvailable&&state.manifest===offer.manifest,'Native listing service is not activated for this wallet');
  const result=await request('publish',body,state.csrf);current();acknowledged(result,body,offer);
  if(stored(key)===saved)local().removeItem(key);return result;
 }
 async function retryAction(){
  const saved=stored(actionKey);need(saved&&saved.length<=24000,'No pending seller action');const record=JSON.parse(saved);
  const offer=decodeOffer(Buffer.from(record.offerBytes,'hex')),body=record.body;encodeAction(body.action);
  need(verifyAuthorization(offer,body.proof,body.action),'Saved seller action signature is invalid');
  const release=body.action.type==='signature-released';
  const state=await request(release?'session':'status');
  if(!release)need(state.listingAvailable&&state.manifest===offer.manifest,'Native listing service is not activated for this wallet');
  else need(state.journalConfigured&&state.manifest===offer.manifest,'Native signature journal is not configured for this wallet');
  const result=await request('seller-action',body,state.csrf);current();acknowledged(result,body,offer);
  if(release)need(result.signatureMayBeValid===true&&result.releasedProposalHashes?.includes(body.action.proposalHash),'Signature-release hold was not confirmed');
  // A replayed cancellation receipt remains valid even if its source has
  // since been spent. The response's current status is not the journal event.
  if(stored(actionKey)===saved)local().removeItem(actionKey);return result;
 }
 return Object.freeze({
  status:()=>request('status'),
  recoverySession:()=>request('session'),
  async offers(){const result=await request('offers');need(Array.isArray(result.offers),'Invalid market inventory');return {...result,offers:result.offers.map(publicOffer)};},
  pending(){return Boolean(stored(key));},
  pendingAction(){return Boolean(stored(actionKey));},
  publish(signed){return exclusive(async()=>{
   current();need(!stored(key),'Retry the saved listing before publishing another');need(!stored(actionKey),'Retry the saved seller action before publishing another');const offer=decodeOffer(Buffer.from(signed.offerBytes,'hex'));need(verifyAuthorization(offer,signed.proof),'Wallet returned an invalid listing');
   const body={requestId:crypto.randomUUID(),offerBytes:signed.offerBytes,proof:signed.proof},saved=stringify(body);save(key,saved);return retry();
  });},
  sellerAction({offerBytes,action,proof}){return exclusive(async()=>{
   need(!stored(actionKey),'Retry the saved seller action before signing another');const offer=decodeOffer(Buffer.from(offerBytes,'hex'));encodeAction(action);
   need(verifyAuthorization(offer,proof,action),'Wallet returned an invalid seller action');
   save(actionKey,stringify({offerBytes,body:{requestId:crypto.randomUUID(),action,proof}}));return retryAction();
  });},retry:()=>exclusive(retry),retryAction:()=>exclusive(retryAction)
 });
}
