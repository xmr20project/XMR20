// THE ACTUAL POPUP ON PUBLIC STAGENET — "XMR20 Stagenet — Test funds only" build, two fresh test accounts, real blocks.
// EXECUTED ON STAGENET (not a simulation): worthless faucet coins, the isolated stagenet node (127.0.0.1:38091), the lab
// issuer as a labelled TEST SERVICE for the initial credits. Everything the user would do happens in the real popup:
//   receive tokens (issuer test credits to Alice), send with exact change (Alice -> Bob 3 X of a 10 X note), an ACTUAL lost
//   broadcast reply (the node answered, the reply was dropped before the popup saw it: lookup-before-retry, nothing re-sent),
//   close/reopen and lock/unlock without any re-send, confirmation after 10 stagenet blocks, exact token balances and exact
//   XMR fee accounting, then recovery of BOTH accounts into a FRESH installation (new profile, phrase only).
// Resumable: the persistent profile runs/profile-stagenet-popup and runs/stagenet-popup-state.json record finished phases
// (public facts only: token addresses, stagenet addresses, txids, fees; never a phrase or key). Stagenet waits are long
// (10 confirmations ~ 30-60 min each); the test refreshes the popup every 90 s while waiting.
// Simulated counterpart (offline fakechain, minutes): browser-carrier.test.mjs. This file never touches mainnet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {startStagenetBackend} from './backend/stagenet-service.mjs';
import {harness,stagenetExt,dir} from './browser-harness.mjs';
const BACKEND='http://127.0.0.1:8961/',RPC='http://127.0.0.1:38091/',THIRD_PARTY='http://node.monerodevs.org:38089';
const CONF=10,PASSWORD='stagenet-test-password-1';const bal=t=>Number(/^([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
const ST=dir+'runs/stagenet-popup-state.json',PROFILE=dir+'runs/profile-stagenet-popup';
const now=()=>new Date().toISOString();
async function observe(txids){const out={};for(const [name,url] of [['owner-node','http://127.0.0.1:38091'],['third-party node.monerodevs.org:38089',THIRD_PARTY]]){try{const r=await fetch(url+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:txids,decode_as_json:false,prune:true}),signal:AbortSignal.timeout(40000)});const v=await r.json();out[name]={status:v.status,missed:v.missed_tx||[],txs:Object.fromEntries((v.txs||[]).map(t=>[t.tx_hash,{in_pool:t.in_pool,block_height:t.block_height,confirmations:t.confirmations,pruned_bytes:(t.pruned_as_hex||'').length/2||null}]))};}catch(e){out[name]={error:String(e.message).slice(0,160)};}}return out;}
test('actual popup on public stagenet: receive, send with change, lost reply, reopen, confirm, fresh recovery',{timeout:16_200_000},async()=>{
 const h=harness('stagenet-popup',{extensionDir:stagenetExt,backendUrl:BACKEND,rpcUrl:RPC});await h.start();
 let st={phases:{},accounts:{},results:{},execution:'EXECUTED ON STAGENET (real popup, real blocks, worthless faucet coins; not mainnet)',startedAt:now()};try{st={...st,...JSON.parse(await readFile(ST,'utf8'))};st.resumedAt=now();}catch{}
 const save=()=>writeFile(ST,JSON.stringify(st,null,1));
 const backend=await startStagenetBackend({httpPort:8961,log:m=>h.log('service',{message:String(m).slice(0,300)})});
 const results={};let context=null,context2=null;const seeds={};
 try{
  const L=await h.launch('stagenet-popup',PROFILE);context=L.context;h.page=await context.newPage();let page=h.page;const popup=`chrome-extension://${L.id}/popup.html`;
  await page.goto(popup);await page.waitForFunction(()=>document.querySelector('#start-import')||document.querySelector('#unlock-password'),null,{timeout:60000});
  const mname=await page.evaluate(()=>chrome.runtime.getManifest().name);assert.equal(mname,'XMR20 Stagenet — Test funds only');
  const state=async()=>await page.evaluate(async()=>await globalThis.__pfDebug.state());
  const nativeTotal=async()=>{const n=(await state()).holder.native;return BigInt(n.unlocked)+BigInt(n.locked)+BigInt(n.reserved);};
  const pending=async()=>(await state()).journal?.pending||{};const history=async()=>(await state()).journal?.history||[];
  const sends=()=>h.requests.filter(r=>r.url?.endsWith('/send_raw_transaction')).length;
  const unlock=async()=>{await page.fill('#unlock-password',PASSWORD);await page.click('#unlock');await page.waitForSelector('#asset-private-0',{timeout:600000});await h.rowsReady();};
  // Refresh the popup every `every` ms until `pred` holds (stagenet blocks are minutes apart).
  const waitFor=async(label,pred,timeoutMs,every=90000)=>{const t0=Date.now();for(;;){await h.uiRefresh();const v=await pred();if(v)return v;if(Date.now()-t0>timeoutMs)throw Error('timeout waiting for '+label);await page.waitForTimeout(every);}};
  // ---- 0. accounts -------------------------------------------------------------------------------------------------
  if(await page.$('#start-import')){const alice=await h.newWallet('Alice-stagenet'),bob=await h.newWallet('Bob-stagenet');seeds.A={seed:alice.seed,solSecret:alice.solSecret};seeds.B={seed:bob.seed,solSecret:bob.solSecret};
   await h.importAccount({...alice,password:PASSWORD,first:true});await h.importAccount({...bob,password:PASSWORD,first:false});h.log('two fresh test accounts created in the stagenet popup (keys derived in the extension; phrases never leave the browser)');}
  else{await unlock();h.log('resumed: existing profile unlocked');}
  assert.match(await page.textContent('.network'),/STAGENET/,'network badge');await h.shot('home-stagenet-badge');
  const sB=await (async()=>{await h.switchAccount(1);const t=await h.tokenAddress();const s=await state();return {token:t,native:s.nativeAddress,net:s.backend?.network};})();
  const sA=await (async()=>{await h.switchAccount(0);const t=await h.tokenAddress();const s=await state();return {token:t,native:s.nativeAddress,net:s.backend?.network,nettype:s.backend?.nettype};})();
  for(const [k,v] of [['A',sA],['B',sB]]){assert.ok(v.token.startsWith('penumbra1'));assert.match(v.native,/^5[1-9A-HJ-NP-Za-km-z]{94}$/,'stagenet XMR address');assert.equal(v.net,'stagenet');if(st.accounts[k])assert.equal(st.accounts[k].token,v.token,'same account after resume');st.accounts[k]={token:v.token,native:v.native};}
  await save();h.log('accounts on STAGENET',{A:sA,B:sB});await h.openDetail();await h.shot('alice-detail-addresses');await h.closeModal();
  // ---- 1. funding: faucet (XMR for fees) + two issuer test credits (tokens) to Alice ------------------------------------
  if(!st.phases.faucet){await h.openDetail();await page.click('#pf-faucet');const t=await h.progress(/Faucet sent|Faucet refused/,120000);await h.closeModal();
   if(/Faucet refused/.test(t)){h.log('faucet refused (rate limit); waiting 61 minutes for one retry',{text:t});await page.waitForTimeout(61*60000);await h.openDetail();await page.click('#pf-faucet');const t2=await h.progress(/Faucet sent|Faucet refused/,120000);await h.closeModal();assert.match(t2,/Faucet sent/,'faucet: '+t2);st.phases.faucet={at:now(),text:t2.slice(0,200)};}
   else st.phases.faucet={at:now(),text:t.slice(0,200)};await save();h.log('TEST SERVICE: public faucet claim for Alice',st.phases.faucet);}
  if(!st.phases.credits){const credits=[];for(let i=0;i<2;i++){let ok=false;for(let attempt=0;attempt<6&&!ok;attempt++){await h.openDetail();await page.click('#pf-credit');try{const t=await h.progress(/Test issuer published credit/,180000);const m=/credit ([0-9a-f]{16})… for ([\d.,]+) X .*fee ([\d.]+) XMR/.exec(t);credits.push({txidPrefix:m?.[1],amount:m?.[2],issuerFeeXmr:m?.[3],at:now()});ok=true;}
     catch(e){const err=await page.textContent('#error').catch(()=>'');h.log('credit attempt failed; retrying after a wait',{attempt,error:err.slice(0,200)});await h.closeModal().catch(()=>{});await page.waitForTimeout(120000);continue;}await h.closeModal();}
    assert.ok(ok,'issuer credit '+(i+1));}
   st.phases.credits={credits,at:now()};await save();h.log('TEST SERVICE: two issuer credits of 10 X each published to Alice',st.phases.credits);}
  // ---- 2. wait until Alice holds spendable stagenet XMR and the two notes ---------------------------------------------
  const funded=await waitFor('faucet unlocked and 20 X credited',async()=>{const s=await state();const n=s.holder?.native;const b=bal(await h.balanceText());return n&&BigInt(n.unlocked)>0n&&b===20?{unlocked:n.unlocked,balance:b,tip:s.holder.tip}:null;},100*60000);
  h.log('Alice funded on stagenet',funded);await h.openDetail();await h.shot('alice-funded');await h.closeModal();
  const nativeStart=await nativeTotal();results.nativeStart=nativeStart.toString();
  // ---- 3. send with exact change: Alice -> Bob 3 X from a 10 X note (change 7) ---------------------------------------
  if(!st.phases.send1){await h.openDetail();await page.click('#pf-send');const r=await h.sendApprove({to:sB.token,amount:'3',re:/Published/,shotLabel:'alice-send-3-fee-review'});await h.shot('alice-send-3-published');
   const m=/\((\d+)-byte record, (\d+) inputs?, change ([\d.]+) X; proved locally in (\d+) s; carrier [0-9a-f]+… (\d+) bytes, tx_extra (\d+) bytes, fee ([\d.]+) XMR paid from this wallet\)/.exec(r.text);assert.ok(m,'published text: '+r.text);
   assert.equal(m[1],'996');assert.equal(Number(m[2]),1);assert.equal(m[3],'7');assert.equal(/Carrier fee: ([\d.]+) XMR/.exec(r.fee)[1],m[7],'fee paid = fee approved');
   await h.back();await h.closeModal();const pend=Object.values(await pending());const p=pend.find(x=>x.amount==='3000000');assert.ok(p&&p.status==='published','send1 published: '+JSON.stringify(pend.map(x=>x.status)));
   st.phases.send1={txid:p.carrier.txid,fee:p.carrier.fee,nativeBytes:p.carrier.nativeBytes,extraBytes:p.carrier.extraBytes,recordBytes:996,inputs:1,change:'7',provingS:Number(m[4]),feeReview:r.fee.slice(0,220),at:now()};await save();h.log('send with exact change published on stagenet',st.phases.send1);}
  // ---- 4. close/reopen and lock/unlock: the pending operation survives and NOTHING is re-sent ------------------------
  if(!st.phases.reopen){const sendsBefore=sends();await page.close();h.page=await context.newPage();page=h.page;await page.goto(popup);await page.waitForFunction(()=>document.querySelector('#unlock-password')||document.querySelector('#asset-private-0')||document.querySelector('#pf-loading'),null,{timeout:60000});
   if(await page.$('#unlock-password'))await unlock();else await h.rowsReady();await h.switchAccount(0);await h.openDetail();const pendTexts=await page.$$eval('details[open] .review-line strong',els=>els.map(e=>e.textContent));await h.shot('alice-pending-after-reopen');await h.closeModal();
   await page.click('#lock');await page.waitForSelector('#unlock-password');await unlock();await h.switchAccount(0);await h.uiRefresh();
   const pend=Object.values(await pending()).concat(await history());const p=pend.find(x=>x.carrier?.txid===st.phases.send1.txid);assert.ok(p,'send1 still journaled after reopen + lock/unlock');assert.ok(['published','mined','confirmed'].includes(p.status),'status '+p.status);
   assert.equal(sends()-sendsBefore,0,'no send request after reopen and lock/unlock (lookup only)');st.phases.reopen={statusAfter:p.status,pendingTexts:pendTexts,at:now()};await save();h.log('close/reopen + lock/unlock: pending kept, nothing re-sent',st.phases.reopen);}
  // ---- 5. wait for send1 to confirm (10 blocks) — this also unlocks Alice's XMR change for the next carrier -------------
  const c1=await waitFor('send1 confirmed and XMR change unlocked',async()=>{const hist=await history();const c=hist.find(x=>x.carrier?.txid===st.phases.send1.txid&&x.status==='confirmed');const n=(await state()).holder.native;return c&&BigInt(n.unlocked)>0n?{confirmations:c.confirmations,height:c.height,unlocked:n.unlocked}:null;},120*60000);
  h.log('send1 confirmed on stagenet',c1);results.send1={...st.phases.send1,...c1};
  // ---- 6. ACTUAL lost broadcast reply: node answers, the reply never reaches the popup; lookup-before-retry -------------
  if(!st.phases.lost){const sendsBefore=sends();await page.route('**/send_raw_transaction',async route=>{await route.fetch();await route.abort('connectionreset');});
   await h.openDetail();await page.click('#pf-send');const r=await h.sendApprove({to:sB.token,amount:'2',re:/Published .*nothing was re-sent/,shotLabel:'alice-send-2-fee-review'});await page.unroute('**/send_raw_transaction');await h.shot('alice-lost-reply-recovered');
   await h.back();await h.closeModal();const p=Object.values(await pending()).find(x=>x.amount==='2000000');assert.ok(p,'send2 journaled');assert.equal(p.status,'published','recovered by lookup: '+(p.error||''));assert.equal(p.recovered,true);assert.equal(p.publishAttempts,1);assert.equal(p.resends||0,0);assert.equal(sends()-sendsBefore,1,'exactly one send request left the popup');
   const m=/change ([\d.]+) X/.exec(r.text);st.phases.lost={txid:p.carrier.txid,fee:p.carrier.fee,nativeBytes:p.carrier.nativeBytes,change:m?.[1],recovered:true,sendRequests:1,text:r.text.slice(0,260),at:now()};await save();h.log('ACTUAL lost reply on stagenet: node answered, reply dropped; popup asked the node and re-sent nothing',st.phases.lost);}
  // ---- 7. confirmation of send2, exact balances and exact fees -----------------------------------------------------------
  const c2=await waitFor('send2 confirmed',async()=>{const hist=await history();const c=hist.find(x=>x.carrier?.txid===st.phases.lost.txid&&x.status==='confirmed');return c?{confirmations:c.confirmations,height:c.height}:null;},120*60000);
  results.lost={...st.phases.lost,...c2};assert.equal(Object.keys(await pending()).length,0,'nothing pending');
  const aBal=bal(await h.balanceText());assert.equal(aBal,15,'Alice 20 - 3 - 2');const nativeEnd=await nativeTotal();const fees=BigInt(st.phases.send1.fee)+BigInt(st.phases.lost.fee);
  assert.equal(nativeStart-nativeEnd,fees,'Alice XMR fell by exactly the two carrier fees');await h.openDetail();await h.shot('alice-confirmed-history');await h.closeModal();
  await h.switchAccount(1);const bBal=bal(await h.balanceText());assert.equal(bBal,5,'Bob received 3 + 2');await h.openDetail();await h.shot('bob-received');await h.closeModal();
  results.balances={A:aBal,B:bBal,nativeStart:nativeStart.toString(),nativeEnd:nativeEnd.toString(),feesPiconero:fees.toString()};h.log('exact balances and fees after confirmation',results.balances);
  results.observation=await observe([st.phases.send1.txid,st.phases.lost.txid]);h.log('third-party observation',results.observation);
  // ---- 8. fresh installation from the phrases only (new profile): same balances, nothing pending --------------------------
  const reveal=async(index)=>{if(seeds[index==0?'A':'B'])return seeds[index==0?'A':'B'];await h.switchAccount(index);await page.click('#nav-settings');await page.click('#recovery');await page.fill('#recovery-password',PASSWORD);await page.click('#reveal');await page.waitForSelector('.secrets');const s=await page.$$eval('.secrets',els=>els.map(e=>e.textContent.trim()));await h.closeModal();await page.click('#nav-home');return {solSecret:s[0],seed:s[1]};};
  const bKeys=await reveal(1),aKeys=await reveal(0);h.secrets.push(bKeys.seed,aKeys.seed,bKeys.solSecret,aKeys.solSecret);
  const h2=harness('stagenet-popup-fresh',{extensionDir:stagenetExt,backendUrl:BACKEND,rpcUrl:RPC});await h2.start();h2.secrets.push(...h.secrets);
  const L2=await h2.launch('stagenet-fresh');context2=L2.context;h2.page=await context2.newPage();await h2.page.goto(`chrome-extension://${L2.id}/popup.html`);await h2.page.waitForSelector('#start-import');
  await h2.importAccount({name:'Bob-fresh',seed:bKeys.seed,solSecret:bKeys.solSecret,password:'fresh-password-2',first:true});const bFresh=bal(await h2.balanceText());const bTok=await h2.tokenAddress();await h2.shot('bob-fresh-installation');
  await h2.importAccount({name:'Alice-fresh',seed:aKeys.seed,solSecret:aKeys.solSecret,password:'fresh-password-2',first:false});await h2.switchAccount(1);const aFresh=bal(await h2.balanceText());const aTok=await h2.tokenAddress();const freshPending=await h2.page.evaluate(async()=>{const s=await globalThis.__pfDebug.state();return {pending:Object.keys(s.journal?.pending||{}).length,history:(s.journal?.history||[]).length};});await h2.shot('alice-fresh-installation');
  assert.equal(bTok,sB.token);assert.equal(aTok,sA.token);assert.equal(bFresh,5);assert.equal(aFresh,15);assert.equal(freshPending.pending,0);
  results.freshRecovery={A:aFresh,B:bFresh,sameAddresses:true,pending:freshPending};h2.log('fresh installation from phrases only: same addresses, same balances, nothing pending',results.freshRecovery);
  const f2=await h2.finish(backend,{results:results.freshRecovery});assert.equal(f2.leaks.length,0);assert.equal(f2.external.filter(e=>!e.failed).length,0);
  st.phases.done={at:now()};st.results=results;await save();
 }finally{
  results.finishedAt=now();const {external,leaks}=await h.finish(backend,{results,state:st});await context2?.close().catch(()=>{});await context?.close().catch(()=>{});await backend.close().catch(()=>{});
  await writeFile(dir+'runs/stagenet-popup-results.json',JSON.stringify({execution:st.execution,evidence:h.evidence,results,phases:st.phases,accounts:st.accounts},null,1));
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no external requests from the popup: '+JSON.stringify(external.slice(0,3)));
 }
});
