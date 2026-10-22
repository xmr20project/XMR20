// Explicit submission of a previously assembled native transaction. These
// durable authorizations contain no native wallet key or transaction builder.
import {Buffer} from 'buffer';
import {exact,hex,need} from '../xn1/bytes.mjs';
import {publicPoint} from '../xn1/proofs.mjs';
import {canonical,clone,digest,decimal} from './protocol.mjs';
import {authenticateSettlement} from '../settlement/protocol.mjs';

const DATABASE='xmr20-native-settlement-requests-v1',STORE='requests';
const LIMIT=32768,encoder=new TextEncoder();
const STATUSES=new Set(['assembled','submission-unknown','accepted','mempool','confirming','confirmed','mature','rejected','invalid-allocation','unavailable']);
const same=(a,b)=>canonical(a)===canonical(b);
function identityValue(value,origin){
 exact(value,['key','sessionId','scope']);publicPoint(value.key);hex(value.sessionId);
 exact(value.scope,['origin','owner','genesis','offerId','role','identity']);
 need(value.scope.origin===origin&&['buyer','seller'].includes(value.scope.role),'Settlement mailbox origin or role changed');
 for(const field of ['genesis','offerId','identity'])hex(value.scope[field]);
 need(typeof value.scope.owner==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value.scope.owner),'Public linked wallet identity required');
 const url=new URL(origin);need(url.origin===origin&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'Secure same-origin settlement required');
 return clone(value);
}
function authorization(value,identity,action){
 const r=authenticateSettlement(value);need(r.sessionId===identity.sessionId&&r.role===identity.scope.role&&r.key===identity.key&&r.action===action,'Settlement authorization belongs to another mailbox or operation');return r;
}
export function validateSettlementResponse(value,request){
 const required=['sessionId','txid','signatureHash','requestId','requestDigest','status','confirmed','mature','tokenAllocated','confirmations','requiredMaturityBlocks','submissionAttempted'];
 need(value&&typeof value==='object'&&!Array.isArray(value),'Typed settlement response required');
 exact(value,[...required,...['receipt','checkpoint','height','reason'].filter(k=>Object.hasOwn(value,k))]);
 need(value.requestId===request.requestId&&value.requestDigest===digest(request)&&value.sessionId===request.sessionId&&value.txid===request.txid&&value.signatureHash===request.signatureHash,'Settlement response does not acknowledge this exact transaction');
 need(STATUSES.has(value.status)&&['confirmed','mature','tokenAllocated','submissionAttempted'].every(k=>typeof value[k]==='boolean'),'Invalid settlement status');
 const confirmations=decimal(value.confirmations),maturity=decimal(value.requiredMaturityBlocks);
 need(maturity>0n&&(!value.confirmed||value.tokenAllocated&&confirmations>0n)&&(!value.mature||value.confirmed&&confirmations>=maturity),'Inconsistent native settlement confirmation');
 need((value.status==='confirmed'||value.status==='mature')===value.confirmed&&(value.status==='mature')===value.mature&&value.tokenAllocated===value.confirmed,'Native acceptance is not token settlement');
 if(Object.hasOwn(value,'height'))decimal(value.height);
 if(Object.hasOwn(value,'checkpoint'))hex(value.checkpoint);
 if(Object.hasOwn(value,'reason'))need(typeof value.reason==='string'&&value.reason.length<=240,'Settlement reason exceeds bounds');
 if(Object.hasOwn(value,'receipt')){
  const receipt=value.receipt;exact(receipt,['requestId','requestDigest','attempts','outcome']);
  need(value.submissionAttempted&&['broadcast','rebroadcast'].includes(request.action)&&receipt.requestId===request.requestId&&receipt.requestDigest===digest(request)&&Number.isSafeInteger(receipt.attempts)&&receipt.attempts>0&&['accepted','submission-unknown','rejected'].includes(receipt.outcome),'Native submission receipt changed');
 }
 return clone(value);
}

