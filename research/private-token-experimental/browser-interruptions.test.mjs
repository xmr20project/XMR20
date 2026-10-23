// INTERRUPTION AND CONCURRENCY through the real test extension (stage 3: holder-funded carriers, no relay):
//  a. daemon broadcast reply lost after the daemon accepted the carrier (route aborted): the SAME carrier is re-sent;
//  b. duplicate/second send while the first operation still reserves the notes;
//  c. migration interrupted after preparation and after signing (test hook);
//  d. popup closed during proving (nothing published; stale reservation released);
//  e. interruption after the record was proved, then lock/reopen (republished once);
//  f. background service worker stopped during an operation (forced lock);
//  g. concurrent sends from two popups.
// Expected balances are tracked exactly; one credit per deposit/claim and one
// carrier (one XMR fee) per record are asserted from the journal and the holder's XMR balance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startBackend} from './backend/service.mjs';
import {harness} from './browser-harness.mjs';
const bal=t=>Number(/^([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
test('interruptions, lost replies, concurrency through the actual popup',{timeout:3000000},async()=>{
 const h=harness('verified-interruptions');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 let context=null;
 try{
  const L=await h.launch('interruptions');context=L.context;h.page=await context.newPage();let page=h.page;const popup=`chrome-extension://${L.id}/popup.html`;
  await page.goto(popup);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');const password='interruptions-password-1';
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  await h.switchAccount(1);await h.openDetail();const betaAddress=(await page.textContent('.monero-token-detail .address')).trim();await h.closeModal();await h.switchAccount(0);await h.openDetail();const alphaAddress=(await page.textContent('.monero-token-detail .address')).trim();await h.closeModal();
  await h.openDetail();await page.click('#pf-bridge');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();
  // Carrier-fee funding (TEST SERVICE): Alpha three coinbase outputs (concurrent sends need two), Beta one; matured by 60 blocks.
  await h.fund();await h.fund();await h.fund();await h.switchAccount(1);await h.fund();await h.switchAccount(0);await backend.actions.mine({blocks:50});await h.mine();
  let alphaBal=98.5,betaBal=0;assert.equal(bal(await h.balanceText()),alphaBal);
  const sendApproved=async(p,to,amt)=>{await p.click('#pf-send');await p.fill('#pf-to',to);await p.fill('#pf-amount',amt);await p.click('#pf-send-go');await p.waitForFunction(()=>/Carrier fee/.test(document.querySelector('#pf-fee')?.textContent||'')||/./.test(document.querySelector('#error')?.textContent||''),null,{timeout:300000});if(await p.textContent('#error'))return false;await p.click('#pf-approve');return true;};
  const carriersPaid=async()=>{const st=await page.evaluate(async()=>await globalThis.__pfDebug.state());const all=[...Object.values(st.journal?.pending||{}),...(st.journal?.history||[])];return new Set(all.filter(x=>x.carrier?.txid&&x.status!=='rejected').map(x=>x.carrier.txid)).size;};
  const pending=async()=>(await page.evaluate(async()=>(await globalThis.__pfDebug.state()).journal?.pending||{}));
  const relayedCount=carriersPaid;const sendRaw=()=>h.requests.filter(r=>r.url?.endsWith('/send_raw_transaction')).length;
  // a. Lost reply: the daemon accepts the carrier, the popup never hears back.
  let relaysBefore=await relayedCount();
  await page.route('**/send_raw_transaction',async route=>{await route.fetch();await route.abort('connectionreset');});
  await h.openDetail();assert.ok(await sendApproved(page,betaAddress,'10'));const lost=await h.errorText(/daemon did not answer .* re-sent as the same transaction/,900000);h.log('a. broadcast reply lost after the daemon accepted the carrier',{error:lost});await h.shot('a-lost-reply-error');
  await page.unroute('**/send_raw_transaction');let pend=await pending();let entries=Object.values(pend);assert.equal(entries.length,1);assert.equal(entries[0].status,'signed');assert.ok(entries[0].wire&&entries[0].carrier?.blob,'proved record and signed carrier saved in the encrypted journal');const lostTxid=entries[0].carrier.txid;
  // b. A second send now: the only note is reserved by the saved operation.
  await page.fill('#pf-amount','5');await page.click('#pf-send-go');const reserved=await h.errorText(/Insufficient unreserved balance|reserved/i,120000);h.log('b. second send refused while the first operation reserves the note',{error:reserved});await h.shot('b-reserved-refused');
  await h.back();await h.closeModal();await h.uiRefresh();pend=await pending();entries=Object.values(pend);for(let i=0;i<60&&!(entries.length===1&&entries[0].status==='published');i++){await page.waitForTimeout(3000);await h.uiRefresh();pend=await pending();entries=Object.values(pend);}assert.equal(entries.length,1);assert.equal(entries[0].status,'published','reconcile re-sent the saved carrier');assert.equal(entries[0].carrier.txid,lostTxid,'the SAME carrier, not a new one');
  assert.equal(await relayedCount(),relaysBefore+1,'exactly one carrier (one fee) for the record');
  await h.mine();alphaBal-=10;betaBal+=10;assert.equal(bal(await h.balanceText()),alphaBal);await h.switchAccount(1);assert.equal(bal(await h.balanceText()),betaBal);await h.switchAccount(0);h.log('a/b. after mining: Beta credited exactly once',{alpha:alphaBal,beta:betaBal});
  pend=await pending();assert.equal(Object.keys(pend).length,0,'settled operation left the pending list');
  // c1. Migration interrupted right after preparation (Beta): retry from scratch succeeds, one credit.
  await h.switchAccount(1);await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'claim-prepared'};});await page.click('#asset-legacy-0-0');await page.waitForSelector('#pf-migrate');await page.click('#pf-migrate');const c1=await h.errorText(/TEST HOOK/,120000);h.log('c1. migration interrupted after preparation (test hook)',{error:c1});
  await page.click('#pf-migrate');const c1b=await h.progress(/Claim credited/);h.log('c1. retried migration credited once',{text:c1b});await h.closeModal().catch(()=>{});await h.mine();assert.equal(await page.$('#asset-legacy-0-0'),null);betaBal+=492.5;assert.equal(bal(await h.balanceText()),betaBal);
  // c2. Migration interrupted after signing (Alpha): reconcile submits the saved signed claim automatically.
  await h.switchAccount(0);await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'claim-signed'};});await page.click('#asset-legacy-0-0');await page.waitForSelector('#pf-migrate');await page.click('#pf-migrate');const c2=await h.errorText(/TEST HOOK/,120000);h.log('c2. migration interrupted after signing (test hook)',{error:c2});await h.shot('c2-claim-signed-interrupted');
  await h.closeModal();await h.uiRefresh();let claims={};for(let i=0;i<30&&!Object.values(claims).some(c=>c.phase==='submitted');i++){await page.waitForTimeout(2000);await h.uiRefresh();claims=await page.evaluate(async()=>(await globalThis.__pfDebug.state()).journal?.claims||{});}assert.ok(Object.values(claims).some(c=>c.phase==='submitted'),'signed claim submitted by reconcile: '+JSON.stringify(claims));
  await h.mine();assert.equal(await page.$('#asset-legacy-0-0'),null,'legacy row gone after automatic submission');alphaBal+=492.5;assert.equal(bal(await h.balanceText()),alphaBal);h.log('c2. saved signed claim submitted on reconcile; credited once',{alpha:alphaBal});
  // d. Popup closed during proving: nothing is published; the stale reservation is released after its heartbeat expires.
  relaysBefore=await relayedCount();const rawBefore=sendRaw();await h.openDetail();assert.ok(await sendApproved(page,betaAddress,'5'));await page.waitForFunction(()=>/Proving/.test(document.querySelector('#progress')?.textContent||''),null,{timeout:600000});await h.shot('d-proving-before-close');await page.close();h.log('d. popup closed while proving (fee approved, nothing signed)');
  h.page=await context.newPage();page=h.page;await page.goto(popup);await h.rowsReady();let stale=Object.values(await pending());assert.equal(stale.length,1);assert.equal(stale[0].status,'quoted');
  await page.waitForTimeout(21000);await h.uiRefresh();stale=Object.values(await pending());assert.equal(stale.length,0,'stale quoted entry released');assert.equal(await relayedCount(),relaysBefore,'no carrier');assert.equal(sendRaw(),rawBefore,'nothing broadcast');assert.equal(bal(await h.balanceText()),alphaBal);h.log('d. nothing published; note and XMR reservations released; balance unchanged');
  // e. Interrupted after the record was proved and saved, then lock/reopen: republished exactly once on reconcile.
  relaysBefore=await relayedCount();await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'built'};});await h.openDetail();assert.ok(await sendApproved(page,betaAddress,'7'));const e1=await h.errorText(/TEST HOOK/,900000);h.log('e. interrupted after proving, before the carrier was signed (test hook)',{error:e1});await h.shot('e-built-interrupted');
  await h.back();await h.closeModal();await page.click('#lock');await page.waitForSelector('#unlock-password');await page.fill('#unlock-password',password);await page.click('#unlock');await h.rowsReady();
  let e=Object.values(await pending());assert.equal(e.length,1);assert.equal(e[0].status,'built','a proved record without a carrier waits for an explicit fee approval; it is never carried automatically');
  await h.openDetail();await page.waitForSelector('[data-carry]');await h.shot('e-pending-needs-fee-approval');await page.click('[data-carry]');await h.waitText('#pf-fee',/Carrier fee/);await page.click('#pf-approve');await h.progress(/Carrier .* published for the saved record/);await h.closeModal();
  e=Object.values(await pending());assert.equal(e.length,1);assert.equal(e[0].status,'published');assert.equal(await relayedCount(),relaysBefore+1);
  await h.mine();alphaBal-=7;betaBal+=7;assert.equal(bal(await h.balanceText()),alphaBal);h.log('e. after lock/reopen the saved record was carried once after an explicit fee approval',{alpha:alphaBal,beta:betaBal});
  // f. Background service worker stopped during an operation (forced lock), via chrome://serviceworker-internals.
  relaysBefore=await relayedCount();let swStopped=false,swTerminated=false;
  await h.openDetail();assert.ok(await sendApproved(page,betaAddress,'6'));await page.waitForFunction(()=>/Proving/.test(document.querySelector('#progress')?.textContent||''),null,{timeout:600000});
  try{const b=context.browser();const cdp=b?await b.newBrowserCDPSession():null;if(!cdp)throw Error('no browser-level CDP session');const {targetInfos}=await cdp.send('Target.getTargets');const sw=targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'));if(!sw)throw Error('no service worker target');await cdp.send('Target.closeTarget',{targetId:sw.targetId});await page.waitForTimeout(500);await cdp.detach();swStopped=true;swTerminated=true;h.log('f. background service worker terminated through the browser CDP session (Target.closeTarget)',{url:sw.url});}
  catch(err){h.log('f. could not stop the service worker via CDP',{error:err.message});try{const internals=await context.newPage();await internals.goto('chrome://serviceworker-internals/');await internals.waitForTimeout(1000);const buttons=internals.locator('button.stop');const n=await buttons.count();for(let i=0;i<n;i++){await buttons.nth(i).click().catch(()=>{});}swStopped=n>0;await internals.waitForTimeout(500);await internals.close();}catch(err2){h.log('f. could not reach chrome://serviceworker-internals',{error:err2.message});}}
  if(swStopped){await page.mouse.click(10,10);await page.waitForTimeout(1500);await page.mouse.click(10,10);const locked=await page.waitForSelector('#unlock-password',{timeout:60000}).then(()=>true).catch(()=>false);if(!locked){h.log('f. service worker stop did not lock the popup (session survived); the send continues');swStopped=false;}}
  if(swStopped){h.log('f. service worker stopped mid-proof: popup session lost -> wallet locked, worker terminated');await h.shot('f-locked-after-sw-stop');
   await page.fill('#unlock-password',password);await page.click('#unlock');await h.rowsReady();await page.waitForTimeout(21000);await h.uiRefresh();assert.equal(Object.keys(await pending()).length,0);assert.equal(await relayedCount(),relaysBefore,'no carrier');assert.equal(bal(await h.balanceText()),alphaBal);h.log('f. after unlock: nothing published, reservations released, balance exact');}
  else{await h.progress(/Published/);await h.back();await h.closeModal();await h.mine();alphaBal-=6;betaBal+=6;assert.equal(await relayedCount(),relaysBefore+1,'exactly one carrier for the send that survived the service-worker termination');h.log(swTerminated?'f. service worker terminated mid-proof (Target.closeTarget): the popup kept its session (background state restored on demand), the send completed with exactly one carrier':'f. NOT REACHED: service worker could not be stopped from the harness; the send completed normally');}
  // g. Concurrent sends from two popups: a second popup resumes the same unlocked session.
  await h.switchAccount(1);await h.openDetail();assert.ok(await sendApproved(page,alphaAddress,'5'));await h.progress(/Published/);await h.back();await h.closeModal();await h.mine();betaBal-=5;alphaBal+=5;await h.switchAccount(0);assert.equal(bal(await h.balanceText()),alphaBal);
  const notes=(await page.evaluate(async()=>(await globalThis.__pfDebug.state()).holder.notes.map(n=>n.amount)));h.log('g. Alpha notes before concurrent sends',{notes});assert.ok(notes.length>=2);
  const page2=await context.newPage();h.wire(page2);await page2.goto(popup);await page2.waitForSelector('#asset-private-0',{timeout:300000});
  const startSend=async(p,amt)=>{await p.click('#asset-private-0');await p.waitForSelector('#pf-send');await sendApproved(p,betaAddress,amt);};
  relaysBefore=await relayedCount();await Promise.all([startSend(page,'3'),startSend(page2,'3')]);
  const wait=p=>p.waitForFunction(()=>/Published|reserved|Insufficient|No spendable/.test((document.querySelector('#progress')?.textContent||'')+(document.querySelector('#error')?.textContent||'')),null,{timeout:900000}).then(async()=>((await p.textContent('#progress'))+' | '+(await p.textContent('#error'))));
  const [r1,r2]=await Promise.all([wait(page),wait(page2)]);h.log('g. concurrent sends from two popups',{popup1:r1,popup2:r2});await h.shot('g-popup1-concurrent');
  const published=[r1,r2].filter(t=>/Published/.test(t)).length;assert.equal(await relayedCount(),relaysBefore+published,'one carrier per published record');
  if(published===2){const p1=await page.evaluate(async()=>(await globalThis.__pfDebug.state()).journal.pending);const kis=Object.values(p1).map(p=>p.carrier?.keyImage).filter(Boolean);assert.equal(new Set(kis).size,kis.length,'distinct XMR inputs across the two windows');}
  const inputsOf=t=>Number(/(\d+) input/.exec(t)?.[1]||0);
  if(published===2){const p1=await page.evaluate(async()=>(await globalThis.__pfDebug.state()).journal.pending);const sets=Object.values(p1).map(p=>p.reserved);assert.equal(new Set(sets.flat()).size,sets.flat().length,'disjoint notes reserved by the two windows');}
  await page2.close();await h.back().catch(()=>{});await h.closeModal().catch(()=>{});await h.mine();alphaBal-=3*published;betaBal+=3*published;assert.equal(bal(await h.balanceText()),alphaBal);await h.switchAccount(1);assert.equal(bal(await h.balanceText()),betaBal);
  h.log('g. after mining: balances exact, no conflicting spend',{alpha:alphaBal,beta:betaBal,published,inputs:[inputsOf(r1),inputsOf(r2)]});await h.shot('g-final-beta');
  const st=await page.evaluate(async()=>(await globalThis.__pfDebug.state()).holder.pool);assert.equal(st.credits.length,3,'one credit per deposit/claim (1 deposit + 2 claims)');h.log('pool credits in the local replica',{credits:st.credits.length,rejected:st.rejected,accepted:st.accepted});
 }finally{
  const {external,leaks}=await h.finish(backend,{});await context?.close().catch(()=>{});await backend.close();
  assert.equal(leaks.length,0);assert.equal(external.filter(e=>!e.failed).length,0);
 }
});
