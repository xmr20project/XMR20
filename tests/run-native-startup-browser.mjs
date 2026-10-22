// Read-only startup in a NEW empty browser profile, unmodified installed worker.
import {spawn} from 'node:child_process';
import {mkdtemp,cp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..'),ops=resolve(process.env.XMR20_STARTUP_OUTDIR||join(root,'operations/native-startup-browser')),candidate=resolve(process.env.XMR20_STARTUP_PACKAGE||join(ops,'candidate'));
if(!ops.startsWith(root+'/operations/'))throw Error('Startup evidence must be under operations.');
await mkdir(ops,{recursive:true});
const temp=await mkdtemp(join(tmpdir(),'xmr20-startup-public-')),extension=join(temp,'extension');let chrome,socket;
try{
 await cp(candidate,extension,{recursive:true});
 await writeFile(join(extension,'probe.html'),'<!doctype html><title>Public startup check</title>');
 await writeFile(join(extension,'market/native-wallet/disposable-keys.js'),`self.onmessage=async()=>{let m,p;try{importScripts('./monero-0.11.16.js');m=await monero_ts({print:()=>{},printErr:()=>{}});p=await new Promise((resolve,reject)=>m.create_keys_wallet_random(JSON.stringify({networkType:0,language:'English'}),v=>typeof v==='number'&&v>0?resolve(v):reject(Error('Disposable import failed'))));const seed=m.get_seed(p),address=m.get_address(p,0,0);await new Promise(resolve=>m.close(p,false,0,resolve));p=null;self.postMessage({seed,address});}catch{self.postMessage({error:'Disposable key generation failed'});}finally{if(p)await new Promise(resolve=>m.close(p,false,0,resolve));}};`);

 await writeFile(join(extension,'market/native-wallet/probe.js'),`self.onmessage=async()=>{try{const m=await import('./runtime.js');const r=await m.createInstalledMarketRuntime({loadKeys:async()=>{throw Error('Keys not used by this test');}});const result=await r.execute('capabilities',{});r.close();self.postMessage({result});}catch(e){self.postMessage({error:e.message,stack:e.stack});}};`);
 chrome=spawn('/Users/mark/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--disable-extensions-except='+extension,'--load-extension='+extension,'--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((res,rej)=>{let out='';const t=setTimeout(()=>rej(Error('Startup timeout')),20000);chrome.stderr.on('data',v=>{out+=v;const m=out.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}});chrome.on('error',rej);});
 socket=new WebSocket(endpoint);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});let n=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>reject(Error('CDP timeout')),30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await call('Target.createTarget',{url:'chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla/probe.html'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const evaluate=async expression=>{const v=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(v.exceptionDetails)throw Error(v.exceptionDetails.exception?.description||v.exceptionDetails.text);return v.result.value;};
 for(let i=0;i<100;i++){if(await evaluate("location.pathname==='/probe.html'&&document.readyState==='complete'"))break;await new Promise(r=>setTimeout(r,50));}
 const run=path=>evaluate(`new Promise((resolve)=>{const w=new Worker(${JSON.stringify(path)});w.onmessage=({data})=>{w.terminate();resolve(data);};w.onerror=e=>{w.terminate();resolve({error:e.message});};w.postMessage({id:'startup-public',action:'capabilities',args:{}});})`);
 const production=await run('market/native-wallet/worker.js'),diagnostic=await run('market/native-wallet/probe.js');
 const disposable=production.result?.available?await evaluate(`(async()=>{
  const material=await new Promise(resolve=>{const w=new Worker('market/native-wallet/disposable-keys.js');w.onmessage=({data})=>{w.terminate();resolve(data);};w.postMessage({});});
  if(material.error)return {error:material.error};
  const worker=new Worker('market/native-wallet/worker.js');let sequence=0;
  const send=(action,args={})=>new Promise(resolve=>{worker.onmessage=({data})=>{if(!data.progress)resolve(data);};worker.postMessage({id:'public-'+(++sequence),action,args});});
  try{
   const capabilities=await send('capabilities');
   const opened=await send('open',{context:{owner:'public-disposable',network:'mainnet',address:material.address,restoreHeight:3788000},seed:material.seed});material.seed='';
   if(opened.error)return {capabilitiesAvailable:capabilities.result?.available,opened:false,error:opened.error};
   const receipts=await send('nativeSendReceipts'),preparations=await send('operatorCreditPreparations');
   return {capabilitiesAvailable:capabilities.result?.available,opened:opened.result?.address===material.address,receiptCount:receipts.result?.length,preparationCount:preparations.result?.length,error:receipts.error||preparations.error};
  }finally{material.seed='';worker.terminate();}
 })()`):null;

 const report={ownerWalletAccess:false,keysUsed:disposable?.opened?'fresh disposable only':false,network:false,candidate,production,diagnostic,disposable};await writeFile(join(ops,'startup-verification.json'),JSON.stringify(report,null,2)+'\n');if(production.result?.available!==true||disposable?.opened!==true||disposable.receiptCount!==0||disposable.preparationCount!==0)throw Error('The actual packaged private worker failed startup acceptance. See the public-fixture report.');
 console.log('Actual packaged worker: capabilities, disposable native wallet open and empty recovery stores passed. No owner data or signing.');
}finally{socket?.close();chrome?.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));await rm(temp,{recursive:true,force:true});}
