// FRESH-INSTALL RECOVERY through the real popup, two disposable profiles.
// Profile A: receive, transfer with change, consolidate, redeem. Then profile A
// is closed and the recovery phrase is imported into profile B: a new browser
// profile directory, a new extension database, a different wallet password, and
// no holder vault anywhere (the backend holds none). The restored wallet must
// show the same balance, note count and spent status from the phrase + the
// public parameters + the public chain alone, and must spend successfully.
// Wrong recovery material and account separation are checked in profile B.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend} from './browser-harness.mjs';
const detailText=async(h)=>{await h.openDetail();const t=await h.page.textContent('.monero-token-detail');const addr=(await h.page.textContent('.monero-token-detail .address')).trim();await h.closeModal();return {text:t,address:addr,notes:Number(/(\d+) notes?/.exec(t)?.[1]||0)};};
// Holder-funded send: fee review (exact XMR fee before proving) -> approve -> proved -> carrier signed by this wallet -> published to the daemon.
const send=async(h,to,amt,re=/Published/)=>{await h.openDetail();await h.page.click('#pf-send');const r=await h.sendApprove({to,amount:amt,re});await h.back();await h.closeModal();return r.text;};
test('fresh-install recovery of holder-controlled private tokens (two profiles)',{timeout:3000000},async()=>{
 const h=harness('verified-recovery');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 let ctxA=null,ctxB=null;
 try{
  const A=await h.launch('recovery-A');ctxA=A.context;h.page=await ctxA.newPage();let page=h.page;await page.goto(`chrome-extension://${A.id}/popup.html`);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');const password='profile-a-password-1';
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  await h.switchAccount(1);const betaAddress=(await detailText(h)).address;await h.switchAccount(0);const alphaAddress=(await detailText(h)).address;
  // Carrier-fee funding (TEST SERVICE): one coinbase reward each, matured by 60 blocks.
  await h.fund();await h.switchAccount(1);await h.fund();await h.switchAccount(0);await backend.actions.mine({blocks:50});await h.mine();
  // Receive: deposit 100 X -> 98.5 private.
  await h.openDetail();await page.click('#pf-bridge');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();await h.mine();assert.match(await h.balanceText(),/^98\.50? X/);
  // Transfer with change: 20 X to Beta.
  const t1=await send(h,betaAddress,'20',/change 78\.5 X/);h.log('A: transfer with change',{text:t1});await h.mine();
  // Beta returns three small notes so Alpha holds four notes.
  await h.switchAccount(1);for(const amt of ['5','3','2']){await send(h,alphaAddress,amt);await h.mine();}
  await h.switchAccount(0);let d=await detailText(h);assert.equal(d.notes,4);assert.match(await h.balanceText(),/^88\.50? X/);
  // Consolidate (3 largest -> 1), then redeem 10 X and get paid.
  await h.openDetail();await page.click('#pf-consolidate');await h.waitText('#pf-fee',/Carrier fee: .* XMR/);await page.click('#pf-approve');const cons=await h.progress(/Consolidation published/);h.log('A: consolidation',{text:cons});assert.match(cons,/3 inputs → 1 note of 86\.5 X/);await h.closeModal();await h.mine();
  await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.fill('#pf-amount','10');await page.click('#pf-bridge-go');await h.waitText('#pf-fee',/Carrier fee: .* XMR/);await page.click('#pf-approve');const burn=await h.progress(/Burn .* published/);h.log('A: redemption proved locally',{text:burn});await h.back();await h.closeModal();
  await backend.actions.mine({blocks:10});await h.uiRefresh();await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.$$eval('#modal details',ds=>ds.forEach(x=>x.open=true));await page.waitForSelector('[data-payout]');await page.click('[data-payout]');await h.progress(/Paid 9\.85 X/);await h.back();await h.closeModal();
  d=await detailText(h);const before={balance:await h.balanceText(),notes:d.notes,address:d.address};assert.match(before.balance,/^78\.50? X/);assert.equal(before.notes,2);
  const stateA=await page.evaluate(async()=>await globalThis.__pfDebug.state());const notesA=stateA.holder.notes.map(n=>n.commitment).sort(),spentA=stateA.holder.spent.map(n=>n.commitment).sort();const nativeA=stateA.holder.native.outputs.map(o=>[o.keyImage,o.amount,Boolean(o.spent)]).sort();
  h.log('A: final state before closing the profile (holder-local replay)',{balance:before.balance,notes:notesA.length,spent:spentA.length,tip:stateA.holder.tip});await h.shot('A-alpha-before-close');
  await ctxA.close();ctxA=null;h.log('profile A closed; nothing copied');
  // No holder vault exists anywhere on the backend: only the relay's own native wallet file.
  const runFiles=await readdir(backend.run);assert.ok(!runFiles.some(f=>/\.vault$/.test(f)),'backend holds no wallet vault at all (no holder vault, and no relay wallet since stage 2)');
  // Profile B: fresh directory, fresh extension storage, different password.
  const B=await h.launch('recovery-B');ctxB=B.context;h.page=await ctxB.newPage();page=h.page;await page.goto(`chrome-extension://${B.id}/popup.html`);await page.waitForSelector('#start-import');await h.shot('B-fresh-install-welcome');
  const passwordB='profile-b-password-2';const registrations=[];page.on('response',async r=>{if(r.url().endsWith('/action/register'))registrations.push(await r.json().catch(()=>null));});
  await h.importAccount({...alpha,name:'Alpha restored',password:passwordB,first:true});await h.shot('B-alpha-restored-home');
  const restored=await detailText(h);assert.equal(restored.address,before.address,'same token address derived from the phrase');assert.equal(await h.balanceText(),before.balance,'same balance from local replay');assert.equal(restored.notes,before.notes,'same note count');
  const stateB=await page.evaluate(async()=>await globalThis.__pfDebug.state());assert.deepEqual(stateB.holder.notes.map(n=>n.commitment).sort(),notesA,'same owned notes');assert.deepEqual(stateB.holder.spent.map(n=>n.commitment).sort(),spentA,'same spent status');
  assert.deepEqual(stateB.holder.native.outputs.map(o=>[o.keyImage,o.amount,Boolean(o.spent)]).sort(),nativeA,'the native XMR outputs (and which carriers spent them) are recovered from the chain too');assert.equal(stateB.holder.native.unlocked,stateA.holder.native.unlocked);
  assert.ok(!('privateBalance' in (stateB.backend.assets[0]||{})),'backend state carries no private balance');assert.ok(registrations.some(r=>r?.existing===true),'backend reattached by public token address only');
  h.log('B: restored from phrase + public parameters + public chain (token notes, spent status AND native XMR outputs for carrier fees)',{balance:await h.balanceText(),notes:restored.notes,spent:stateB.holder.spent.length,nativeOutputs:nativeA.length,registration:registrations.find(r=>r?.existing)});await h.shot('B-alpha-restored-detail');
  // Spend after restoration: 77 X needs both recovered notes (76.5 + 2).
  const t2=await send(h,betaAddress,'77');assert.match(t2,/2 inputs, change 1\.5 X/);assert.match(t2,/fee 0\.\d+ XMR paid from this wallet/);h.log('B: private spend after restoration (two recovered inputs)',{text:t2});await h.shot('B-spend-after-restore');await h.mine();assert.match(await h.balanceText(),/^1\.50? X/);
  // Wrong recovery material recovers nothing.
  const wrong=await h.newWallet('Wrong');await h.importAccount({...wrong,name:'Wrong phrase',password:passwordB,first:false});await h.switchAccount(1);assert.match(await h.balanceText(),/^0(\.0+)? X/);const w=await detailText(h);assert.notEqual(w.address,before.address);h.log('B: wrong recovery phrase derives another address and recovers nothing');await h.shot('B-wrong-phrase');
  // Account separation: Beta's phrase in profile B sees only Beta's notes (20 - 10 sent back + 77 received = 87).
  await h.importAccount({...beta,name:'Beta restored',password:passwordB,first:false});await h.switchAccount(2);assert.match(await h.balanceText(),/^87(\.0+)? X/);const bRestored=await detailText(h);assert.equal(bRestored.address,betaAddress);
  const stateBeta=await page.evaluate(async()=>await globalThis.__pfDebug.state());assert.ok(!stateBeta.holder.notes.some(n=>notesA.includes(n.commitment)||stateB.holder.notes.some(m=>m.commitment===n.commitment)),'Beta sees none of Alpha’s notes');h.log('B: account separation holds');
  // Viewing key generated locally and shared explicitly for Alpha restored; it cannot authorize spending.
  await h.switchAccount(0);await h.openDetail();await page.click('#pf-view');const view=await h.progress(/Indexer view: 1\.5 X/);h.log('B: viewing key shared explicitly; indexer sees 1.5 X, cannot spend',{text:view});await h.shot('B-viewing-key-shared');await h.closeModal();
  const audit=await auditBackend(backend,h.secrets);assert.equal(audit.hits.length,0,JSON.stringify(audit.hits));
 }finally{
  const {external,leaks}=await h.finish(backend,{profiles:'A then B (fresh)',scheme:'XMR20-TKD1'});
  await ctxA?.close().catch(()=>{});await ctxB?.close().catch(()=>{});await backend.close();
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no external requests');
 }
});