function storedValue(row,id,identity){
 exact(row,['id','identity','broadcast','receipt',...(Object.hasOwn(row,'history')?['history']:[])]);need(row.id===id&&same(row.identity,identity),'Settlement storage scope changed');
 need(row.broadcast===null||row.broadcast&&typeof row.broadcast==='object','Saved settlement request is invalid');
 if(row.broadcast){need(['broadcast','rebroadcast'].includes(row.broadcast.action),'Saved native submission action is invalid');authorization(row.broadcast,identity,row.broadcast.action);}
 need(row.receipt===null||row.broadcast,'Settlement acknowledgment has no saved request');
 if(row.receipt!==null)validateSettlementResponse(row.receipt,row.broadcast);
 const history=row.history??[];need(Array.isArray(history)&&history.length<=7,'Settlement submission history exceeds bounds');
 const ids=new Set();for(const entry of history){exact(entry,['request','receipt']);need(['broadcast','rebroadcast'].includes(entry.request?.action),'Saved historical action is invalid');authorization(entry.request,identity,entry.request.action);validateSettlementResponse(entry.receipt,entry.request);need(!ids.has(entry.request.requestId),'Duplicate saved submission identity');ids.add(entry.request.requestId);}
 if(row.broadcast){need(!ids.has(row.broadcast.requestId),'Current submission duplicates acknowledged history');for(const entry of history)need(entry.request.txid===row.broadcast.txid&&entry.request.signatureHash===row.broadcast.signatureHash,'Historical native transaction changed');}
 need(!history.length||row.broadcast,'Submission history lost its current transaction');
 return {...row,history};
}
function openDatabase(indexedDB){return new Promise((resolve,reject)=>{
 let failed=false;const request=indexedDB.open(DATABASE,1);
 request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});
 request.onerror=()=>reject(Error('Settlement recovery storage is unavailable'));
 request.onblocked=()=>{failed=true;reject(Error('Close other market tabs before opening settlement recovery'));};
 request.onsuccess=()=>{if(failed){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
});}
function transaction(db,mode,id,work){return new Promise((resolve,reject)=>{
 let tx,result,failure;
 try{
  tx=db.transaction(STORE,mode,{durability:'strict'});if(mode==='readwrite')need(tx.durability==='strict','Durable settlement storage is required');
  const store=tx.objectStore(STORE),read=store.get(id);
  read.onsuccess=()=>{try{result=work(read.result,store);}catch(e){failure=e;tx.abort();}};
  read.onerror=()=>{failure=Error('Settlement recovery could not be read');tx.abort();};
  tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||Error('Settlement storage outcome is unknown; retain this browser data'));tx.onerror=()=>{};
 }catch(e){try{tx?.abort();}catch{}reject(e);}
});}

