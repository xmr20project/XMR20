// Browser negotiation transport. These ephemeral keys authenticate a mailbox;
// they are never Monero/Solana wallet keys and cannot authorize a native spend.
import {Buffer} from 'buffer';
import {exact,hex,need} from '../xn1/bytes.mjs';
import {offerId} from '../native-offers/codec.mjs';
import {publicPoint} from '../xn1/proofs.mjs';
import {LIMITS,canonical,clone,digest,decimal,sessionId,constructionSession,requestMessage,authenticated,
  advance,publicOffer,validateFinal,validateHold,validateBundle,validateAssembled} from './protocol.mjs';
import {settlementMessage,authenticateSettlement} from '../settlement/protocol.mjs';

const DATABASE='xmr20-native-trade-mailboxes-v1', STORE='mailboxes';
const KINDS=new Set(['proposal','proof','finalize','hold','signature','transaction','abort']);
const PHASES=new Set(['requested','contributed','proposed','finalized','held','signed','assembled','aborted']);
const ZERO='00'.repeat(32), encoder=new TextEncoder();
const bytesHex=b=>Buffer.from(b).toString('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const requestId=crypto=>bytesHex(crypto.getRandomValues(new Uint8Array(24)));
const boundedId=value=>need(typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value),'Invalid mailbox request identity');

function scopeValue(scope,origin){
 exact(scope,['owner','genesis','offerId','role','identity']);
 need(typeof scope.owner==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(scope.owner),'Public account identity required');
 for(const field of ['genesis','offerId','identity'])hex(scope[field]);
 need(scope.identity!==ZERO&&['buyer','seller'].includes(scope.role),'Unique mailbox identity and role required');
 const url=new URL(origin);need(url.origin===origin&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'Secure same-origin mailbox required');
 return {origin,...clone(scope)};
}
function openDatabase(indexedDB){return new Promise((resolve,reject)=>{
 let failed=false;const request=indexedDB.open(DATABASE,1);
 request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});
 request.onerror=()=>reject(Error('Trade mailbox storage is unavailable'));
 request.onblocked=()=>{failed=true;reject(Error('Close the other market tab before opening mailbox storage'));};
 request.onsuccess=()=>{if(failed){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
});}
function transaction(db,mode,id,work){return new Promise((resolve,reject)=>{
 let tx,result,failure;
 try{
  tx=db.transaction(STORE,mode,{durability:'strict'});if(mode==='readwrite')need(tx.durability==='strict','Durable browser storage is required');
  const store=tx.objectStore(STORE),read=store.get(id);
  read.onsuccess=()=>{try{result=work(read.result,store);}catch(e){failure=e;tx.abort();}};
  read.onerror=()=>{failure=Error('Trade mailbox could not be read');tx.abort();};
  tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||Error('Mailbox storage outcome is unknown; recover the saved request'));
  tx.onerror=()=>{};
 }catch(e){try{tx?.abort();}catch{}reject(e);}
});}
function storedValue(row,id,scope){
 need(row?.id===id&&same(row.scope,scope),'Mailbox account/origin scope changed');
 need(row.privateKey?.type==='private'&&row.privateKey.extractable===false&&row.privateKey.algorithm?.name==='Ed25519'&&
  row.privateKey.usages.length===1&&row.privateKey.usages[0]==='sign','Nonextractable mailbox key required');
 publicPoint(row.key);if(row.sessionId!==null)hex(row.sessionId);
 need(row.pending===null||row.pending&&Object.getPrototypeOf(row.pending)===Object.prototype,'Saved mailbox request is invalid');
 return row;
}
function receiptValue(receipt,{request,phase}={}){
 exact(receipt,['requestId','sequence','hash','sessionId','revision','phase','replayed']);
 boundedId(receipt.requestId);hex(receipt.hash);hex(receipt.sessionId);
 need(Number.isSafeInteger(receipt.sequence)&&receipt.sequence>0&&Number.isSafeInteger(receipt.revision)&&receipt.revision>0&&
  PHASES.has(receipt.phase)&&typeof receipt.replayed==='boolean','Invalid durable mailbox receipt');
 if(request)need(receipt.requestId===request.requestId&&receipt.sessionId===request.sessionId&&receipt.revision===request.revision+1,'Mailbox receipt does not acknowledge this exact request');
 if(phase)need(receipt.phase===phase,'Mailbox receipt acknowledged another transition');
 return clone(receipt);
}
function holdMarker(state){
 need(state.final&&state.hold&&['held','signed','assembled'].includes(state.phase),'An authenticated durable signature hold is required');
 const checked=validateFinal(state.final.transaction,state);need(same(checked,state.final),'Final transaction binding changed');
 const {receipt,...payload}=state.hold;validateHold(payload,state);
 exact(receipt,['requestId','sequence','hash']);need(/^trade-hold-[0-9a-f]{64}$/.test(receipt.requestId)&&Number.isSafeInteger(receipt.sequence)&&receipt.sequence>0,'Durable offer hold receipt is invalid');hex(receipt.hash);
 return {sessionId:state.id,offerId:state.offerId,signatureHash:state.final.signatureHash,receipt:clone(receipt)};
}
function readValue(value,row,scope){
 const state=clone(value);
 // State is authenticated by the fixed same-origin service. Public proofs and
 // all local identities are checked again; server flags are not spend authority.
 need(state.id===row.sessionId&&state.offerId===scope.offerId&&state[scope.role+'Key']===row.key,'Mailbox response belongs to another account or session');
 need(Number.isSafeInteger(state.revision)&&state.revision>0&&state.revision<=LIMITS.events&&PHASES.has(state.phase),'Invalid mailbox revision/state');
 decimal(state.expiresAt);publicPoint(state.buyerKey);if(state.sellerKey!==null)publicPoint(state.sellerKey);
 const offer=publicOffer(state.offerBytes,state.offerProof);need(offerId(offer)===scope.offerId&&offer.genesis===scope.genesis,'Mailbox offer changed chain or identity');
 if(state.hold||state.signatures?.buyer||state.signatures?.seller)holdMarker(state);
 if(state.signatures?.buyer)validateBundle(state.signatures.buyer,state,'buyer');
 if(state.signatures?.seller)validateBundle(state.signatures.seller,state,'seller');
 if(state.phase==='assembled'||state.assembled)need(same(validateAssembled(state.assembled?.transaction,state),state.assembled),'Assembled transaction changed');
 return state;
}

