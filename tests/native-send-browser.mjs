// Local fixture only: a fresh Chromium profile, no user wallet or internet.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const redemption=process.argv.includes('--redemption');
const conversion=process.argv.includes('--conversion');
const root=resolve(import.meta.dirname,'../..'),out=process.env.XMR20_NATIVE_UI_OUTDIR||join(root,'operations/codex-operator-native-release-20261020/'+(conversion?'native-conversion-ui':redemption?'native-redemption-ui':'native-send-ui'));
const packagePath=process.env.XMR20_NATIVE_UI_PACKAGE;
const temp=await mkdtemp(join(tmpdir(),'xmr20-public-send-ui-'));await mkdir(out,{recursive:true});
let chrome,socket,server;
try{
 await build({entryPoints:[join(import.meta.dirname,conversion?'native-conversion-browser.fixture.js':redemption?'native-redemption-browser.fixture.js':'native-send-browser.fixture.js')],outfile:join(temp,'fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',inject:[join(root,'wallet-extension/src/polyfill.js')],logLevel:'silent'});
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(!['/','/fixture.js','/fixture.css'].includes(path)){res.writeHead(404).end();return;}
  if(path==='/fixture.css'&&packagePath){res.setHeader('content-type','text/css');return res.end(await readFile(join(packagePath,'style.css'),'utf8')+'\n'+await readFile(join(packagePath,'market-entry.css'),'utf8'));}
  res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(path==='/'?'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public native send fixture</title><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script><body class="native-popup-root"></body></html>':await readFile(join(temp,path.slice(1))));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 chrome=spawn('/Users/mark/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'
 ],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((res,rej)=>{let s='';const timer=setTimeout(()=>rej(Error('Browser startup timeout')),20000);chrome.stderr.on('data',v=>{s+=v;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);res(m[1]);}});chrome.on('error',rej);});
 socket=new WebSocket(endpoint);await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});let seq=0;const pending=new Map(),errors=[];
 socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const evaluate=async(s,expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},s);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const wait=async(s,expression)=>{for(let i=0;i<240;i++){if(await evaluate(s,expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Fixture condition timeout: '+expression);};
 async function open(mode=''){
  const {targetId}=await call('Target.createTarget',{url:origin+'/?mode='+mode}),{sessionId:s}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Runtime.enable',{},s);await wait(s,'globalThis.fixture?.ready');return s;
 }
 async function shot(s,name,width,height){
  await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500},s);
  assert.equal(await evaluate(s,'document.documentElement.scrollWidth<=innerWidth'),true,name+' overflow');
  const geometry=await evaluate(s,`(()=>{const a=document.querySelector('.native-send-actions'),r=a?.getBoundingClientRect(),f=document.querySelector('.native-send-footer')?.getBoundingClientRect(),amount=document.querySelector('.native-send-amount')?.getBoundingClientRect(),select=document.querySelector('select')?.getBoundingClientRect();return {actions:!r||(r.top>=0&&r.bottom<=innerHeight),footer:!f||(f.top>=0&&f.bottom<=innerHeight),sameHeight:!amount||!select||Math.abs(amount.height-select.height)<1};})()`);
  assert.equal(geometry.actions,true,name+' action footer must be visible');assert.equal(geometry.footer,true,name+' status footer must be visible');assert.equal(geometry.sameHeight,true,name+' amount matches selector height');
  const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},s);await writeFile(join(out,name+'.png'),Buffer.from(data,'base64'));
 }
 // The ready form, including its fee and destination, fits the 360x600 popup without scrolling.
 async function fits(s,name){
  await call('Emulation.setDeviceMetricsOverride',{width:360,height:600,deviceScaleFactor:1,mobile:true},s);
  const box=await evaluate(s,'(()=>{const el=document.querySelector(".native-send-scroll");return {scroll:el.scrollHeight,client:el.clientHeight};})()');
  assert.ok(box.scroll<=box.client+1,name+' must fit without scrolling: '+JSON.stringify(box));
 }
 const s=await open();assert.equal(await evaluate(s,'document.querySelector("input").value'),'', 'amount must not default to Max');
 assert.equal(await evaluate(s,'document.querySelector("input").placeholder'),'0');await shot(s,'empty-390',390,844);await shot(s,'empty-460',460,900);
 if(conversion){
  await evaluate(s,'document.querySelector("[data-max]").click()');await wait(s,'document.querySelector("input").value==="7.53M"&&!document.querySelector("[data-next]").disabled');
  assert.equal(await evaluate(s,'fixture.calls.some(c=>["prepare","holder-sign","sign"].includes(c.name))'),false,'typing and Max must not reserve or sign');
  await shot(s,'ready-360',360,600);await fits(s,'Bridge to Monero');await shot(s,'ready-short-390',390,480);
  await evaluate(s,'fixture.holdSync=true;document.querySelector("[data-next]").click();document.querySelector("[data-next]").click()');await wait(s,'!!fixture.finishSync');
  assert.equal(await evaluate(s,'fixture.calls.some(c=>c.name==="holder-sign")'),false);
  await shot(s,'syncing-360',360,600);
  await evaluate(s,'fixture.holdSync=false;fixture.finishSync()');await wait(s,'fixture.calls.some(c=>c.name==="holder-sign")');
  assert.equal(await evaluate(s,'fixture.calls.find(c=>c.name==="prepare").value.amount'),'7530668912636');
  assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="holder-sign").length'),1);
  assert.equal(await evaluate(s,'fixture.calls.some(c=>c.name==="sign")'),false,'Monero credit waits for custody');
  await evaluate(s,'fixture.custodyConfirmed=true');await wait(s,'fixture.calls.some(c=>c.name==="publish")');
  assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="sign").length'),1,'same approval completes matching Monero credit');
  await shot(s,'confirming-360',360,600);
  // A post-approval verification failure closes the worker. Resume reopens
  // and refreshes the exact preparation without another custody signature.
  const failed=await open('setup');await wait(failed,'!document.querySelector("[data-next]").disabled');
  await evaluate(failed,'fixture.failCreditVerification=true;document.querySelector("[data-next]").click()');
  await wait(failed,'fixture.calls.some(c=>c.name==="holder-sign")');
  assert.equal(await evaluate(failed,'document.querySelector(".native-send-elapsed").hidden'),false,'network wait retains spinner');
  await shot(failed,'custody-waiting-360',360,600);
  await evaluate(failed,'fixture.custodyConfirmed=true;document.querySelector("[data-check]").click()');
  await wait(failed,'!document.querySelector(".native-send-error").hidden');
  assert.equal(await evaluate(failed,'fixture.workerLocked'),true);
  assert.equal(await evaluate(failed,'document.querySelector(".native-send-elapsed").hidden'),true,'error stops spinner');
  assert.deepEqual(await evaluate(failed,'[...document.querySelectorAll(".native-send-actions button")].map(b=>b.getBoundingClientRect().height)'),[48,48]);
  assert.equal(await evaluate(failed,'document.querySelector("[data-resume]").textContent'),'Resume');
  await shot(failed,'saved-bridge-error-360',360,600);await shot(failed,'saved-bridge-error-short',390,480);
  await evaluate(failed,'document.querySelector("[data-resume]").click()');await wait(failed,'fixture.calls.some(c=>c.name==="publish")');
  assert.equal(await evaluate(failed,'fixture.calls.filter(c=>c.name==="holder-sign").length'),1);
  assert.equal(await evaluate(failed,'fixture.calls.filter(c=>c.name==="prepare").length'),1);
  assert.equal(await evaluate(failed,'fixture.calls.filter(c=>c.name==="sign").length'),1);
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},failed);
  assert.equal(await evaluate(failed,'getComputedStyle(document.querySelector(".native-send-elapsed"),"::before").animationName'),'none');
  await evaluate(failed,'fixture.close()');
  const setup=await open('setup');await wait(setup,'!document.querySelector("[data-next]").disabled');
  assert.equal(await evaluate(setup,'document.querySelector("input")'),null,'setup needs no amount entry');
  assert.equal(await evaluate(setup,'document.querySelector("[data-next]").textContent'),'Enable Monero sends');
  assert.equal(await evaluate(setup,'document.querySelector("[data-setup-amount]").textContent'),'7.53M EXTREMIST');
  assert.equal(await evaluate(setup,'document.querySelector("[data-setup-amount]").title'),'7530668.912636 EXTREMIST');
  assert.equal(await evaluate(setup,'fixture.calls.some(c=>["prepare","holder-sign","sign"].includes(c.name))'),false);
  await shot(setup,'setup-short-390',390,480);
  await evaluate(setup,'document.querySelector("[data-next]").click()');await wait(setup,'fixture.calls.some(c=>c.name==="holder-sign")');
  await evaluate(setup,'fixture.custodyConfirmed=true;fixture.confirmed=true');await wait(setup,'fixture.calls.some(c=>c.name==="complete")');
  assert.equal(await evaluate(setup,'fixture.calls.filter(c=>c.name==="complete").length'),1);
  // Funding gates are read-only: a 19-confirmation boundary, a more recent
  // ordinary XMR balance, and protected reservations never prompt a signature.
  for(const [name,override,heading] of [
   ['confirming',{ready:false,reason:'confirming',availableRaw:'0',lockedRaw:'8000000000',blocksRemaining:'1'},'XMR is confirming'],
   ['recent',{ready:false,reason:'insufficient',totalRaw:'0',availableRaw:'0',nativeBalance:{balanceRaw:'8000000000',unlockedRaw:'8000000000'}},'XMR is confirming'],
   ['reserved',{ready:false,reason:'reserved',availableRaw:'0',reservedRaw:'8000000000'},'XMR is reserved']
  ]){
   const f=await open('setup');await wait(f,'!document.querySelector("[data-next]").disabled');
   assert.equal(await evaluate(f,'document.body.textContent.includes("Enable these tokens once")'),false,'removed introduction');
   await evaluate(f,'fixture.fundingOverride='+JSON.stringify(override)+';document.querySelector("[data-next]").click()');
   await wait(f,'!!document.querySelector("[data-funding-check]")&&!document.querySelector("[data-funding-check]").disabled');
   assert.equal(await evaluate(f,'document.querySelector("h2").textContent'),heading);
   assert.equal(await evaluate(f,'fixture.calls.some(c=>["prepare","holder-sign","sign"].includes(c.name))'),false);
   await shot(f,'funding-'+name+'-short',390,480);
   if(name==='confirming'){
    assert.equal(await evaluate(f,'document.querySelector(".native-send-fields").textContent.includes("0.008 XMR")'),true);
    const unlocks=await evaluate(f,'fixture.calls.filter(c=>c.name==="unlock").length');
    await evaluate(f,'fixture.fundingOverride={ready:true};document.querySelector("[data-funding-check]").click()');
    await wait(f,'!!document.querySelector("[data-next]")&&!document.querySelector("[data-next]").disabled');
    assert.equal(await evaluate(f,'fixture.calls.filter(c=>c.name==="unlock").length'),unlocks+1,'funding retry reopens wallet');
    assert.equal(await evaluate(f,'fixture.calls.some(c=>["prepare","holder-sign","sign"].includes(c.name))'),false,'funding retry never approves');
    assert.equal(await evaluate(f,'document.querySelector("[data-setup-amount]").title'),'7530668.912636 EXTREMIST');
    await evaluate(f,'document.querySelector("[data-next]").click()');await wait(f,'fixture.calls.some(c=>c.name==="holder-sign")');
    assert.equal(await evaluate(f,'fixture.calls.find(c=>c.name==="prepare").value.amount'),'7530668912636');
   }
  }
  const retry=await open('setup');await wait(retry,'!document.querySelector("[data-next]").disabled');
  await evaluate(retry,'fixture.failPrepareFunding=true;document.querySelector("[data-next]").click()');
  await wait(retry,'!!document.querySelector("[data-funding-check]")&&!document.querySelector("[data-funding-check]").disabled');
  assert.equal(await evaluate(retry,'fixture.workerLocked'),true);
  assert.equal(await evaluate(retry,'document.querySelector("h2").textContent'),'Check XMR funding');
  await evaluate(retry,'document.querySelector("[data-funding-check]").click()');
  await wait(retry,'!!document.querySelector("[data-next]")&&!document.querySelector("[data-next]").disabled');
  assert.equal(await evaluate(retry,'fixture.workerLocked'),false,'reopened a worker closed by a funding exception');
  assert.equal(await evaluate(retry,'fixture.calls.filter(c=>c.name==="prepare").length'),1,'Check again cannot prepare or sign again');
  assert.equal(await evaluate(retry,'fixture.calls.some(c=>["holder-sign","sign","publish"].includes(c.name))'),false);
  const bad=await open();await evaluate(bad,'fixture.changedPreparation=true;document.querySelector("[data-max]").click()');await wait(bad,'!document.querySelector("[data-next]").disabled');await evaluate(bad,'document.querySelector("[data-next]").click()');await wait(bad,'!document.querySelector(".native-send-error").hidden');
  assert.equal(await evaluate(bad,'fixture.calls.some(c=>["holder-sign","sign","publish"].includes(c.name))'),false,'changed amount must fail before either signature');
  const closed=await open();await evaluate(closed,'document.querySelector("[data-max]").click()');await wait(closed,'!document.querySelector("[data-next]").disabled');await evaluate(closed,'document.querySelector("[data-next]").click()');await wait(closed,'fixture.calls.some(c=>c.name==="holder-sign")');await evaluate(closed,'fixture.close();fixture.custodyConfirmed=true');
  await new Promise(r=>setTimeout(r,5100));assert.equal(await evaluate(closed,'fixture.calls.some(c=>c.name==="sign")'),false,'closing revokes automatic continuation');
  const savedOnly=await open('saved-only');
  assert.equal(await evaluate(savedOnly,'document.querySelector("h1").textContent'),'Finish Monero setup');
  assert.equal(await evaluate(savedOnly,'document.querySelector(".native-send-recovery").open'),true);
  assert.equal(await evaluate(savedOnly,'fixture.calls.some(c=>["quote","balance","prepare","holder-sign","sign","sync"].includes(c.name))'),false,'saved bridges do not depend on holdings, funding or a new quote');
  await shot(savedOnly,'saved-bridges-short-390',390,480);
  await evaluate(savedOnly,'document.querySelector(".native-send-recovery button").click()');
  await wait(savedOnly,'!!document.querySelector("[data-retry]")&&!document.querySelector("[data-retry]").hidden');
  assert.equal(await evaluate(savedOnly,'fixture.calls.some(c=>["prepare","holder-sign","sign","issue","sync"].includes(c.name))'),false);
  const r=await open('saved');await fits(r,'Bridge to Monero with a saved entry');await evaluate(r,'document.querySelector(".native-send-recovery button").click()');await wait(r,'!!document.querySelector("[data-retry]")&&!document.querySelector("[data-retry]").hidden');
  assert.equal(await evaluate(r,'fixture.calls.some(c=>["holder-sign","sign","issue","sync"].includes(c.name))'),false,'saved credit recovery bypasses scan and signatures');
  await evaluate(r,'document.querySelector("[data-retry]").click()');await wait(r,'fixture.calls.some(c=>c.name==="publish")');
  assert.equal(await evaluate(r,'fixture.calls.find(c=>c.name==="publish").value.retry'),false);
	  const unknown=await open('saved-only');
	  await evaluate(unknown,'fixture.statusOverride={status:"submission-unknown",confirmed:false,confirmations:0,requiredConfirmations:10};document.querySelector(".native-send-recovery button").click()');
	  await wait(unknown,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(unknown,'document.querySelector("[data-retry]")?.textContent'),'Retry publish');
	  assert.equal(await evaluate(unknown,'document.querySelector(".native-send-message").textContent.includes("could not be verified")'),true);
	  assert.equal(await evaluate(unknown,'document.querySelector(".native-send-message").textContent.includes("Waiting for")'),false);
	  assert.equal(await evaluate(unknown,'document.querySelector(".native-send-costs dd").textContent'),'Not seen');
	  assert.equal(await evaluate(unknown,'document.querySelector(".native-send-elapsed").hidden'),true);
	  await evaluate(unknown,'document.querySelector("[data-retry]").click()');await wait(unknown,'fixture.calls.some(c=>c.name==="publish")');
	  assert.equal(await evaluate(unknown,'fixture.calls.find(c=>c.name==="publish").value.retry'),true);
	  // 21 October: the restricted peer hid a relayed transaction until it was mined.
	  // The service reports proven relay as accepted; the page must wait, not retry.
	  const propagating=await open('saved-only');
	  await evaluate(propagating,'fixture.statusOverride={status:"accepted",confirmed:false,confirmations:0,requiredConfirmations:10,peersSeen:1};document.querySelector(".native-send-recovery button").click()');
	  await wait(propagating,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(propagating,'document.querySelector("[data-retry]").hidden'),true,'proven relay must not offer another publish');
	  assert.equal(await evaluate(propagating,'document.querySelector(".native-send-message").textContent.includes("could not be verified")'),false);
	  assert.equal(await evaluate(propagating,'document.querySelector(".native-send-costs dd").textContent'),'0 / 10');
	  await shot(propagating,'propagating-short-390',390,480);
	  assert.equal(await evaluate(propagating,'fixture.calls.some(c=>c.name==="publish")'),false);
	  // One peer holding an unproven copy may be an unrelayed validation leftover: the exact retry stays available.
	  const unproven=await open('saved-only');
	  await evaluate(unproven,'fixture.statusOverride={status:"submission-unknown",confirmed:false,confirmations:0,requiredConfirmations:10,peersSeen:1};document.querySelector(".native-send-recovery button").click()');
	  await wait(unproven,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(unproven,'document.querySelector("[data-retry]").hidden'),false);
	  const transport=await open('saved-only');
	  await evaluate(transport,'fixture.statusOverride={status:"submission-unknown",confirmed:false,confirmations:0,requiredConfirmations:10,failureStage:"relay-peer-0-transport"};document.querySelector(".native-send-recovery button").click()');
	  await wait(transport,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(transport,'document.querySelector("[data-retry]").hidden'),false);
	  assert.equal(await evaluate(transport,'document.querySelector("[data-retry]").textContent'),'Retry publish');
	  const genericRejection=await open('saved-only');
	  await evaluate(genericRejection,'fixture.statusOverride={status:"submission-unknown",confirmed:false,confirmations:0,requiredConfirmations:10,failureStage:"validate-peer-1-rejected"};document.querySelector(".native-send-recovery button").click()');
	  await wait(genericRejection,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(genericRejection,'document.querySelector("[data-retry]").hidden'),false);
	  const rejectedPublish=await open('saved-only');
	  await evaluate(rejectedPublish,'fixture.statusOverride={status:"submission-unknown",confirmed:false,confirmations:0,requiredConfirmations:10,failureStage:"validate-peer-0-fee_too_low"};document.querySelector(".native-send-recovery button").click()');
	  await wait(rejectedPublish,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(rejectedPublish,'document.querySelector("[data-retry]").hidden'),true);
	  assert.equal(await evaluate(rejectedPublish,'document.querySelector(".native-send-message").textContent.includes("not accepted")'),true);
	  const replayRejected=await open('saved-only');
	  await evaluate(replayRejected,'fixture.statusOverride={status:"rejected",confirmed:false,confirmations:10,requiredConfirmations:10};document.querySelector(".native-send-recovery button").click()');
	  await wait(replayRejected,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(replayRejected,'document.querySelector(".native-send-costs dd").textContent'),'10 / 10');
	  assert.equal(await evaluate(replayRejected,'document.querySelector(".native-send-message").textContent.includes("was mined")'),true);
	  const unavailable=await open('saved-only');
	  await evaluate(unavailable,'fixture.statusOverride={status:"unavailable",confirmed:false,confirmations:0,requiredConfirmations:10};document.querySelector(".native-send-recovery button").click()');
	  await wait(unavailable,'fixture.calls.some(c=>c.name==="status")');
	  assert.equal(await evaluate(unavailable,'document.querySelector(".native-send-message").textContent.includes("temporarily unavailable")'),true);
	  assert.equal(await evaluate(unavailable,'document.querySelector("[data-retry]").hidden'),true);
	  assert.equal(await evaluate(unavailable,'document.querySelector(".native-send-costs dd").textContent'),'Not seen');
	  assert.equal(await evaluate(unavailable,'document.querySelector(".native-send-elapsed").hidden'),true);
  await evaluate(r,'document.querySelector("[data-recover-bridge]").open=true;document.querySelector("[data-recover-bridge] button").click()');await wait(r,'!!document.querySelector("[data-refund]")');
  await shot(r,'refund-review-390',390,600);assert.equal(await evaluate(r,'fixture.calls.some(c=>c.name==="refund-approve")'),false);
  await evaluate(r,'document.querySelector("[data-refund]").click()');await wait(r,'fixture.calls.some(c=>c.name==="complete-refund")');
  const done=await open('refunded');assert.equal(await evaluate(done,'document.querySelector(".native-send-recovery button").disabled'),true);
 }else{
  const fill=async session=>{await evaluate(session,`document.querySelector("textarea").value=fixture.${redemption?'destination':'recipient'};document.querySelector("textarea").dispatchEvent(new Event("input"));document.querySelector("[data-max]").click();`);await wait(session,`!document.querySelector("[data-${redemption?'next':'review'}]").disabled`);};
  const send=`document.querySelector("[data-${redemption?'next':'review'}]").click()`;
  await fill(s);assert.equal(await evaluate(s,'fixture.calls.some(c=>["construct","sign","publish"].includes(c.name))'),false);
  await shot(s,'ready-360',360,600);await fits(s,redemption?'Bridge to Solana':'Monero send');await shot(s,'ready-short-390',390,480);
  await evaluate(s,send+';'+send);await wait(s,'fixture.calls.some(c=>c.name==="publish")');
  assert.equal(await evaluate(s,'fixture.calls.find(c=>c.name==="construct").value.quantity'),'7530668912636');
  assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="sign").length'),1);assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="publish").length'),1);
  await shot(s,'confirming-390',390,600);
  await evaluate(s,'fixture.confirmed=true;fixture.paid=true;document.querySelector("[data-check]").click()');await wait(s,'document.querySelector("[data-check]")?.textContent==="Done"');
  for(const mode of ['saved','uncached']){
   const r=await open(mode);const scans=await evaluate(r,'fixture.calls.filter(c=>c.name==="sync").length');
   await evaluate(r,'document.querySelector(".native-send-recovery button").click()');await wait(r,'!!document.querySelector("[data-retry]")&&!document.querySelector("[data-retry]").hidden');
   assert.equal(await evaluate(r,'fixture.calls.filter(c=>c.name==="sync").length'),scans+(mode==='uncached'?1:0));
   assert.equal(await evaluate(r,'fixture.calls.some(c=>c.name==="sign")'),false);await evaluate(r,'document.querySelector("[data-retry]").click()');await wait(r,'fixture.calls.some(c=>c.name==="publish")');
   assert.equal(await evaluate(r,'fixture.calls.find(c=>c.name==="publish").value.retry'),false);
  }
  if(!redemption){
   // Restricted-peer propagation: proven relay is accepted, so the token send page waits instead of offering a retry.
   const relayed=await open('saved');
   await evaluate(relayed,'fixture.statusOverride={txid:"33".repeat(32),status:"accepted",confirmed:false,confirmations:0,requiredConfirmations:10,peersSeen:1};document.querySelector(".native-send-recovery button").click()');
   await wait(relayed,'fixture.calls.some(c=>c.name==="status")');
   assert.equal(await evaluate(relayed,'document.querySelector(".native-send-message").textContent'),'Sent to the Monero network.');
   assert.equal(await evaluate(relayed,'document.querySelector("[data-retry]").hidden'),true,'proven relay must not offer another send');
   assert.equal(await evaluate(relayed,'fixture.calls.some(c=>c.name==="publish")'),false);
   await shot(relayed,'relayed-short-390',390,480);
  }
  for(const change of ['feeOverride="100000001"','quantityOverride="1"','recipientOverride="changed"']){
   const bad=await open();await fill(bad);await evaluate(bad,'fixture.'+change+';'+send);await wait(bad,'!document.querySelector(".native-send-error").hidden');
   assert.equal(await evaluate(bad,'fixture.calls.some(c=>["sign","publish"].includes(c.name))'),false,'changed transaction must never sign');
  }
  const closed=await open();await fill(closed);await evaluate(closed,'fixture.holdConstruction=true;'+send);await wait(closed,'!!fixture.finishConstruction');await evaluate(closed,'fixture.close();fixture.finishConstruction()');await new Promise(r=>setTimeout(r,50));assert.equal(await evaluate(closed,'fixture.calls.some(c=>c.name==="sign")'),false);
  const funding=await open();await fill(funding);await evaluate(funding,'fixture.fundingMissing=true;'+send);await wait(funding,'!!document.querySelector("[data-funding-check]")');await shot(funding,'funding-390',390,480);assert.equal(await evaluate(funding,'fixture.calls.some(c=>c.name==="sign")'),false);
  await evaluate(funding,'fixture.fundingMissing=false;document.querySelector("[data-funding-check]").click()');await wait(funding,'!!document.querySelector("input")');assert.equal(await evaluate(funding,'document.querySelector("input").value'),'7.53M','funding setup keeps exact draft');
 }
 assert.deepEqual(errors,[]);await writeFile(join(out,'verification.json'),JSON.stringify({publicFixture:true,userWalletAccess:false,actualPublication:false,passed:true,checks:['empty grey zero','exact Max amount','one explicit approval','no passive signing','fee and amount binding','duplicate click protection','closing revokes continuation','saved receipts retain exact transaction','unknown publication is never shown as confirmation progress','unavailable status cannot trigger a publish retry','footer visible at 360/390/460 and 480px height','19-confirmation funding boundary shows detected XMR','ordinary XMR history catches up without requesting more funds','reservations remain protected','funding retry reopens and syncs a closed worker without approving','compact exact conversion display; requested introduction removed','post-custody refresh before credit verification','closed worker resumes same preparation with no second approval','48px paired recovery actions','spinner during network wait; stopped on error; reduced motion respected']},null,2)+'\n');console.log('Native wallet public browser fixture passed.');
}finally{socket?.close();chrome?.kill();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());if(chrome&&chrome.exitCode===null)await new Promise(r=>{chrome.once('exit',r);setTimeout(r,3000);});await rm(temp,{recursive:true,force:true});}
