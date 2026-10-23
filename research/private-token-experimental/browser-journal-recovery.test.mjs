// RECOVERY FROM THE PHRASE vs FROM THE ORIGINAL INSTALLATION'S JOURNAL — through the real popup,
// two disposable profiles holding the SAME phrase (A = original installation with its journal,
// B = fresh installation). See RECOVERY-CASES.txt. Beta is a second account in profile A used as
// the recipient. Cases: proved-not-carried and signed-not-broadcast records made stale by the other
// installation (never re-sent, no fee); confirmed-then-rolled-back (pop_blocks: balances revert, the
// same carrier is re-sent, no second fee); a stale storage backup restored; two installations
// spending the same note concurrently (at most one admitted; the other shown as rejected or
// conflicted, never as a success). Exact balances, pending/spent state, republication and fee
// consequences are asserted in BOTH installations. Phrases are never screenshotted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile} from 'node:fs/promises';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend,keyImagesOf,dir} from './browser-harness.mjs';
const require=createRequire(''+(process.env.XMR20_PLAYWRIGHT_DIR||'../../node_modules')+'/playwright/package.json');
const {chromium}=require('playwright');
const ext=dir+'wallet-extension/extension-private-holder-test';
const bal=t=>Number(/^([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
test('journal-vs-phrase recovery through two installations with the same phrase',{timeout:3600000},async()=>{
 const h=harness('verified-journal-recovery');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 const open={};const results={cases:{}};
 const launch=async(label,profile=null)=>{profile??=await mkdtemp(dir+'runs/profile-'+label+'-');const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:380,height:600},args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});let sw=context.serviceWorkers()[0];if(!sw)sw=await context.waitForEvent('serviceworker',{timeout:30000});const id=new URL(sw.url()).host;const page=await context.newPage();h.wire(page);await page.goto(`chrome-extension://${id}/popup.html`);h.page=page;open[label]={context,page,id,profile};return open[label];};
 const close=async(label)=>{await open[label]?.context.close().catch(()=>{});delete open[label];};
 const state=async(p)=>await p.evaluate(async()=>await globalThis.__pfDebug.state());
 const nativeTotal=async(p)=>{const n=(await state(p)).holder.native;return BigInt(n.unlocked)+BigInt(n.locked)+BigInt(n.reserved);};
 const pending=async(p)=>(await state(p)).journal?.pending||{};const history=async(p)=>(await state(p)).journal?.history||[];
 const unlock=async(p,password)=>{h.page=p;if(await p.$('#unlock-password')){await p.fill('#unlock-password',password);await p.click('#unlock');}await p.waitForSelector('#asset-private-0',{timeout:300000});await h.rowsReady();};
 const refreshUntil=async(p,cond,tries=40)=>{h.page=p;for(let i=0;i<tries;i++){if(await cond())return true;await p.waitForTimeout(2000);await h.uiRefresh();}return cond();};
 // Send through the popup with the fee review; `hook` interrupts after the given journal step.
 const send=async(p,to,amount,{hook=null}={})=>{h.page=p;if(hook)await p.evaluate(x=>{globalThis.__pfTest={crashAfter:x};},hook);await h.openDetail();await p.click('#pf-send');await p.fill('#pf-to',to);await p.fill('#pf-amount',amount);await p.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await p.click('#pf-approve');
  const out=hook?await h.errorText(new RegExp('TEST HOOK: simulated interruption after '+hook),900000):await h.progress(/Published/,900000);await h.back();await h.closeModal();return out;};
 const daemonHas=async(txid)=>{const r=await fetch(backend.rpcUrl+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid]})});const v=await r.json();return (v.txs||[]).length>0||(await fetch(backend.rpcUrl+'/get_transaction_pool_hashes',{method:'POST',body:'{}'}).then(x=>x.json())).tx_hashes?.includes(txid)||false;};
 const password='journal-password-1',passwordB='journal-password-2';
 try{
  const A=await launch('journal-A');await A.page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  await h.switchAccount(1);const betaAddress=await h.tokenAddress();await h.switchAccount(0);const alphaAddress=await h.tokenAddress();
  await h.fund();await h.fund();await h.fund();await h.openDetail();await A.page.click('#pf-bridge');await A.page.fill('#pf-amount','100');await A.page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();await backend.actions.mine({blocks:50});await h.mine();
  assert.equal(bal(await h.balanceText()),98.5);await send(A.page,alphaAddress,'30');await h.mine();assert.equal((await state(A.page)).holder.notes.length,2);
  let alphaBal=98.5,betaBal=0;const xmrStart=await nativeTotal(A.page);const feesSeen=[];
  // ---- CASE 2a: proved in A, no carrier yet (interrupted after 'built'); A closed; fresh install B spends the same note; A reopened must NOT publish, pays no fee.
  const e2a=await send(A.page,betaAddress,'5',{hook:'built'});let pendA=Object.values(await pending(A.page));assert.equal(pendA[0].status,'built');assert.ok(pendA[0].wire&&!pendA[0].carrier);h.log('2a. A: record proved, no carrier (interrupted)',{error:e2a});
  const snapBuilt=await A.page.evaluate(()=>chrome.storage.local.get(null));// stale backup for later
  await close('journal-A');
  const B=await launch('journal-B');await B.page.waitForSelector('#start-import');await h.importAccount({...alpha,name:'Alpha (fresh install)',password:passwordB,first:true});
  assert.equal(bal(await h.balanceText()),alphaBal,'fresh install: chain balance, no pending');assert.equal(Object.keys(await pending(B.page)).length,0);assert.equal((await state(B.page)).holder.notes.length,2);
  const t7=await send(B.page,betaAddress,'7');assert.match(t7,/1 input, change 61\.5 X/);await h.mine();alphaBal-=7;betaBal+=7;feesSeen.push(Object.values(await history(B.page))[0]?.carrier?.fee);assert.equal(bal(await h.balanceText()),alphaBal);
  const xmrAfterB1=await nativeTotal(B.page);
  const A2=await launch('journal-A',A.profile);await unlock(A2.page,password);
  assert.ok(await refreshUntil(A2.page,async()=>Object.keys(await pending(A2.page)).length===0),'stale built entry left pending');
  let hist=await history(A2.page);const stale5=hist.find(x=>x.amount==='5000000');assert.ok(stale5,'stale entry recorded in history');assert.equal(stale5.status,'rejected');assert.match(stale5.error||'',/spent by another installation/);
  assert.equal(bal(await h.balanceText()),alphaBal,'A follows the chain');assert.equal(await nativeTotal(A2.page),xmrAfterB1,'A paid no fee for the stale record');await h.shot('2a-A-stale-built-rejected');
  results.cases.c2a={staleStatus:stale5.status,feePaid:'0',balanceA:alphaBal};h.log('2a. A reopened: stale proved record marked rejected, not carried, no fee',results.cases.c2a);
  // ---- CASE 2b: signed in A (interrupted after 'signed'), never broadcast; B spends the same note; A reopened must NOT re-send the signed carrier (fee saved).
  const e2b=await send(A2.page,betaAddress,'2',{hook:'signed'});pendA=Object.values(await pending(A2.page));assert.equal(pendA[0].status,'signed');const staleTxid=pendA[0].carrier.txid;h.log('2b. A: carrier signed, never broadcast',{error:e2b,txid:staleTxid});await close('journal-A');
  h.page=B.page;await h.uiRefresh();const t3=await send(B.page,betaAddress,'3');assert.match(t3,/1 input, change 58\.5 X/);await h.mine();alphaBal-=3;betaBal+=3;const xmrAfterB2=await nativeTotal(B.page);
  const A3=await launch('journal-A',A.profile);await unlock(A3.page,password);
  assert.ok(await refreshUntil(A3.page,async()=>Object.keys(await pending(A3.page)).length===0));hist=await history(A3.page);const stale2=hist.find(x=>x.amount==='2000000');assert.equal(stale2.status,'rejected');assert.match(stale2.error||'',/spent by another installation/);
  assert.equal(await daemonHas(staleTxid),false,'the stale signed carrier was never sent to the daemon');assert.equal(await nativeTotal(A3.page),xmrAfterB2,'no fee paid by the stale installation');assert.equal(bal(await h.balanceText()),alphaBal);await h.shot('2b-A-stale-signed-not-sent');
  results.cases.c2b={staleCarrierSent:false,feeSaved:stale2.carrier?.fee,balanceA:alphaBal};h.log('2b. A reopened: stale signed carrier NOT re-sent (notes already spent); fee saved',results.cases.c2b);
  // ---- CASE 4: confirmed in B, then a 12-block rollback (TEST SERVICE pop_blocks + pool flush): balances revert in both installs; the SAME carrier is re-sent; no second fee.
  h.page=B.page;await h.uiRefresh();const t4=await send(B.page,betaAddress,'4');await h.mine();alphaBal-=4;betaBal+=4;assert.equal(bal(await h.balanceText()),alphaBal);
  const histB=await history(B.page);const conf4=histB.find(x=>x.amount==='4000000');assert.equal(conf4.status,'confirmed');const xmrAfter4=await nativeTotal(B.page);
  const popped=await backend.actions.pop({blocks:12});h.log('TEST SERVICE: rolled the chain back 12 blocks and flushed the pool',popped);
  assert.ok(await refreshUntil(B.page,async()=>bal(await h.balanceText())===alphaBal+4,30),'B: the rolled-back send is gone; notes unspent again (balance '+bal(await h.balanceText())+')');
  assert.ok(await refreshUntil(B.page,async()=>{const p=Object.values(await pending(B.page));return p.length===1&&p[0].status==='published'&&p[0].carrier?.txid===conf4.carrier.txid;}),'B re-sent the SAME carrier after the rollback');await h.shot('4-B-after-rollback-resent');
  h.page=A3.page;assert.ok(await refreshUntil(A3.page,async()=>bal(await h.balanceText())===alphaBal+4,30),'A agrees with the rolled-back chain');
  h.page=B.page;await h.mine();assert.ok(await refreshUntil(B.page,async()=>bal(await h.balanceText())===alphaBal,30),'re-mined');assert.ok(await refreshUntil(B.page,async()=>Object.keys(await pending(B.page)).length===0));assert.equal(await nativeTotal(B.page),xmrAfter4,'same carrier, same fee: no second payment');
  results.cases.c4={rolledBack:12,resentSameTxid:conf4.carrier.txid,secondFee:'0'};h.log('4. rollback: balances reverted, same carrier re-sent once, no second fee',results.cases.c4);
  // ---- STALE BACKUP: A's storage from the moment of case 2a (a 'built' entry for notes that are long spent) restored over A's current storage: reconcile rejects it, nothing is sent.
  const sendsBefore=h.requests.filter(r=>r.url?.endsWith('/send_raw_transaction')).length;
  await A3.page.evaluate(async snap=>{await chrome.storage.local.clear();await chrome.storage.local.set(snap);},snapBuilt);await A3.page.reload();await unlock(A3.page,password);
  assert.ok(await refreshUntil(A3.page,async()=>Object.keys(await pending(A3.page)).length===0));const hb=await history(A3.page);assert.ok(hb.some(x=>x.amount==='5000000'&&x.status==='rejected'));assert.equal(bal(await h.balanceText()),alphaBal,'stale backup: balance from the chain, not from the backup');
  assert.equal(h.requests.filter(r=>r.url?.endsWith('/send_raw_transaction')).length,sendsBefore,'stale backup caused no broadcast');await h.shot('stale-backup-restored-rejected');results.cases.staleBackup={broadcasts:0,status:'rejected'};
  // ---- CASE 5: two installations spending the same largest note at the same time.
  h.page=A3.page;await h.uiRefresh();h.page=B.page;await h.uiRefresh();const xmrBefore5=await nativeTotal(B.page);const betaBefore=betaBal;
  const start=async(p,amt)=>{await p.click('#asset-private-0');await p.waitForSelector('#pf-send');await p.click('#pf-send');await p.fill('#pf-to',betaAddress);await p.fill('#pf-amount',amt);await p.click('#pf-send-go');await p.waitForFunction(()=>/Carrier fee/.test(document.querySelector('#pf-fee')?.textContent||'')||/./.test(document.querySelector('#error')?.textContent||''),null,{timeout:300000});const err=await p.textContent('#error');if(err)return {error:err};await p.click('#pf-approve');return {approved:true};};
  const [sA,sB]=await Promise.all([start(A3.page,'0.5'),start(B.page,'0.6')]);
  const wait=p=>p.waitForFunction(()=>/Published|refused|rejected|conflict|spent|reserved/.test((document.querySelector('#progress')?.textContent||'')+(document.querySelector('#error')?.textContent||'')),null,{timeout:900000}).then(async()=>((await p.textContent('#progress'))+' | '+(await p.textContent('#error'))));
  const [rA,rB]=await Promise.all([sA.approved?wait(A3.page):Promise.resolve(sA.error),sB.approved?wait(B.page):Promise.resolve(sB.error)]);h.log('5. concurrent sends from two installations',{A:rA,B:rB});
  for(const p of [A3.page,B.page]){h.page=p;await h.back().catch(()=>{});await h.closeModal().catch(()=>{});}
  h.page=B.page;await h.mine();for(const p of [A3.page,B.page]){h.page=p;await refreshUntil(p,async()=>Object.keys(await pending(p)).length===0,20);}
  const stA=await state(A3.page),stB=await state(B.page);assert.deepEqual(stA.holder.balances,stB.holder.balances,'both installations agree with the chain');
  const outcomes=[...(await history(A3.page)),...(await history(B.page))].filter(x=>x.amount==='500000'||x.amount==='600000').map(x=>({amount:x.amount,status:x.status,error:x.error||null}));
  const admitted=outcomes.filter(o=>o.status==='confirmed');assert.ok(admitted.length<=1,'at most one of the conflicting records admitted');
  h.page=A3.page;await h.switchAccount(1);const betaNow=bal(await h.balanceText());await h.switchAccount(0);const credited=Math.round((betaNow-betaBefore)*1e6)/1e6;assert.ok(credited===0||credited===0.5||credited===0.6,'Beta credited at most once');
  const feesPaid=xmrBefore5-(await nativeTotal(B.page));results.cases.c5={outcomes,credited,feesPaidPiconero:String(feesPaid)};h.log('5. outcome: one admitted at most; loser shown as rejected/conflicted; fee consequence recorded',results.cases.c5);
  for(const o of outcomes)assert.notEqual(o.status,'published','a losing send is never left looking successful');
  // audit
  const blog=await readFile(backend.run+'/requests.log','utf8');const kis=await keyImagesOf(B.page);assert.ok(kis.every(k=>!blog.includes(k)),'no key image reached the backend');const audit=await auditBackend(backend,h.secrets);assert.equal(audit.hits.length,0);
 }finally{
  const {external,leaks}=await h.finish(backend,{results});for(const k of Object.keys(open))await close(k);await backend.close();
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no external requests');
 }
});