export async function openTradeMailbox({scope,csrfProvider,assertCurrent,fetcher=globalThis.fetch,origin=globalThis.location?.origin,
 crypto=globalThis.crypto,indexedDB=globalThis.indexedDB,lockManager=globalThis.navigator?.locks}={}){
 need(typeof csrfProvider==='function'&&typeof assertCurrent==='function'&&typeof fetcher==='function','Trusted CSRF, fetch and current-account checks are required');
 need(crypto?.subtle&&typeof crypto.getRandomValues==='function'&&indexedDB&&typeof lockManager?.request==='function','Browser cryptography, IndexedDB and Web Locks are required');
 const pageOrigin=globalThis.location?.origin;
 need(origin===pageOrigin||pageOrigin==='chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla'&&origin==='http://127.0.0.1:18941','Fixed wallet market transport required');
 const scoped=scopeValue(scope,origin),id=digest(scoped),lockName='xmr20-native-mailbox:'+id;
 let closed=false,db;
 const current=()=>{need(!closed,'Trade mailbox is closed');need(globalThis.location?.origin===pageOrigin,'Mailbox origin changed');const result=assertCurrent();need(result!==false&&!(result&&typeof result.then==='function'),'Active wallet account changed');};
 const after=async promise=>{const result=await promise;current();return result;};
 const readStored=()=>after(transaction(db,'readonly',id,row=>storedValue(row,id,scoped)));
 const update=work=>after(transaction(db,'readwrite',id,(row,store)=>{current();storedValue(row,id,scoped);const next=work(row);storedValue(next,id,scoped);store.put(next);return next;}));
 const exclusive=work=>{current();return lockManager.request(lockName,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is using this trade mailbox');current();return work();});};
 async function sign(unsigned,row){
  current();const signature=await after(crypto.subtle.sign('Ed25519',row.privateKey,requestMessage(unsigned)));
  return authenticated({...unsigned,signature:bytesHex(signature)});
 }
 function unsigned(row,kind,payload,revision,identity=row.sessionId){return {version:1,sessionId:identity,role:scoped.role,revision,requestId:requestId(crypto),kind,payload:clone(payload),key:row.key};}
 async function responseBody(response){
  need(response.body?.getReader,'Bounded streaming responses are required');const reader=response.body.getReader();let size=0,chunks=[];
  try{for(;;){const {done,value}=await after(reader.read());if(done)break;size+=value.byteLength;need(size<=LIMITS.requestBytes,'Mailbox response exceeds bounds');chunks.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));canonical(value);return value;
 }
 async function request(path,body){
  current();need(['submit','read','status','inbox'].includes(path),'Unknown fixed mailbox endpoint');
  const csrf=await after(Promise.resolve(csrfProvider()));need(typeof csrf==='string'&&/^[A-Za-z0-9_-]{16,256}$/.test(csrf),'Current market session token required');
  const data=canonical(body);need(encoder.encode(data).length<=LIMITS.requestBytes+64,'Mailbox request exceeds transport bounds');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try{
   const response=await after(fetcher(origin+'/api/native-market/trade/'+path,{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
    headers:{'content-type':'application/json','x-native-market-token':csrf},body:data,signal:controller.signal}));
   const value=await responseBody(response);current();
   if(!response.ok||value?.error){const error=Error('Trade mailbox request was not accepted ('+response.status+')');error.status=response.status;throw error;}
   return value;
  }finally{clearTimeout(timer);}
 }
 async function statusFor(row){
  need(row.sessionId,'Mailbox has not joined a trade');const value=await request('status',{sessionId:row.sessionId});
  need(value?.id===row.sessionId&&value.offerId===scoped.offerId&&Number.isSafeInteger(value.revision)&&value.revision>0&&PHASES.has(value.phase),'Invalid session status');
  return clone(value);
 }
 async function privateRead(row){
  const status=await statusFor(row),query=await sign(unsigned(row,'read',{},status.revision),row),state=readValue(await request('read',{request:query}),row,scoped);
  need(state.revision===status.revision,'Mailbox changed while it was being read');
  if(state.hold){const marker=holdMarker(state);await update(saved=>{need(saved.sessionId===state.id,'Mailbox changed sessions');if(saved.hold)need(same(saved.hold,marker),'Previously confirmed signature hold changed');return {...saved,hold:marker};});}
  return state;
 }
 async function finishPending(row){
  need(row.pending,'No saved mailbox request to retry');const saved=row.pending;
  if(saved.signature!==null){authenticated(saved);return row;}
  const {signature:ignored,...draft}=saved;const signed=await sign(draft,row);
  return update(currentRow=>{need(same(currentRow.pending,saved),'Pending mailbox request changed');return {...currentRow,pending:signed};});
 }
 async function retryInternal(){
  let row=await finishPending(await readStored());const saved=clone(row.pending),requestBytes=canonical(saved);
  need(saved.sessionId===row.sessionId&&saved.role===scoped.role&&saved.key===row.key,'Saved request belongs to another mailbox');
  if(saved.kind==='signature'){
   const state=await privateRead(row),marker=holdMarker(state);row=await readStored();need(same(row.hold,marker),'Signature hold was not durably recorded locally');
   need(state.final.signatureHash===marker.signatureHash&&saved.payload?.bundle,'Signature proposal changed');validateBundle(saved.payload.bundle,state,scoped.role);
  }
  const result=await request('submit',{request:saved});exact(result,['receipt']);
  const phase={create:'requested',join:'contributed',proposal:'proposed',proof:'proposed',finalize:'finalized',hold:'held',transaction:'assembled',abort:'aborted'}[saved.kind];
  const receipt=receiptValue(result.receipt,{request:saved,phase});if(saved.kind==='signature')need(['held','signed'].includes(receipt.phase),'Unexpected signature acknowledgment');
  await update(currentRow=>{need(currentRow.pending&&canonical(currentRow.pending)===requestBytes,'Pending request changed before acknowledgment');return {...currentRow,pending:null,lastReceipt:receipt};});
  return {receipt};
 }
 async function reserve(row,draft){
  requestMessage(draft);need(!row.pending,'Retry the saved mailbox request before sending another');
  return update(saved=>{need(!saved.pending&&saved.sessionId===row.sessionId,'Mailbox request or session changed');need(!saved.sessionId||saved.sessionId===draft.sessionId,'Mailbox key cannot be rebound to another trade');return {...saved,sessionId:draft.sessionId,pending:{...draft,signature:null}};});
 }
 async function mutation({revision,kind,payload}){
  need(KINDS.has(kind),'Use create/join to bind a new mailbox');const row=await readStored();need(!row.pending,'Retry the saved mailbox request first');
  const state=await privateRead(row);need(revision===state.revision,'Trade revision changed; review the latest state');
  const draft=unsigned(row,kind,payload,revision),signed=await sign(draft,row);
  // Local protocol validation is redundant with the service. It stops malformed
  // mailbox requests from becoming durable retry work before any network write.
  advance(state,signed,BigInt(Math.floor(Date.now()/1000)),{holdReceipt:kind==='hold'?{requestId:'preflight',sequence:1,hash:ZERO}:null});
  if(kind==='signature'){const marker=holdMarker(state);need(same((await readStored()).hold,marker),'Confirmed hold is missing');}
  await reserve(row,draft);return retryInternal();
 }
 current();
 try{
  db=await openDatabase(indexedDB);current();
  await exclusive(async()=>{
   let row=await after(transaction(db,'readonly',id,value=>value));
   if(!row){
    const pair=await after(crypto.subtle.generateKey('Ed25519',false,['sign','verify']));
    const publicBytes=await after(crypto.subtle.exportKey('raw',pair.publicKey));
    const fresh={id,scope:scoped,key:bytesHex(publicBytes),privateKey:pair.privateKey,sessionId:null,pending:null,hold:null,lastReceipt:null};
    row=await after(transaction(db,'readwrite',id,(existing,store)=>{current();need(!existing,'Mailbox key was created concurrently');storedValue(fresh,id,scoped);store.add(fresh);return fresh;}));
   }
   storedValue(row,id,scoped);
   const challenge=encoder.encode('XMR20-MAILBOX-KEY-CHECK\0'+id+requestId(crypto));
   const signature=await after(crypto.subtle.sign('Ed25519',row.privateKey,challenge));
   const key=await after(crypto.subtle.importKey('raw',hex(row.key),'Ed25519',false,['verify']));
   need(await after(crypto.subtle.verify('Ed25519',key,signature,challenge)),'Persisted mailbox key does not match its identity');
  });
 }catch(e){db?.close();closed=true;throw e;}
 return Object.freeze({
  identity:()=>exclusive(async()=>{const row=await readStored();return {key:row.key,sessionId:row.sessionId,scope:clone(scoped)};}),
  pending:()=>exclusive(async()=>{const row=await readStored();return row.pending?{kind:row.pending.kind,requestId:row.pending.requestId,sessionId:row.pending.sessionId,revision:row.pending.revision,signed:row.pending.signature!==null}:null;}),
  create:({expiresAt})=>exclusive(async()=>{
   const row=await readStored();need(scoped.role==='buyer'&&!row.sessionId&&!row.pending,'Buyer mailbox is already bound');
   const expires=decimal(expiresAt),now=BigInt(Math.floor(Date.now()/1000));need(expires>now&&expires<=now+BigInt(LIMITS.sessionSeconds),'Trade request expiry is outside the permitted window');
   const payload={offerId:scoped.offerId,buyerKey:row.key,nonce:scoped.identity,expiresAt};const identity=sessionId(payload);
   await reserve(row,unsigned(row,'create',payload,0,identity));return retryInternal();
  }),
  join:value=>{const {sessionId:identity,revision,contribution}=clone(value);return exclusive(async()=>{
   const row=await readStored();need(scoped.role==='seller'&&!row.sessionId&&!row.pending,'Seller mailbox is already bound');hex(identity);
   need(contribution?.session===constructionSession(identity,row.key),'Contribution is not bound to this seller mailbox');
   await reserve(row,unsigned(row,'join',{contribution},revision,identity));return retryInternal();
  });},
  submit:value=>{const captured=clone(value);return exclusive(()=>mutation(captured));},
  retry:()=>exclusive(retryInternal),
  rebasePending:()=>exclusive(async()=>{
   try{return await retryInternal();}catch(e){if(e.status!==400)throw e;}
   const row=await readStored(),prior=row.pending;need(prior&&KINDS.has(prior.kind),'Creation/join must retain their exact original request');
   const state=await privateRead(row);need(state.revision>prior.revision,'No newer authenticated revision is available');
   const draft=unsigned(row,prior.kind,prior.payload,state.revision),signed=await sign(draft,row);
   advance(state,signed,BigInt(Math.floor(Date.now()/1000)),{holdReceipt:prior.kind==='hold'?{requestId:'preflight',sequence:1,hash:ZERO}:null});
   await update(saved=>{need(same(saved.pending,prior),'Pending request changed while rebasing');return {...saved,pending:{...draft,signature:null}};});
   return retryInternal();
  }),
  read:()=>exclusive(async()=>privateRead(await readStored())),
  settlementAuthorization:value=>{const captured=clone(value);return exclusive(async()=>{
   exact(captured,['action','requestId']);need(['broadcast','rebroadcast','status'].includes(captured.action),'Unknown settlement operation');boundedId(captured.requestId);
   const row=await readStored(),state=await privateRead(row);
   need(state.phase==='assembled'&&state.assembled,'An authenticated assembled transaction is required');
   const verified=validateAssembled(state.assembled.transaction,state);need(same(verified,state.assembled),'Assembled transaction binding changed');
   const unsigned={version:1,sessionId:row.sessionId,role:scoped.role,key:row.key,revision:state.revision,requestId:captured.requestId,action:captured.action,txid:verified.txid,signatureHash:verified.signatureHash};
   const signature=await after(crypto.subtle.sign('Ed25519',row.privateKey,settlementMessage(unsigned)));
   return authenticateSettlement({...unsigned,signature:bytesHex(signature)});
  });},
  status:()=>exclusive(async()=>statusFor(await readStored())),
  inbox:()=>exclusive(async()=>{const result=await request('inbox',{offerId:scoped.offerId});need(Array.isArray(result)&&result.length<=LIMITS.perOffer,'Invalid offer mailbox inbox');for(const entry of result){hex(entry.id);publicPoint(entry.buyerKey);need(entry.offerId===scoped.offerId&&entry.revision===1,'Inbox belongs to another offer');decimal(entry.expiresAt);}return clone(result);}),
  close:()=>{closed=true;db.close();}
 });
}
