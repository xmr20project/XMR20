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
const temp=await mkdtemp(join(tmpdir(),'xmr20-public-send-ui-'));await mkdir(out,{recursive:true});
let chrome,socket,server;
try{
 await build({entryPoints:[join(import.meta.dirname,'native-swap-browser.fixture.js')],outfile:join(temp,'fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',inject:[join(root,'wallet-extension/src/polyfill.js')],logLevel:'silent'});
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(!['/','/fixture.js','/fixture.css'].includes(path)){res.writeHead(404).end();return;}
  res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(path==='/'?'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public native send fixture</title><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script><body></body></html>':await readFile(join(temp,path.slice(1))));
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
 const wait=async(s,expression)=>{for(let i=0;i<100;i++){if(await evaluate(s,expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Fixture condition timeout: '+expression);};
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
 // The ready swap form fits the 360x600 popup without scrolling.
 async function fits(s,name){
  await call('Emulation.setDeviceMetricsOverride',{width:360,height:600,deviceScaleFactor:1,mobile:true},s);
  const box=await evaluate(s,'(()=>{const el=document.querySelector(".native-send-scroll");return {scroll:el.scrollHeight,client:el.clientHeight};})()');
  assert.ok(box.scroll<=box.client+1,name+' must fit without scrolling: '+JSON.stringify(box));
 }
 const s=await open();
 assert.equal(await evaluate(s,'document.querySelector("input").value'),'');
 assert.equal(await evaluate(s,'document.querySelector("[data-tab=coins]").getAttribute("aria-selected")'),'true');
 assert.equal(await evaluate(s,'document.querySelector("textarea").value'),'PUBLIC MONERO WALLET');
 assert.equal(await evaluate(s,'document.querySelector(".bridge-token-panel:last-of-type .bridge-panel-foot>span").textContent'),'To your Monero wallet');
 assert.equal(await evaluate(s,'(()=>{const t=document.querySelector("textarea");t.value="PUBLIC OTHER WALLET";t.dispatchEvent(new Event("input"));const n=document.querySelector(".bridge-token-panel:last-of-type .bridge-panel-foot>span").textContent;t.value="PUBLIC MONERO WALLET";t.dispatchEvent(new Event("input"));return n;})()'),'To another address');
 await shot(s,'swap-empty-360',360,600);await fits(s,'SOL to XMR');
 await evaluate(s,'document.querySelector("[data-max]").click()');await wait(s,'document.querySelector("input").value==="0.123456789"');
 await evaluate(s,'document.querySelector("[data-next]").click()');await wait(s,'!!document.querySelector("[data-create]")');
 assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.action==="create").length'),0);
 await shot(s,'swap-review-390',390,600);
 await evaluate(s,'fixture.failCreate=true;document.querySelector("[data-create]").click()');await wait(s,'!document.querySelector(".native-send-error").hidden');
 assert.equal(await evaluate(s,'fixture.orders[0].status'),'creating');assert.equal(await evaluate(s,'fixture.paid.length'),0);
 await evaluate(s,'fixture.reopen();document.querySelector(".native-send-recovery button").click()');await wait(s,'!!document.querySelector("[data-recover]")');
 await evaluate(s,'fixture.failCreate=false;document.querySelector("[data-recover]").click()');await wait(s,'!!document.querySelector("[data-pay]")');
 await shot(s,'swap-order-360',360,600);
 assert.equal(await evaluate(s,'fixture.paid.length'),0);
 await evaluate(s,'document.querySelector("[data-pay]").click()');await wait(s,'fixture.paid.length===1');
 assert.equal(await evaluate(s,'fixture.orders[0].paymentOpened'),true);
 await evaluate(s,'fixture.reopen();document.querySelector(".native-send-recovery button").click()');await wait(s,'document.querySelector(".native-send-message").textContent.includes("payout complete")');
 assert.equal(await evaluate(s,'document.querySelector("[data-pay]").hidden'),true);
 await evaluate(s,'fixture.reopen();document.querySelector("[data-max]").click()');await wait(s,'document.querySelector("input").value==="0.123456789"');
 // The orange arrow flips direction; the amount and Max clear because the source changed.
 await evaluate(s,'document.querySelector("#j3-swap").click()');await wait(s,'document.querySelector("textarea").value==="PUBLIC SOLANA WALLET"');
 assert.equal(await evaluate(s,'document.querySelector("input").value'),'');
 await evaluate(s,'document.querySelector("[data-max]").click()');await wait(s,'document.querySelector("input").value==="0.123456789012"');
 await shot(s,'swap-xmr-460',460,600);await shot(s,'swap-xmr-360',360,600);await fits(s,'XMR to SOL');
 await evaluate(s,'document.querySelector("[data-tab=tokens]").click()');assert.equal(await evaluate(s,'fixture.tokens'),true);
 assert.deepEqual(errors,[]);await writeFile(join(out,'verification.json'),JSON.stringify({passed:true,publicFixture:true,financialSigning:false,checks:['both directions','exact Max','review before create','saved request before create','timeout recovery','payment only after review action','no repeated payment action','fixed footer at 360/390/460']},null,2));console.log('Native swap browser fixture passed.');

}finally{socket?.close();chrome?.kill();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());if(chrome&&chrome.exitCode===null)await new Promise(r=>{chrome.once('exit',r);setTimeout(r,3000);});await rm(temp,{recursive:true,force:true});}
