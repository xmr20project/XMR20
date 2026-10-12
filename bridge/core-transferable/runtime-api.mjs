import {VersionedTransaction} from '@solana/web3.js';
const need=(v,m)=>{if(!v)throw Error(m);};
const fields=(v,allowed,required=allowed)=>{need(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k)),'Unexpected transferable request fields.');};
const bytes=s=>{need(typeof s==='string'&&s.length<4000&&Buffer.from(s,'base64').toString('base64')===s,'Invalid public transaction encoding.');return Buffer.from(s,'base64');};
const serialize=p=>({...p,transaction:Buffer.from(p.transaction.serialize()).toString('base64')});
export function createRuntimeApi({runtime}){
 return async(action,input={})=>{
  if(action==='readiness'){fields(input,[]);return runtime.readiness();}
  if(action==='progress'){fields(input,['operationId']);return runtime.progress(input.operationId);}
  if(action==='snapshot'){fields(input,[]);return runtime.snapshot();}
  if(action==='prepare'){
   fields(input,['operation','envelope','actor','recipient','amount','nonce'],['operation']);
   if(['register','transfer','release'].includes(input.operation))fields(input,['operation','envelope']);else fields(input,['operation','actor','recipient','amount','nonce']);
   return serialize(await runtime.prepare(input));
  }
  if(action==='authorize-registration'){fields(input,['envelope']);return serialize(await runtime.authorizeRegistration(input.envelope));}
  if(action==='submit'){fields(input,['config','proposal','envelope','transaction']);return runtime.submit({config:input.config,proposal:input.proposal,envelope:input.envelope,ownerSigned:bytes(input.transaction)});}
  if(action==='publish'){fields(input,['envelope']);return runtime.publish(input.envelope);}
  if(action==='reconcile'){fields(input,['operationId']);return runtime.reconcile(input.operationId);}
  if(action==='retry'){fields(input,['operationId']);return runtime.retry(input.operationId);}
  throw Error('Transferable bridge method is not permitted.');
 };
}
export function createRuntimeHttpClient({fetcher=fetch,endpoint,signal}){
 need(typeof endpoint==='string'&&/^\/api\/joint-transferable\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(endpoint),'Explicit same-origin transferable mint endpoint required.');
 async function call(action,input={}){const r=await fetcher(endpoint+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});const text=await r.text();need(text.length<=1000000,'Oversized public bridge response.');
  if(!r.ok){
   // Only this fixed public classification controls automatic read-only retry.
   // Provider diagnostics and arbitrary server error text never reach the UI.
   let syncing=false;try{syncing=r.status===503&&JSON.parse(text)?.reason==='index-catch-up-required';}catch{}
   const error=Error(syncing?'Bridge syncing recent Monero blocks. Saved approvals are kept.':'Transferable service unavailable. Keep the public recovery receipt.');
   if(syncing)error.code='index-sync';throw error;
  }
  return JSON.parse(text);}
 return Object.freeze({readiness:()=>call('readiness'),progress:operationId=>call('progress',{operationId}),snapshot:()=>call('snapshot'),prepare:async i=>{const p=await call('prepare',i);return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},authorizeRegistration:async envelope=>{const p=await call('authorize-registration',{envelope});return {...p,transaction:VersionedTransaction.deserialize(bytes(p.transaction))};},submit:i=>call('submit',{config:i.config,proposal:i.proposal,envelope:i.envelope,transaction:Buffer.from(i.ownerSigned).toString('base64')}),publish:envelope=>call('publish',{envelope}),reconcile:operationId=>call('reconcile',{operationId}),retry:operationId=>call('retry',{operationId})});
}
