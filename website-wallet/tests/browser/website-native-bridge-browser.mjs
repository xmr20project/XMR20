// Local fixture only: a fresh Chromium profile, generated keys, no user wallet or internet.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {operatorConfigurationPlugin} from '../../../build-tools/operator-configuration.mjs';
const root=resolve(import.meta.dirname,'../../..'),out=process.env.XMR20_WEBSITE_BRIDGE_OUTDIR||join(root,'website-wallet/test-output/bridge-browser');
const temp=await mkdtemp(join(tmpdir(),'xmr20-website-bridge-'));await mkdir(out,{recursive:true});
let chrome,socket,server;
try{
 await build({entryPoints:[join(import.meta.dirname,'website-native-bridge.fixture.jsx')],outfile:join(temp,'fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',
  jsx:'automatic',inject:[join(root,'src/polyfill.js')],plugins:[operatorConfigurationPlugin(true)],define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(root,'website-wallet/node_modules'),join(root,'node_modules')],logLevel:'silent'});
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(!['/','/fixture.js','/fixture.css'].includes(path)){res.writeHead(404).end();return;}
  res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
  res.end(path==='/'?'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website bridge fixture</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:#0b0c0e;font:15px system-ui}</style><script type="module" src="/fixture.js"></script><body><dialog class="wallet-dialog" open><div class="wallet-dialog-head"><div><span class="wallet-kicker">XMR20 · WALLET</span><h2>Your wallet: 0.12 SOL</h2></div><button class="wallet-close">×</button></div><div class="wallet-dialog-body"><div class="wallet-chain-tabs"><button>SOL Solana</button><button>XMR Monero</button></div><div class="wallet-panel-scroll"><div><div class="wallet-native-asset">SOL 0.12</div><section class="wallet-assets" id="frame"></section></div></div><div class="wallet-foot"><button class="wallet-disconnect">Disconnect wallet</button></div></div></dialog></body></html>':await readFile(join(temp,path.slice(1))));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 chrome=spawn(process.env.CHROMIUM_PATH||'chromium',[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'
 ],{stdio:['ignore','ignore','pipe']});
 const endpoint=await new Promise((res,rej)=>{let s='';const timer=setTimeout(()=>rej(Error('Browser startup timeout')),20000);chrome.stderr.on('data',v=>{s+=v;const m=s.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);res(m[1]);}});chrome.on('error',rej);});
 socket=new WebSocket(endpoint);await new Promise((res,rej)=>{socket.onopen=res;socket.onerror=rej;});let seq=0;const pending=new Map(),errors=[];
 socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const evaluate=async(s,expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},s).catch(e=>{throw Error(e.message+' while evaluating: '+expression.slice(0,120));});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
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
 async function open(mode=''){const {targetId}=await call('Target.createTarget',{url:origin+'/?mode='+mode}),{sessionId:s}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Runtime.enable',{},s);await call('Emulation.setDeviceMetricsOverride',{width:1280,height:742,deviceScaleFactor:1,mobile:false},s);await wait(s,'globalThis.fixture?.ready');return s;}
 const visible=s=>evaluate(s,"(()=>{const f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect(),a=document.querySelector('#native-send .native-send-actions'),n=document.querySelector('.website-native-note');if(!a||!n)return false;const r=a.getBoundingClientRect(),q=n.getBoundingClientRect();return r.top>=f.top&&r.bottom<=f.bottom&&q.bottom<=f.bottom+1;})()");
 const s=await open();
 await wait(s,'!!document.querySelector("#native-send [data-max]")');
 // The Monero wallet opens for this Solana owner and the linked Monero address only.
 const ctx=await evaluate(s,'fixture.calls.find(c=>c.name==="client").value');
 assert.deepEqual([ctx.owner,ctx.network,ctx.address],[await evaluate(s,'fixture.owner'),'mainnet',await evaluate(s,'fixture.monero')]);
 assert.ok(await evaluate(s,'fixture.calls.some(c=>c.name==="capabilities")&&fixture.calls.some(c=>c.name==="unlock")'));
 await new Promise(r=>setTimeout(r,1200));await shot(s,'1-bridge-form');assert.equal(await visible(s),true,'actions and note must be visible inside the wallet frame');
 // Takeover: the wallet title, tabs, balances, token rows and footer hide; both amount panels and Max are fully visible.
 assert.deepEqual(await evaluate(s,"['.wallet-dialog-head','.wallet-chain-tabs','.wallet-native-asset','.wallet-asset-wrap','.wallet-actions-row','.wallet-foot'].map(q=>getComputedStyle(document.querySelector(q)).display)"),['none','none','none','none','none','none']);
 assert.equal(await evaluate(s,"(()=>{const f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect();return [...document.querySelectorAll('.bridge-token-panel'),document.querySelector('[data-max]')].every(e=>{const r=e.getBoundingClientRect();return r.top>=f.top&&r.bottom<=f.bottom;});})()"),true,'both panels and Max must be fully visible');
 assert.ok(await evaluate(s,"document.querySelector('#native-send').getBoundingClientRect().width>=document.querySelector('.website-native-page').getBoundingClientRect().width-4"),'page fills the wallet width');
 // Max uses the exact Solana balance; typing and Max never prepare or sign.
 await click(s,'[data-max]');await wait(s,'!document.querySelector("[data-next]").disabled');
 assert.equal(await evaluate(s,'fixture.calls.some(c=>["prepare","holder-sign","sign"].includes(c.name))'),false);
 await click(s,'[data-next]');await wait(s,'fixture.calls.some(c=>c.name==="holder-sign")');
 assert.equal(await evaluate(s,'fixture.calls.find(c=>c.name==="prepare").value.amount'),'24113974003764');
 const signed=await evaluate(s,'fixture.calls.find(c=>c.name==="holder-sign").value');
 assert.deepEqual(signed,{account:{solana:await evaluate(s,'fixture.owner'),monero:await evaluate(s,'fixture.monero')},owner:await evaluate(s,'fixture.owner'),proposal:'PUBLIC CUSTODY'});
 assert.deepEqual(await evaluate(s,'fixture.calls.find(c=>c.name==="approve").value'),{owner:await evaluate(s,'fixture.owner'),transaction:'PUBLIC HOLDER APPROVAL'});
 assert.equal(await evaluate(s,'fixture.calls.some(c=>c.name==="sign")'),false,'Monero credit waits for custody');
 assert.match(await evaluate(s,'document.querySelector("#native-send").innerText'),/resume from Open new bridge → Saved entries later/);
 // One step tracker: Solana deposit → build Monero transaction → send → confirmations; the explorer link waits for acceptance.
 const current=x=>evaluate(x,'document.querySelector(".native-bridge-steps [aria-current=step] strong")?.textContent||""');
 const linkHidden=x=>evaluate(x,'!document.querySelector(".native-bridge-steps .native-send-explorer")');
 assert.equal(await current(s),'Solana deposit');
 await shot(s,'2-custody-waiting');
 await evaluate(s,'fixture.holdBuild=true;fixture.holdPublish=true;fixture.custodyConfirmed=true');await wait(s,'!!fixture.releaseBuild');
 assert.equal(await current(s),'Monero transaction');assert.match(await evaluate(s,'document.querySelector(".native-bridge-steps").innerText'),/Confirmed on Solana[\s\S]*1–2 minutes/);
 assert.equal(await evaluate(s,"(()=>{const f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect();return ['.native-bridge-steps','.native-send-message'].every(q=>{const r=document.querySelector('#native-send '+q).getBoundingClientRect();return r.top>=f.top&&r.bottom<=f.bottom;});})()"),true,'tracker and status visible inside the wallet frame');await shot(s,'2b-building-monero');
 await evaluate(s,'fixture.releaseBuild()');await wait(s,'!!fixture.releasePublish');
 assert.equal(await current(s),'Send to Monero');assert.equal(await linkHidden(s),true,'no explorer link before the network accepts it');
 // The finished build step says how long each part took, so a slow part can be found.
 assert.match(await evaluate(s,'document.querySelector(".native-bridge-steps").innerText'),/Built and signed in \d+ s \(bridge service \d+ s · wallet catch-up \d+ s · building \d+ s · signing \d+ s\)/);await shot(s,'2c-sending-monero');
 await evaluate(s,'fixture.releasePublish()');await wait(s,'document.querySelector(".native-bridge-steps [aria-current=step] strong")?.textContent==="Monero confirmations"');
 assert.equal(await linkHidden(s),false,'explorer link once accepted');
 const link=await evaluate(s,"(()=>{const a=document.querySelector('.native-send-explorer'),f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect(),r=a.getBoundingClientRect(),c=getComputedStyle(a);let clip=null;for(let e=a.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);if(s.overflowY!=='visible'){const q=e.getBoundingClientRect();if(r.top<q.top||r.bottom>q.bottom){clip={cls:e.className,top:Math.round(q.top),bottom:Math.round(q.bottom),scrollTop:e.scrollTop};break;}}}return JSON.stringify({display:c.display,visibility:c.visibility,top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height),frameTop:Math.round(f.top),frameBottom:Math.round(f.bottom),clip});})()");
 const g=JSON.parse(link);assert.ok(g.height>0&&!g.clip&&g.top>=g.frameTop&&g.bottom<=g.frameBottom,'explorer link visible in the frame: '+link);assert.match(await evaluate(s,'document.querySelector(".native-bridge-steps").innerText'),/Accepted by the Monero network · View on xmrchain ↗[\s\S]*0 of 10 confirmations · about 20 min left/);
 assert.equal(await evaluate(s,'document.querySelector(".native-bridge-steps .native-send-explorer").href'),'https://xmrchain.net/tx/'+'22'.repeat(32));
 assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="sign").length'),1);assert.equal(await evaluate(s,'fixture.calls.filter(c=>c.name==="holder-sign").length'),1);
 await shot(s,'3-published');
 // The wallet's Monero tab is told about the bridge: a pending record with the published transaction.
 const pendingRecord=await evaluate(s,'JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith("xmr20-native-pending-bridges-v1:")).map(([k,v])=>[k.endsWith(fixture.monero),JSON.parse(v)]))');
 const [[scoped,[entry]]]=JSON.parse(pendingRecord);assert.equal(scoped,true);
 assert.deepEqual([entry.preparationId,entry.amountRaw,entry.stage,entry.txid,entry.confirmations,entry.required],['public-preparation','24113973988764','confirming','22'.repeat(32),0,10]);
 // An unavailable private worker shows a clear message with Back; nothing opens or signs.
 const u=await open('unavailable');await wait(u,'document.body.innerText.includes("cannot run the Monero wallet worker")');
 assert.equal(await evaluate(u,'fixture.calls.some(c=>["unlock","prepare","holder-sign"].includes(c.name))'),false);
 await clickText(u,'Back');await wait(u,'fixture.closed===1');await shot(u,'4-unavailable');
 // No saved start height: ask once (launch block suggested), save it, then open from it.
 const h=await open('no-height');await wait(h,'!!document.querySelector("#native-start-height")');
 assert.equal(await evaluate(h,'document.querySelector("#native-start-height").value'),'3788009');
 assert.equal(await evaluate(h,'fixture.calls.some(c=>c.name==="client")'),false,'no wallet scan before a start height');await new Promise(r=>setTimeout(r,1200));await shot(h,'5-start-height');
 await clickText(h,'Continue');await wait(h,'!!document.querySelector("#native-send [data-max]")');
 assert.equal(await evaluate(h,'fixture.calls.find(c=>c.name==="client").value.restoreHeight'),3788009);
 assert.equal(await evaluate(h,'localStorage.getItem("xmr20-native-birth:"+fixture.monero)'),'3788009');
 // Another tab holds this wallet: reported at once, no engine or wallet prompt; Try again proceeds once released.
 const l=await open('held-lock');await wait(l,'document.body.innerText.includes("another xmr20.org tab or window")');
 assert.equal(await evaluate(l,'fixture.calls.some(c=>c.name==="client")'),false,'no engine while another window holds the wallet');
 await new Promise(r=>setTimeout(r,600));await shot(l,'6-other-window');
 await evaluate(l,'fixture.releaseLock()');await clickText(l,'Try again');await wait(l,'!!document.querySelector("#native-send [data-max]")');
 assert.equal(await evaluate(l,'fixture.calls.some(c=>c.name==="client")'),true);
 // Reserved XMR: the saved transfer is shown with Continue, which resumes that exact bridge.
 const v=await open('reserved');await wait(v,'!!document.querySelector("#native-send [data-max]")');
 await click(v,'[data-max]');await wait(v,'!document.querySelector("[data-next]").disabled');await click(v,'[data-next]');
 await wait(v,'document.body.innerText.includes("Finish your saved bridge")');
 const card=await evaluate(v,'document.querySelector(".native-reserved-transfer").innerText');
 assert.match(card,/100,000 EXTREMIST/);assert.match(card,/98,500 EXTREMIST/);assert.match(card,/Waiting for your Solana approval · about \d+ h left/);
 assert.equal(await evaluate(v,"(()=>{const f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect(),b=document.querySelector('[data-continue]').getBoundingClientRect();return b.top>=f.top&&b.bottom<=f.bottom;})()"),true,'Continue visible without scrolling');
 await new Promise(r=>setTimeout(r,600));await shot(v,'7-reserved-saved-transfer');
 await click(v,'[data-continue]');await wait(v,'!!document.querySelector("[data-approve]")');
 assert.match(await evaluate(v,'document.querySelector(".native-send-review-amount").innerText'),/100000 EXTREMIST/);
 await click(v,'[data-approve]');await wait(v,'fixture.calls.some(c=>c.name==="holder-sign")');
 assert.equal(await evaluate(v,'fixture.calls.some(c=>c.name==="prepare-new")'),false,'no second bridge while XMR is reserved');
 // Cancel bridge: one confirmation (Keep it goes back), then the wallet proves the deposit
 // never happened and frees the XMR; the saved entry stays, marked Cancelled.
 const x=await open('reserved-cancel');await wait(x,'!!document.querySelector("#native-send [data-max]")');
 await click(x,'[data-max]');await wait(x,'!document.querySelector("[data-next]").disabled');await click(x,'[data-next]');
 await wait(x,'!!document.querySelector("[data-cancel-saved]")');
 assert.equal(await evaluate(x,"(()=>{const f=document.querySelector('.wallet-panel-scroll').getBoundingClientRect();return ['[data-cancel-saved]','[data-continue]'].every(q=>{const b=document.querySelector(q).getBoundingClientRect();return b.top>=f.top&&b.bottom<=f.bottom;});})()"),true,'Cancel and Continue visible without scrolling');
 await click(x,'[data-cancel-saved]');await wait(x,'!!document.querySelector("[data-confirm-cancel]")');
 assert.match(await evaluate(x,'document.querySelector("[data-cancel-note]").innerText'),/stays in your Solana wallet and the reserved XMR is freed/);await shot(x,'7b-cancel-confirm');
 await clickText(x,'Keep it');await wait(x,'!!document.querySelector("[data-continue]")');assert.equal(await evaluate(x,'fixture.calls.some(c=>c.name==="cancel")'),false,'Keep it cancels nothing');
 await click(x,'[data-cancel-saved]');await click(x,'[data-confirm-cancel]');await wait(x,'document.body.innerText.includes("Bridge cancelled")');
 assert.equal(await evaluate(x,'!!document.querySelector("#native-send [data-max]")'),true,'bridge form is available again');
 assert.deepEqual(await evaluate(x,'fixture.calls.filter(c=>c.name==="cancel").map(c=>c.value)'),[{preparationId:'public-preparation'}]);
 assert.equal(await evaluate(x,'fixture.calls.some(c=>["holder-sign","prepare-new","sign","publish"].includes(c.name))'),false);
 assert.match(await evaluate(x,'document.querySelector(".native-send-recovery").textContent'),/Cancelled/);await shot(x,'7c-cancelled');
 const y=await open('reserved-landed');await wait(y,'!!document.querySelector("#native-send [data-max]")');
 await click(y,'[data-max]');await wait(y,'!document.querySelector("[data-next]").disabled');await click(y,'[data-next]');
 await wait(y,'!!document.querySelector("[data-cancel-saved]")');await click(y,'[data-cancel-saved]');await click(y,'[data-confirm-cancel]');
 await wait(y,'document.body.innerText.includes("already reached Solana")');assert.equal(await evaluate(y,'fixture.calls.some(c=>c.name==="cancel")'),false,'a landed deposit is never cancelled');
 // Balance check: unlock, sync, read tokens, save the Monero tab summary; nothing prepared or signed.
 const b=await open('balance');await wait(b,'document.body.innerText.includes("100,002.50 EXTREMIST")');
 assert.equal(await evaluate(b,'fixture.calls.some(c=>["prepare","holder-sign","sign","publish"].includes(c.name))'),false);
 assert.equal(await evaluate(b,'JSON.parse(Object.entries(localStorage).find(([k])=>k.startsWith("xmr20-native-token-display-v1:"))[1]).amountRaw'),'100002500000');
 await new Promise(r=>setTimeout(r,1200));
 await shot(b,'8-balance-check');await clickText(b,'Done');await wait(b,'fixture.closed===1');
 // Monero tab rows: the saved balance and the bridge still on its way, kept moving by status reads.
 const m=await open('holdings');await wait(m,'document.body.innerText.includes("Monero confirmations · 6/10")');
 const tabText=await evaluate(m,'document.querySelector(".wallet-native-holdings").innerText');
 assert.match(tabText,/100,000\.00 EXTREMIST arriving[\s\S]*Pending[\s\S]*7,530,668\.912636 EXTREMIST[\s\S]*Monero balance[\s\S]*Checked 3 min ago/);
 assert.equal(await evaluate(m,'fixture.calls.filter(c=>c.name==="status").length>=1'),true);
 await shot(m,'9-monero-tab-rows');await clickText(m,'Refresh');assert.equal(await evaluate(m,'fixture.calls.some(c=>c.name==="check")'),true);
 // Every wallet gets the same generic check; a token row appears only once a check finds that token.
 const fresh=await open('unchecked');await wait(fresh,'!!document.querySelector(".wallet-native-holdings")');
 const unchecked=await evaluate(fresh,'document.querySelector(".wallet-native-holdings").innerText');
 assert.match(unchecked,/Monero balance[\s\S]*Not checked in this browser yet[\s\S]*Show balance/);assert.doesNotMatch(unchecked,/EXTREMIST/);
 assert.equal(await evaluate(fresh,'[...document.querySelectorAll(".wallet-native-holdings button")].map(b=>b.textContent).join()'),'Show balance','no Bridge button before a check finds tokens');
 await shot(fresh,'10-monero-tab-unchecked');await clickText(fresh,'Show balance');assert.equal(await evaluate(fresh,'fixture.calls.some(c=>c.name==="check")'),true);
 const z=await open('checked-empty');await wait(z,'!!document.querySelector(".wallet-native-holdings")');
 const empty=await evaluate(z,'document.querySelector(".wallet-native-holdings").innerText');
 assert.match(empty,/No bridged tokens found · checked 3 min ago[\s\S]*Refresh/);assert.doesNotMatch(empty,/EXTREMIST/);
 const be=await open('balance-empty');await wait(be,'document.body.innerText.includes("No bridged tokens found")');
 assert.doesNotMatch(await evaluate(be,'document.querySelector("#native-send").innerText'),/EXTREMIST/);await shot(be,'11-balance-check-empty');
 // Bridge to Solana: the Monero wallet signs one burn to the connected Solana address; no Solana wallet approval.
 const r=await open('redeem');await wait(r,'!!document.querySelector("#native-send [data-max]")');
 assert.equal(await evaluate(r,'document.querySelector("#native-send h1").textContent'),'Bridge to Solana');
 assert.equal(await evaluate(r,'document.querySelector("#bridge-destination").value'),await evaluate(r,'fixture.owner'),'pays out to the connected Solana wallet by default');
 await new Promise(x=>setTimeout(x,1200));await shot(r,'12-redeem-form');assert.equal(await visible(r),true,'redeem actions and note visible inside the wallet frame');
 await click(r,'[data-max]');await wait(r,'!document.querySelector("[data-next]").disabled');
 assert.equal(await evaluate(r,'fixture.calls.some(c=>["construct","sign-redemption"].includes(c.name))'),false,'typing and Max never sign');
 await click(r,'[data-next]');await wait(r,'fixture.calls.some(c=>c.name==="burn-publish")');
 const terms=await evaluate(r,'fixture.calls.find(c=>c.name==="construct").value');
 assert.deepEqual([terms.offerId,terms.quantity,terms.recipient],['77'.repeat(32),'250000000000',await evaluate(r,'fixture.ownerHex')],'only free tokens, to the connected wallet');
 assert.equal(await evaluate(r,'fixture.calls.filter(c=>c.name==="sign-redemption").length'),1);
 assert.equal(await evaluate(r,'fixture.calls.some(c=>["holder-sign","prepare","approve","sign"].includes(c.name))'),false,'no Solana wallet approval for a bridge to Solana');
 assert.equal(await evaluate(r,'fixture.calls.find(c=>c.name==="burn-publish").value.transaction'),'PUBLIC FIXTURE ONLY');
 assert.match(await evaluate(r,'document.querySelector("#native-send").innerText'),/250\.00K EXTREMIST[\s\S]*Monero confirmations/);
 // The Monero tab is told: an outgoing record with the Monero transaction.
 const outgoing=JSON.parse(await evaluate(r,'JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith("xmr20-native-pending-bridges-v1:")&&k.endsWith(fixture.monero)).map(([,v])=>JSON.parse(v)))'));
 assert.deepEqual(outgoing.map(l=>l.map(e=>[e.preparationId,e.amountRaw,e.stage,e.txid,e.to])),[[['solana:'+'66'.repeat(32),'250000000000','sending','66'.repeat(32),'solana']]]);
 await shot(r,'13-redeem-published');
 // ⇅ flips direction on the same unlocked wallet (one wallet session, never disposed); a wallet
 // step still running finishes first, with a status line instead of a stale page.
 const w=await open('switch');await wait(w,'!!document.querySelector("#native-send [data-max]")');
 await evaluate(w,'fixture.holdSync=true');await click(w,'#j3-swap');
 await wait(w,'document.querySelector("#native-send h1")?.textContent==="Bridge to Solana"&&!!fixture.releaseSync');
 await click(w,'#j3-swap');await wait(w,'document.querySelector("#native-send")?.innerText.includes("Finishing the current Monero wallet step")');
 await shot(w,'14-switch-finishing-step');
 await evaluate(w,'fixture.holdSync=false;fixture.releaseSync()');
 await wait(w,'document.querySelector("#native-send h1")?.textContent==="Bridge to Monero"&&!!document.querySelector("#native-send [data-max]")');
 assert.deepEqual(await evaluate(w,'[fixture.calls.filter(c=>c.name==="client").length,fixture.calls.filter(c=>c.name==="dispose").length]'),[1,0],'one wallet session across switches');
 // Monero tab: a bridge to Solana shows until confirmed; the saved balance says it predates it; Bridge opens it.
 const o=await open('holdings-out');await wait(o,'document.body.innerText.includes("Monero confirmations · 6/10")');
 const outText=await evaluate(o,'document.querySelector(".wallet-native-holdings").innerText');
 assert.match(outText,/250,000\.00 EXTREMIST leaving for Solana[\s\S]*Monero confirmations · 6\/10[\s\S]*Pending[\s\S]*7,530,668\.912636 EXTREMIST[\s\S]*Checked before your bridge to Solana[\s\S]*Bridge/);
 await shot(o,'15-monero-tab-leaving');await clickText(o,'Bridge');assert.equal(await evaluate(o,'fixture.calls.some(c=>c.name==="bridge")'),true);
 // Send: Monero tokens to another Monero address; the Monero wallet signs, no Solana wallet approval.
 const sd=await open('send');await wait(sd,'!!document.querySelector("#native-send [data-max]")');
 assert.equal(await evaluate(sd,'document.querySelector("#native-send h1").textContent'),'Send $EXTREMIST');
 const to='4'+'B'.repeat(94);await type(sd,'#native-recipient',to);await type(sd,'#native-amount','1500');
 await new Promise(x=>setTimeout(x,600));await shot(sd,'16-send-form');assert.equal(await visible(sd),true,'send actions and note visible inside the wallet frame');
 assert.equal(await evaluate(sd,'fixture.calls.some(c=>["construct-send","sign-send"].includes(c.name))'),false,'typing never signs');
 await click(sd,'[data-review]');await wait(sd,'fixture.calls.some(c=>c.name==="send-publish")');
 const sendTerms=await evaluate(sd,'fixture.calls.find(c=>c.name==="construct-send").value');
 assert.deepEqual([sendTerms.recipientAddress,sendTerms.quantity,sendTerms.source.txid],[to,'1500000000','44'.repeat(32)]);
 assert.equal(await evaluate(sd,'fixture.calls.filter(c=>c.name==="sign-send").length'),1);
 assert.equal(await evaluate(sd,'fixture.calls.some(c=>["holder-sign","prepare","approve","sign","sign-redemption"].includes(c.name))'),false,'no Solana wallet approval for a Monero send');
 const sent=JSON.parse(await evaluate(sd,'JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith("xmr20-native-pending-bridges-v1:")&&k.endsWith(fixture.monero)).map(([,v])=>JSON.parse(v).filter(e=>e.to==="address")))'));
 assert.deepEqual(sent.map(l=>l.map(e=>[e.preparationId,e.amountRaw,e.stage,e.txid])),[[['send:'+'88'.repeat(32),'1500000000','sending','88'.repeat(32)]]]);
 await shot(sd,'17-send-published');
 const q=await open('holdings-sent');await wait(q,'document.body.innerText.includes("Monero confirmations · 6/10")');
 assert.match(await evaluate(q,'document.querySelector(".wallet-native-holdings").innerText'),/1,500\.00 EXTREMIST sending[\s\S]*Monero confirmations · 6\/10[\s\S]*Checked before your send[\s\S]*Send\s*Bridge/);
 await clickText(q,'Send');assert.equal(await evaluate(q,'fixture.calls.some(c=>c.name==="send")'),true);await shot(q,'18-monero-tab-sending');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,steps:['scoped-client','visible-actions','max-no-sign','holder-sign-scoped','custody-before-credit','publish','unavailable-message','start-height-once','other-window-lock','reserved-saved-transfer-continue','cancel-saved-bridge','cancel-refused-after-deposit','step-tracker-build-send-confirm','pending-record','balance-check','monero-tab-rows','generic-unchecked','checked-empty','balance-empty','redeem-burn-to-connected-wallet','redeem-no-solana-approval','redeem-outgoing-record','switch-one-session','switch-waits-for-step','monero-tab-leaving-bridge','send-to-monero-address','send-no-solana-approval','send-outgoing-record','monero-tab-send-row'],screenshots:out}));
}finally{
 socket?.close();chrome?.kill('SIGKILL');server?.close();await rm(temp,{recursive:true,force:true});
}
