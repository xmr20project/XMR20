// Local fixture only: a fresh Chromium profile, generated keys, no user wallet or internet.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=process.env.XMR20_WEBSITE_SWAP_OUTDIR||join(root,'website-wallet/test-output/swap-browser');
const temp=await mkdtemp(join(tmpdir(),'xmr20-website-swap-'));await mkdir(out,{recursive:true});
let chrome,socket,server;
try{
 await build({entryPoints:[join(import.meta.dirname,'website-native-swap.fixture.jsx')],outfile:join(temp,'fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',
  jsx:'automatic',inject:[join(root,'src/polyfill.js')],define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(root,'website-wallet/node_modules'),join(root,'node_modules')],logLevel:'silent'});
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(!['/','/fixture.js','/fixture.css'].includes(path)){res.writeHead(404).end();return;}
  res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(path==='/'?'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website swap fixture</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:#15171b;font:15px system-ui}#host{box-sizing:border-box;max-width:440px;margin:0 auto;padding:16px}</style><script type="module" src="/fixture.js"></script><body><div id="host"></div></body></html>':await readFile(join(temp,path.slice(1))));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 chrome=spawn(process.env.CHROMIUM_PATH||'chromium',[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'
 ],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((res,rej)=>{let s='';const timer=setTimeout(()=>rej(Error('Browser startup timeout')),20000);chrome.stderr.on('data',v=>{s+=v;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);res(m[1]);}});chrome.on('error',rej);});
 socket=new WebSocket(endpoint);await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});let seq=0;const pending=new Map(),errors=[];
 socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const evaluate=async(s,expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},s);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const wait=async(s,expression)=>{for(let i=0;i<120;i++){if(await evaluate(s,expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Fixture condition timeout: '+expression+' | page: '+await evaluate(s,"document.querySelector('#host').innerText.slice(0,400)"));};
 const click=(s,selector)=>evaluate(s,`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Not clickable: ${selector}');el.click();return true;})()`);
 const clickText=(s,text)=>evaluate(s,`(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!el||el.disabled)throw Error('No button: ${text}');el.click();return true;})()`);
 const type=(s,selector,value)=>evaluate(s,`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 const text=s=>evaluate(s,"document.querySelector('#host').innerText");
 async function shot(s,name){
  assert.equal(await evaluate(s,'document.documentElement.scrollWidth<=innerWidth'),true,name+' horizontal overflow');
  // Primary actions stay inside the visible window, without scrolling the page.
  assert.equal(await evaluate(s,"(()=>{const a=document.querySelector('.native-send-actions'),w=document.querySelector('.website-native-page');if(!a)return true;const r=a.getBoundingClientRect(),b=w.getBoundingClientRect();return r.bottom<=b.bottom+1&&r.bottom<=innerHeight;})()"),true,name+' actions hidden');
  const {data}=await call('Page.captureScreenshot',{format:'png'},s);await writeFile(join(out,name+'.png'),Buffer.from(data,'base64'));
 }
 const {targetId}=await call('Target.createTarget',{url:origin+'/'}),{sessionId:s}=await call('Target.attachToTarget',{targetId,flatten:true});
 await call('Runtime.enable',{},s);await call('Emulation.setDeviceMetricsOverride',{width:440,height:760,deviceScaleFactor:1,mobile:false},s);
 await wait(s,'globalThis.fixture?.ready&&document.querySelector("#native-send [data-next]")');
 // The form receives into the linked Monero wallet and Max reserves the SOL network fee.
 assert.equal(await evaluate(s,"document.querySelector('#swap-destination').value"),await evaluate(s,'fixture.monero'));
 await click(s,'[data-max]');await wait(s,"document.querySelector('#native-send input').value==='1.999995'");
 await shot(s,'1-form');
 await call('Emulation.setDeviceMetricsOverride',{width:360,height:560,deviceScaleFactor:1,mobile:true},s);await shot(s,'1b-form-short');
 await call('Emulation.setDeviceMetricsOverride',{width:440,height:760,deviceScaleFactor:1,mobile:false},s);
 await type(s,'#native-send input','0.5');await click(s,'[data-next]');await wait(s,"document.querySelector('[data-create]')");
 const quote=await evaluate(s,'fixture.log.quotes[0]');
 assert.deepEqual([quote.direction,quote.amount,quote.destination,quote.refund],['sol-xmr','0.5',await evaluate(s,'fixture.monero'),await evaluate(s,'fixture.owner')]);
 await shot(s,'2-review');
 // The exact request is saved before the order is created.
 await click(s,'[data-create]');await wait(s,"document.querySelector('[data-pay]')&&!document.querySelector('[data-pay]').hidden");
 assert.match(await text(s),/Waiting for your deposit/);assert.equal((await evaluate(s,'fixture.saved()')).length,1);
 await click(s,'[data-pay]');await wait(s,"document.body.innerText.includes('Pay 0.5 SOL')");
 assert.match(await text(s),/Network fee\s*0\.000005 SOL/);await shot(s,'3-payment-review');
 // Cancel before signing: nothing is signed and Pay is offered again.
 await clickText(s,'Cancel');await wait(s,"document.querySelector('[data-pay]')&&!document.querySelector('[data-pay]').hidden");
 assert.equal(await evaluate(s,'fixture.log.signed'),0);
 await click(s,'[data-pay]');await wait(s,"document.body.innerText.includes('Pay 0.5 SOL')");
 await clickText(s,'Pay 0.5 SOL');await wait(s,"document.body.innerText.includes('Payment confirmed on Solana')");
 const sent=await evaluate(s,'fixture.log.sent.map(t=>({to:t.toPubkey.toBase58(),from:t.fromPubkey.toBase58(),lamports:String(t.lamports),valid:t.valid}))');
 assert.deepEqual(sent,[{to:await evaluate(s,'fixture.deposit'),from:await evaluate(s,'fixture.owner'),lamports:'500000000',valid:true}]);
 assert.equal(await evaluate(s,'fixture.log.signed'),1);
 assert.equal(typeof (await evaluate(s,'fixture.saved()[0].paymentSignature')),'string');
 await shot(s,'4-paid');
 // Back to the exchange: it reopens on this order and checks its status; Pay stays hidden.
 await evaluate(s,"fixture.setStatus('confirming')");await clickText(s,'Show exchange status');
 await wait(s,"document.body.innerText.includes('Confirming your deposit')");
 assert.equal(await evaluate(s,"!document.querySelector('[data-pay]')||document.querySelector('[data-pay]').hidden"),true);
 await shot(s,'5-status');
 // XMR -> SOL: the order shows the deposit to pay from any Monero wallet; nothing is signed here.
 await clickText(s,'Back');await wait(s,'globalThis.fixture.closed()===1');
 await evaluate(s,'fixture.reopen()');await wait(s,'document.querySelector("#native-send [data-next]")');
 assert.match(await text(s),/Saved SOL\/XMR exchanges/);
 await click(s,'#j3-swap');await wait(s,"document.querySelector('#swap-destination').value===fixture.owner");
 await type(s,'#native-send input','0.25');await click(s,'[data-next]');await wait(s,"document.querySelector('[data-create]')");
 await click(s,'[data-create]');await wait(s,"document.querySelector('[data-pay]')&&!document.querySelector('[data-pay]').hidden");
 await click(s,'[data-pay]');await wait(s,"document.body.innerText.includes('Copy address')");
 assert.match(await text(s),/0\.25 XMR/);assert.match(await text(s),/45cQVke2TNqcDi7/);await shot(s,'6-xmr-deposit');
 assert.equal(await evaluate(s,'fixture.log.signed'),1,'the XMR deposit needs no Solana signature');assert.equal(await evaluate(s,'fixture.saved().length'),2);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,steps:['form+max','quote','saved-before-create','pay-review','cancel-unsigned','sol-payment','resume-status','xmr-deposit'],screenshots:out}));
}finally{
 socket?.close();chrome?.kill('SIGKILL');server?.close();await rm(temp,{recursive:true,force:true});
}
