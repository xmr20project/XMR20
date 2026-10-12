import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeHttpClient} from '../bridge/core-transferable/runtime-api.mjs';
const endpoint='/api/joint-transferable/Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR';
test('only the fixed503 index reason exposes a public synchronization classification',async()=>{
 let calls=0;const client=createRuntimeHttpClient({endpoint,fetcher:async()=>{calls++;return new Response(JSON.stringify({reason:'index-catch-up-required',error:'SYNTHETIC_PRIVATE_DETAIL'}),{status:503});}});
 await assert.rejects(()=>client.snapshot(),e=>e.code==='index-sync'&&/syncing recent Monero blocks/.test(e.message)&&!e.message.includes('PRIVATE'));assert.equal(calls,1);
});
test('unknown reasons, malformed bodies and other statuses retain a generic actionable error',async()=>{
 for(const [status,body] of [[503,{reason:'SYNTHETIC_PRIVATE_DETAIL',error:'SYNTHETIC_PRIVATE_DETAIL'}],[503,'<html>SYNTHETIC_PRIVATE_DETAIL</html>'],[403,{reason:'index-catch-up-required'}]]){
  const client=createRuntimeHttpClient({endpoint,fetcher:async()=>new Response(typeof body==='string'?body:JSON.stringify(body),{status})});
  await assert.rejects(()=>client.snapshot(),e=>e.code===undefined&&e.message==='Transferable service unavailable. Keep the public recovery receipt.');
 }
});
