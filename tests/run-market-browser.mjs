// Opt-in browser integration check. Uses a NEW disposable Chromium profile and
// a copied public extension package. Never attaches to the user's browser.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,cp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../..');
const ops=resolve(process.env.XMR20_MARKET_BROWSER_OUTDIR||join(root,'operations/native-market-extension-20261018'));
const candidate=resolve(process.env.XMR20_MARKET_EXTENSION_OUTDIR||join(ops,'candidate'));
if(!ops.startsWith(root+'/operations/')||!candidate.startsWith(root+'/operations/'))throw Error('Use a staged candidate and evidence directory under operations.');
await mkdir(ops,{recursive:true});
const manifest=JSON.parse(await readFile(join(candidate,'manifest.json'),'utf8'));
const baseline=JSON.parse(await readFile(join(candidate,'MARKET-BASELINE.json'),'utf8'));
const candidateAppSha256=createHash('sha256').update(await readFile(join(candidate,'app.js'))).digest('hex');
assert.equal(candidateAppSha256,baseline.files['app.js'],'Market staging must preserve the installed wallet app.');
const temp=await mkdtemp(join(tmpdir(),'xmr20-market-extension-'));
const extension=join(temp,'extension'),origin='http://127.0.0.1:18941',id='jigbpnljnmbbkebaopbnnhmiafgnofla';
const extOrigin='chrome-extension://'+id;
const checks=[],errors=[];let chrome,socket;
try{
 await cp(candidate,extension,{recursive:true});
 const marketScript=join(extension,'market-entry.js');
 await writeFile(marketScript,`globalThis.fixtureWorkerEvents=[];const OriginalWorker=Worker;globalThis.Worker=class extends OriginalWorker{constructor(...args){super(...args);this.addEventListener('error',e=>fixtureWorkerEvents.push({error:e.message,file:e.filename}));this.addEventListener('message',e=>fixtureWorkerEvents.push({error:e.data?.error,available:e.data?.result?.available}));}terminate(){fixtureWorkerEvents.push({terminated:true});return super.terminate();}};\n`+await readFile(marketScript,'utf8'));
 if(process.env.XMR20_FIXTURE_DIAGNOSTICS==='1'){
  const workerPath=join(extension,'market/native-wallet/worker.js');let code=await readFile(workerPath,'utf8');
  code=code.replace('} catch {','} catch (fixtureError) { if(data.action===\'capabilities\'){self.postMessage({id:data.id,error:String(fixtureError.stack)});return;}');await writeFile(workerPath,code);
 }
 await build({stdin:{contents:'export {encryptVault} from "./src/core.js";',resolveDir:join(root,'wallet-extension')},bundle:true,format:'esm',platform:'browser',target:'chrome120',outfile:join(extension,'fixture.js'),inject:[join(root,'wallet-extension/src/polyfill.js')],logLevel:'silent'});
 await writeFile(join(extension,'fixture.html'),'<!doctype html><title>Disposable public fixture</title><body>Disposable fixture only</body>');
 chrome=spawn('/Users/mark/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--disable-extensions-except='+extension,'--load-extension='+extension,'--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'
 ],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((res,rej)=>{let s='';const t=setTimeout(()=>rej(Error('Disposable browser startup timed out')),20000);chrome.stderr.on('data',v=>{s+=v;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(t);res(m[1]);}});chrome.on('error',rej);chrome.on('exit',()=>{clearTimeout(t);rej(Error('Disposable browser exited'));});});
 socket=new WebSocket(endpoint);await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});
 let seq=0;const pending=new Map(),workers=new Map();
 socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Target.attachedToTarget'&&m.params.targetInfo.type==='worker')workers.set(m.params.sessionId,m.params.targetInfo);if(m.method==='Target.detachedFromTarget')workers.delete(m.params.sessionId);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.rej(Error(m.error.message)):p.res(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((res,rej)=>{const n=++seq,timer=setTimeout(()=>{pending.delete(n);rej(Error('Browser check timed out: '+method));},30000);pending.set(n,{res,rej,timer});socket.send(JSON.stringify({id:n,method,params,sessionId}));});
 await call('Target.setDiscoverTargets',{discover:true});
 async function attach(targetId){const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Runtime.enable',{},sessionId);return sessionId;}
 async function evaluate(s,expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},s);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
 async function waitFor(fn){const until=Date.now()+15000;while(Date.now()<until){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw Error('Browser condition timed out');}
 async function page(url){const {targetId}=await call('Target.createTarget',{url});const s=await attach(targetId);await waitFor(()=>evaluate(s,'location.href==='+JSON.stringify(url)));return {targetId,s};}
 async function target(prefix){return waitFor(async()=>{const {targetInfos}=await call('Target.getTargets');return targetInfos.find(t=>t.url.startsWith(prefix));});}
 const fixture=await page(extOrigin+'/fixture.html');
 await evaluate(fixture.s,`globalThis.fixtureSenders=[];chrome.runtime.onMessage.addListener((m,s)=>{if(m.channel==='xmr20-site-approval')fixtureSenders.push({action:m.action,frameId:s.frameId,tabId:s.tab?.id,url:s.url,id:s.id});});true`);
 // Invalid, deliberately public marker strings cannot sign either network.
 // They exercise only encrypted vault loading and public account connection.
 assert.equal(await evaluate(fixture.s,`(async()=>{const {encryptVault}=await import('./fixture.js');const password='PUBLIC DISPOSABLE FIXTURE';const box=await encryptVault({accounts:[{id:'fixture',name:'Disposable browser fixture',sol:'11111111111111111111111111111111',xmr:'4'+'1'.repeat(94),solSecret:'NOT A PRIVATE KEY',xmrSeed:'NOT A MONERO SEED'}]},password);await chrome.storage.local.set({'xmr20-vault':box});await chrome.storage.session.set({'xmr20-unlocked-session':{id:'fixture-session',password,lastActive:Date.now(),activeId:'fixture',lockSignal:null,snapshots:{}}});return true;})()`),true);
 const site=await page(origin+'/market/');
 const external=(action,args={})=>evaluate(site.s,`chrome.runtime.sendMessage(${JSON.stringify(id)},${JSON.stringify({channel:'xmr20-site',action,...args})})`);
 assert.equal((await external('ping')).value.nativeMarket,true);checks.push('installed extension advertises market capability');
 assert.ok((await external('openMarket',{market:{view:'list'}})).error);checks.push('market requires existing account connection');
 const request=(await external('connect')).value.requestId;
 const approval=await target(extOrigin+'/approval.html?request='+request),approvalSession=await attach(approval.targetId);
 await waitFor(()=>evaluate(approvalSession,`!!document.getElementById('approve')`));
 await evaluate(approvalSession,`document.getElementById('approve').click();true`);
 const connection=await waitFor(async()=>{const r=await external('result',{requestId:request});return r.value?.done?r.value:null;});
 assert.equal(connection.value.account.name,'Disposable browser fixture');assert.ok(!JSON.stringify(connection).includes('NOT A'));checks.push('real connection approval returns public scope only');
 const launch=await external('openMarket',{market:{view:'list',quantity:'100000000000',total:'120000000000'}});
 assert.equal(launch.value.opened,true);
 const market=await target(extOrigin+'/market.html?request='),marketSession=await attach(market.targetId);
 await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},marketSession);
 let loaded;
 try{loaded=await waitFor(()=>evaluate(marketSession,`document.getElementById('account-balance')?.textContent?.includes('Disposable browser fixture') && document.getElementById('listing-availability')?.textContent?.includes('conversion has not been activated')`));}
 catch(error){console.error(JSON.stringify({page:await evaluate(marketSession,'document.body.innerText'),worker:await evaluate(marketSession,'fixtureWorkerEvents'),senders:await evaluate(fixture.s,'fixtureSenders'),errors}));throw error;}
 assert.equal(loaded,true);
 const display=await evaluate(marketSession,`({quantity:document.getElementById('sell-quantity').value,price:document.getElementById('sell-price').value,total:document.getElementById('sell-total').textContent,disabled:document.querySelector('#sell-form button').disabled,error:document.getElementById('market-error').hidden?null:document.getElementById('market-error').textContent})`);
 assert.deepEqual(display,{quantity:'100000',price:'0.0000012',total:'0.12 XMR',disabled:true,error:null});
 const capability=await waitFor(()=>evaluate(marketSession,'fixtureWorkerEvents.find(e=>e.available===false)'));assert.equal(capability.available,false);
 checks.push('packaged UI and real private worker load with exact draft; activation remains closed');
 const status=await evaluate(marketSession,`fetch('/api/native-market/status').then(r=>r.json()).then(x=>({code:x.code,listing:x.listingAvailable,buying:x.purchasesAvailable}))`);
 assert.deepEqual(status,{code:'activation-unconfigured',listing:false,buying:false});checks.push('actual local service CORS and extension transport agree');
 assert.ok((await external('openMarket',{market:{view:'list'}})).error);assert.ok((await external('marketKeys')).error);assert.ok((await external('openBridge',{})).error);checks.push('duplicate market host and external key/bridge requests rejected');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false},marketSession);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},marketSession);await writeFile(join(ops,'extension-market-desktop.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},marketSession);
 const mobile=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},marketSession);await writeFile(join(ops,'extension-market-mobile.png'),Buffer.from(mobile.data,'base64'));
 await evaluate(marketSession,`document.getElementById('sell-form').scrollIntoView({block:'center'});true`);
 const formShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},marketSession);await writeFile(join(ops,'extension-market-mobile-form.png'),Buffer.from(formShot.data,'base64'));
 await external('disconnect');await waitFor(()=>evaluate(marketSession,`document.getElementById('wallet-market-error')?.textContent?.includes('locked or changed')`));
 assert.ok((await evaluate(marketSession,`chrome.runtime.sendMessage({channel:'xmr20-site-approval',action:'marketCheck',requestId:new URLSearchParams(location.search).get('request')})`)).error);
 assert.ok(await evaluate(marketSession,'fixtureWorkerEvents.some(e=>e.terminated)'));checks.push('disconnect revokes actual worker and controls');
 assert.equal(errors.filter(e=>!e.includes('Failed to fetch')).length,0,errors.join('\n'));
 const report={passed:checks.length,checks,candidate,candidateVersion:manifest.version,baselineVersion:baseline.version,candidateAppSha256,profile:'new disposable Chromium profile',publicFixture:true,mainnetKeysUsed:false,fundedTrade:false,activation:'unconfigured',display};
 await writeFile(join(ops,'browser-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
 socket?.close();chrome?.kill();if(chrome&&chrome.exitCode===null)await new Promise(res=>{chrome.once('exit',res);setTimeout(res,5000);});
 if(chrome&&chrome.exitCode===null){chrome.kill('SIGKILL');await new Promise(res=>{chrome.once('exit',res);setTimeout(res,3000);});}
 await rm(temp,{recursive:true,force:true});
}
