// Disposable offline acceptance helper. Only public addresses and the signed
// test payment enter the browser; its storage key is an unrelated public fixture.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
export async function recoverOfflinePaymentInBrowser(value,address){
 const health=await fetch('http://127.0.0.1:28891/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'recovery-test',method:'get_info'}),signal:AbortSignal.timeout(5000)}).then(r=>r.json());
 assert.equal(health.result.nettype,'fakechain');assert.equal(health.result.offline,true);assert.equal(health.result.mainnet,false);
 assert.equal(health.result.incoming_connections_count,0);assert.equal(health.result.outgoing_connections_count,0);
 const root=resolve(import.meta.dirname,'..');
 const bundle=await build({stdin:{resolveDir:root,contents:`
 import {createOrdinarySpendGuard} from './src/ordinary-spend-guard.js';
 const fixture=${JSON.stringify(value)},address=${JSON.stringify(address)};
 const wallet={getPrimaryAddress:async()=>address,getPrivateSpendKey:async()=>'31'.repeat(32)};
 let guard;
 const open=async()=>{guard?.close();guard=await createOrdinarySpendGuard(wallet);};
 export async function save(){
  await open();let uncertain=false;
  const tx={getHash:()=>fixture.txid,getFullHex:()=>fixture.transaction,getInputs:()=>fixture.keyImages.map(image=>({getKeyImage:()=>({getHex:()=>image})})),getFee:()=>BigInt(fixture.feeRaw)};
  try{await guard.relay(tx,fixture,()=>{throw Error('offline reply lost');});}catch(e){if(e.message!=='offline reply lost')throw e;uncertain=true;}
  if(!uncertain)throw Error('Missing uncertain relay');guard.close();guard=null;return true;
 }
 export async function backup(){await open();const status=await guard.recoveryStatus();if(status.payments.length!==1)throw Error('Restart lost payment');const bytes=await guard.exportRecovery();guard.close();guard=null;return Array.from(bytes);}
 export async function restore(bytes){
  await open();const restored=await guard.importRecovery(Uint8Array.from(bytes));if(!restored.recoveryOnly)throw Error('Restore was not quarantined');
  const review=await guard.reviewRecovery(fixture.txid);if(review.to!==fixture.to||review.amountRaw!==fixture.amountRaw||review.feeRaw!==fixture.feeRaw)throw Error('Payment review changed');
  const result=await guard.relayRecovery(fixture.txid,async(transaction,hash)=>({transaction,hash}));
  if(!(await guard.recoveryStatus()).recoveryOnly)throw Error('Recovery released wallet');guard.close();guard=null;return result;
 }`},bundle:true,format:'esm',platform:'browser',target:'chrome120',write:false,inject:[join(root,'src/polyfill.js')],logLevel:'silent'});
 const handler=(req,res)=>{if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Offline disposable payment recovery</title>');}else res.writeHead(404).end();};
 const source=createServer(handler),destination=createServer(handler);let chrome,socket,profile;
 try{
  await new Promise(r=>source.listen(0,'127.0.0.1',r));await new Promise(r=>destination.listen(0,'127.0.0.1',r));
  profile=await mkdtemp(join(tmpdir(),'xmr20-offline-payment-'));
  chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Offline browser startup timed out')),20000);chrome.stderr.on('data',b=>{output+=b;const m=output.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.on('error',reject);chrome.on('exit',()=>{clearTimeout(timer);reject(Error('Offline browser exited'));});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map();
  socket.onmessage=({data})=>{const message=JSON.parse(data),p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}};
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('Offline browser request timed out: '+method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
  const evaluate=async(s,expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},s);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const page=async(server)=>{const url='http://127.0.0.1:'+server.address().port+'/',{targetId}=await call('Target.createTarget',{url}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
   let ready=false;for(let n=0;n<40;n++){if(await evaluate(sessionId,'location.href')===url){ready=true;break;}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);return{targetId,sessionId};};
  const first=await page(source);assert.equal(await evaluate(first.sessionId,"import('/fixture.js').then(m=>m.save())"),true);await call('Target.closeTarget',{targetId:first.targetId});
  const restarted=await page(source),bytes=await evaluate(restarted.sessionId,"import('/fixture.js').then(m=>m.backup())");await call('Target.closeTarget',{targetId:restarted.targetId});
  const other=await page(destination),restored=await evaluate(other.sessionId,"import('/fixture.js').then(m=>m.restore("+JSON.stringify(bytes)+"))");
  assert.equal(restored.transaction,value.transaction);assert.equal(restored.hash,value.txid);return restored;
 }finally{
  socket?.close();chrome?.kill();if(chrome&&chrome.exitCode===null)await new Promise(r=>{chrome.once('exit',r);setTimeout(r,5000);});
  if(chrome&&chrome.exitCode===null){chrome.kill('SIGKILL');await new Promise(r=>{chrome.once('exit',r);setTimeout(r,3000);});}
  for(const server of[source,destination]){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
  if(profile)await rm(profile,{recursive:true,force:true});
 }
}