export async function openTradeSettlement({mailbox,csrfProvider,assertCurrent,fetcher=globalThis.fetch,origin=globalThis.location?.origin,
 crypto=globalThis.crypto,indexedDB=globalThis.indexedDB,lockManager=globalThis.navigator?.locks}={}){
 need(typeof mailbox?.identity==='function'&&typeof mailbox?.settlementAuthorization==='function'&&typeof csrfProvider==='function'&&typeof assertCurrent==='function'&&typeof fetcher==='function','Typed mailbox, CSRF and active-account checks are required');
 need(typeof crypto?.getRandomValues==='function'&&indexedDB&&typeof lockManager?.request==='function','Durable browser storage and Web Locks are required');
 const pageOrigin=globalThis.location?.origin;let closed=false,db;
 need(origin===pageOrigin||pageOrigin==='chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla'&&origin==='http://127.0.0.1:18941','Fixed wallet market transport required');
 const current=()=>{need(!closed,'Settlement client is closed');need(globalThis.location?.origin===pageOrigin,'Settlement origin changed');const value=assertCurrent();need(value!==false&&!(value&&typeof value.then==='function'),'Active wallet account changed');};
 const after=async promise=>{const result=await promise;current();return result;};
 current();const identity=identityValue(await after(mailbox.identity()),origin),id=digest(identity),lockName='xmr20-native-settlement:'+id;
 const exclusive=work=>{current();return lockManager.request(lockName,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is submitting this trade');current();return work();});};
 const readStored=()=>after(transaction(db,'readonly',id,row=>storedValue(row,id,identity)));
 const update=work=>after(transaction(db,'readwrite',id,(row,store)=>{current();const next=work(storedValue(row,id,identity));storedValue(next,id,identity);store.put(next);return next;}));
 const requestId=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
 async function responseBody(response){
  need(response.body?.getReader,'Bounded settlement responses are required');const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await after(reader.read());if(done)break;size+=value.byteLength;need(size<=LIMIT,'Settlement response exceeds bounds');chunks.push(value);}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));canonical(value);return value;
 }
 async function post(path,signed){
  current();need(['broadcast','rebroadcast','settlement'].includes(path),'Unknown fixed settlement endpoint');
  const csrf=await after(Promise.resolve(csrfProvider()));need(typeof csrf==='string'&&/^[A-Za-z0-9_-]{16,256}$/.test(csrf),'Current market session token required');
  const body=canonical({request:signed});need(encoder.encode(body).length<=4096,'Settlement request exceeds bounds');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try{
   const response=await after(fetcher(origin+'/api/native-market/trade/'+path,{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{'content-type':'application/json','x-native-market-token':csrf},body,signal:controller.signal}));
   const value=await responseBody(response);current();
   if(!response.ok||value?.error){const error=Error('Native settlement request was not accepted ('+response.status+')');error.status=response.status;throw error;}
   return value;
  }finally{clearTimeout(timer);}
 }
 async function authorize(action){
  current();const result=await after(mailbox.settlementAuthorization({action,requestId:requestId()}));return authorization(result,identity,action);
 }

 async function retryInternal(){
  const row=await readStored();need(row.broadcast,'No saved native transaction submission to retry');const signed=authorization(row.broadcast,identity,row.broadcast.action);
  const response=validateSettlementResponse(await post(signed.action,signed),signed);
  await update(saved=>{need(same(saved.broadcast,signed),'Saved native submission changed');return {...saved,receipt:response};});return response;
 }
 try{
  db=await openDatabase(indexedDB);current();await exclusive(()=>after(transaction(db,'readwrite',id,(row,store)=>{
   current();if(row)return storedValue(row,id,identity);const fresh={id,identity,broadcast:null,receipt:null,history:[]};store.add(fresh);return fresh;
  })));
 }catch(e){db?.close();closed=true;throw e;}
 return Object.freeze({
  broadcast:()=>exclusive(async()=>{
   let row=await readStored();if(!row.broadcast){const signed=await authorize('broadcast');row=await update(saved=>{need(!saved.broadcast,'Native submission was created concurrently');return {...saved,broadcast:signed};});}
   return retryInternal();
  }),
  rebroadcast:()=>exclusive(async()=>{
   const row=await readStored();need(!row.broadcast||row.receipt,'Retry the unacknowledged native submission before rebroadcast');need(row.history.length<7,'Native rebroadcast history limit reached; preserve recovery data');
   const signed=await authorize('rebroadcast');if(row.broadcast)need(signed.txid===row.broadcast.txid&&signed.signatureHash===row.broadcast.signatureHash&&signed.requestId!==row.broadcast.requestId&&!row.history.some(e=>e.request.requestId===signed.requestId),'Rebroadcast must retain the exact transaction with a new request identity');
   await update(saved=>{need(same(saved.broadcast,row.broadcast)&&same(saved.receipt,row.receipt)&&same(saved.history,row.history),'Native submission changed before rebroadcast');return {...saved,history:saved.broadcast?[...saved.history,{request:saved.broadcast,receipt:saved.receipt}]:saved.history,broadcast:signed,receipt:null};});
   return retryInternal();
  }),
  retry:()=>exclusive(retryInternal),
  pending:()=>exclusive(async()=>{const row=await readStored();return row.broadcast&&(!row.receipt||row.receipt.receipt?.outcome==='submission-unknown'||row.receipt.status==='submission-unknown')?{requestId:row.broadcast.requestId,sessionId:row.broadcast.sessionId,txid:row.broadcast.txid,signatureHash:row.broadcast.signatureHash,acknowledged:row.receipt!==null}:null;}),
  status:()=>exclusive(async()=>{
   const row=await readStored(),signed=await authorize('status');
   if(row.broadcast)need(signed.txid===row.broadcast.txid&&signed.signatureHash===row.broadcast.signatureHash,'Assembled transaction changed after submission');
   return validateSettlementResponse(await post('settlement',signed),signed);
  }),
  close(){closed=true;db?.close();}
 });
}
