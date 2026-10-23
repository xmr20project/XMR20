import test from 'node:test';
import assert from 'node:assert/strict';
import {startBackend} from './backend/service.mjs';
import {readFile} from 'node:fs/promises';
import {harness,auditBackend,keyImagesOf} from './browser-harness.mjs';
test('private-holder extension: real popup flow with keys in the extension',{timeout:3000000},async()=>{
 const h=harness('verified-browser');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 let context=null;const secretsAll=[];
 try{
  ({context}=await h.launch('A'));h.page=await context.newPage();const page=h.page;const id=(await h.steps.find(s=>s.step==='extension loaded')).id;
  await page.goto(`chrome-extension://${id}/popup.html`);await page.waitForSelector('#start-import');await h.shot('welcome');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');secretsAll.push(...h.secrets);
  const password='disposable-test-password-1';
  await h.importAccount({...alpha,password,first:true});await h.shot('home-alpha-legacy-and-private-rows');
  assert.ok(await page.$('#asset-legacy-0-0'),'legacy row shown and labelled until migrated');assert.match(await page.textContent('#asset-legacy-0-0'),/not migrated/);assert.match(await h.balanceText(),/^0(\.0+)? X/);
  await h.importAccount({...beta,password,first:false});await h.switchAccount(1);await h.shot('home-beta');
  for(let i=0;i<300&&backend.holders.size<2;i++)await new Promise(r=>setTimeout(r,500));assert.equal(backend.holders.size,2,'both holders registered by token address');
  const betaAddress=await h.tokenAddress();assert.ok(betaAddress.startsWith('penumbra1'));const betaHolder=backend.holders.get(betaAddress);assert.ok(betaHolder,'Beta registered under the address the extension derived');assert.equal(betaHolder.sol,beta.sol);
  await h.switchAccount(0);const alphaAddress=await h.tokenAddress();assert.ok(backend.holders.get(alphaAddress));
  // 0. Carrier-fee funding (TEST SERVICE): one coinbase reward to each account, matured by 60 blocks. On mainnet the holder's own XMR pays; nothing is sponsored.
  await h.fund();await h.switchAccount(1);await h.fund();await h.switchAccount(0);await backend.actions.mine({blocks:50});await h.mine();assert.match(await h.nativeLine(),/XMR for carrier fees: [1-9][\d.]* XMR spendable/);h.log('both accounts hold matured test XMR for carrier fees',{alpha:await h.nativeLine()});
  // 1. Solana deposit signed by the extension's Solana key -> automatic private credit to the holder's own address.
  await h.openDetail();await h.shot('alpha-detail-send-above-bridge');
  const sendTop=await page.evaluate(()=>document.querySelector('#pf-send').getBoundingClientRect().top),bridgeTop=await page.evaluate(()=>document.querySelector('#pf-bridge').getBoundingClientRect().top);assert.ok(sendTop<bridgeTop,'Send above Bridge');
  await page.click('#pf-bridge');await page.waitForSelector('#pf-amount');assert.equal(await page.getAttribute('#pf-amount','placeholder'),'0');assert.equal(await page.inputValue('#pf-amount'),'');
  await page.click('#pf-amount-max');assert.equal(await page.inputValue('#pf-amount'),'1000');await page.fill('#pf-amount','100');await h.shot('alpha-deposit-form');await page.click('#pf-bridge-go');const dep=await h.progress(/Deposit accepted/);h.log('REAL: Solana deposit signed in popup, executed in LiteSVM, private credit published to the extension-derived address',{text:dep});await h.shot('alpha-deposit-accepted');
  await h.back();await h.closeModal();await h.mine();assert.match(await h.balanceText(),/^98\.50? X/);h.log('private balance after deposit, scanned locally by the holder worker',{balance:await h.balanceText()});
  // 2. Private transfer with change Alpha -> Beta, proved in the extension.
  await h.openDetail();await page.click('#pf-send');await page.waitForSelector('#pf-to');assert.equal(await page.getAttribute('#pf-amount','placeholder'),'0');
  await page.fill('#pf-to',betaAddress);await page.fill('#pf-amount','40');await h.shot('alpha-send-form');const sa=await h.sendApprove({to:betaAddress,amount:'40',re:/Published .*change 58\.5 X/,shotLabel:'alpha-fee-review-before-proving'});const sent=sa.text;assert.match(sent,/carrier .* 2520 bytes, tx_extra 1056 bytes, fee 0\.\d+ XMR paid from this wallet/);h.log('REAL: private transfer proved in the extension worker and published with exact change',{text:sent});await h.shot('alpha-send-published');
  const m1=/(\d+)-byte record, (\d+) input/.exec(sent);assert.equal(m1[1],'996');assert.equal(m1[2],'1');
  await h.back();await h.closeModal();await h.mine();assert.match(await h.balanceText(),/^58\.50? X/);
  // 3. Insufficient balance and duplicate click protection.
  await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',betaAddress);await page.fill('#pf-amount','999');await page.click('#pf-send-go');await page.click('#pf-send-go').catch(()=>{});assert.match(await h.errorText(/Insufficient private balance/),/Insufficient/);await h.shot('alpha-insufficient');h.log('insufficient balance refused in popup; second click ignored by the busy guard');
  await h.back();await h.closeModal();
  // 4. Legacy migration signed under Alpha's own Monero keys; duplicate replay rejected.
  let claimPost=null;page.on('request',r=>{if(r.url().endsWith('/action/claimSubmit'))claimPost=r.postData();});
  await page.click('#asset-legacy-0-0');await page.waitForSelector('#pf-migrate');await h.shot('alpha-legacy-detail');await page.click('#pf-migrate');const claimed=await h.progress(/Claim credited/);h.log('REAL: migration claim signed by the extension worker under the account keys; credit to the holder address',{text:claimed});await h.shot('alpha-claim-credited');
  await h.back().catch(()=>{});await h.closeModal().catch(()=>{});
  assert.ok(claimPost,'claim request captured');const replay=await fetch('http://127.0.0.1:8940/action/claimSubmit',{method:'POST',headers:{'content-type':'application/json'},body:claimPost});assert.equal(replay.status,400);const replayBody=await replay.json();assert.match(replayBody.error,/already/i);h.log('duplicate claim replay rejected by the backend',{error:replayBody.error});
  await h.mine();assert.equal(await page.$('#asset-legacy-0-0'),null,'legacy row disappears once migrated');assert.match(await h.balanceText(),/^551(\.0+)? X/);await h.shot('alpha-after-migration');
  // 5. Beta: redemption proved in the extension -> payout refused at 9 confirmations, paid once at 10.
  await h.switchAccount(1);assert.match(await h.balanceText(),/^40(\.0+)? X/);await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.waitForSelector('#pf-amount');assert.equal(await page.inputValue('#pf-amount'),'');await page.fill('#pf-amount','10');await page.click('#pf-bridge-go');await h.waitText('#pf-fee',/Carrier fee: .* XMR/);await h.shot('beta-redeem-fee-review');await page.click('#pf-approve');const burn=await h.progress(/Burn .* published/);assert.match(burn,/fee 0\.\d+ XMR paid from this wallet/);h.log('REAL: private burn (925-byte boundary record) proved in the extension and published',{text:burn});assert.match(burn,/925-byte record/);
  await h.back();await h.closeModal();
  await backend.actions.mine({blocks:9});h.log('TEST SERVICE: mined 9 blocks via backend action (burn has 9 confirmations)');await h.uiRefresh();
  await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.$$eval('#modal details',ds=>ds.forEach(d=>d.open=true));await page.waitForSelector('[data-payout]');await h.shot('beta-pending-payout');await page.click('[data-payout]');const refused=await h.errorText(/confirmations/i,60000);h.log('payout refused at 9 confirmations',{error:refused});await h.shot('beta-payout-refused-9-conf');
  await backend.actions.mine({blocks:1});h.log('TEST SERVICE: mined 1 block (10 confirmations)');await h.back();await h.closeModal();await h.uiRefresh();await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.$$eval('#modal details',ds=>ds.forEach(d=>d.open=true));await page.waitForSelector('[data-payout]');await page.click('[data-payout]');const paid=await h.progress(/Paid 9\.85 X/);h.log('TEST SERVICE: operator payout requested from popup; paid once',{text:paid});await h.shot('beta-paid');
  await page.waitForSelector('[data-payout]',{state:'detached',timeout:30000}).catch(()=>{});await h.back();await h.closeModal();await h.openDetail();const betaDetail=await page.textContent('.monero-token-detail');assert.match(betaDetail,/1,?009\.85 X/);await h.closeModal();
  // 6. Explicit viewing-key share (Beta): the key is exported from the worker only now.
  const viewPosts=[];page.on('request',r=>{if(r.url().endsWith('/action/view'))viewPosts.push(r.postData());});
  await h.openDetail();await page.click('#pf-view');const view=await h.progress(/Indexer view: 30 X/);h.log('viewing key exported from the holder worker on explicit request; indexer sees the balance, cannot spend',{text:view});await h.shot('beta-viewing-key-shared');await h.closeModal();
  assert.equal(viewPosts.length,1);assert.match(viewPosts[0],/penumbrafullviewingkey1/);const vkBefore=h.requests.filter(r=>r.url?.endsWith('/action/view')).length;assert.equal(vkBefore,1,'viewing key sent exactly once, only on the share action');
  assert.match(await page.textContent('#asset-private-0'),/Viewing key shared/);
  // 7. Fragmentation: five 1 X notes to Beta; a 34 X spend needs >3 notes -> explicit consolidation with amounts in token units.
  await h.switchAccount(0);for(let i=0;i<5;i++){await h.openDetail();await page.click('#pf-send');await h.sendApprove({to:betaAddress,amount:'1'});await h.back();await h.closeModal();await h.mine();}
  h.log('five 1 X notes sent to Beta (each mined before the next: change must confirm before it can be spent)');await h.switchAccount(1);assert.match(await h.balanceText(),/^35(\.0+)? X/);await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','34');await page.click('#pf-send-go');const frag=await h.errorText(/consolidate|fragmented|three/i,120000);h.log('fragmented balance refused (needs > 3 notes)',{error:frag});await h.shot('beta-fragmented-refused');
  await h.back();await page.waitForSelector('#pf-consolidate');assert.match(await page.textContent('#pf-consolidate'),/6 → 4/);await page.click('#pf-consolidate');await h.waitText('#pf-fee',/Carrier fee: .* XMR/);await page.click('#pf-approve');const cons=await h.progress(/Consolidation published/);h.log('consolidation: three largest notes merged, amounts shown in token units',{text:cons});assert.match(cons,/3 inputs → 1 note of 32 X/);await h.shot('beta-consolidation');await h.closeModal();await h.mine();
  await h.openDetail();await page.click('#pf-send');const after=(await h.sendApprove({to:alphaAddress,amount:'34'})).text;h.log('after consolidation the 34 X spend succeeds',{text:after});assert.match(after,/3 inputs/);await h.shot('beta-consolidated-send');await h.back();await h.closeModal();await h.mine();
  // 8. Short popup height and narrow width: primary action, Back, progress and error stay inside the viewport.
  await page.setViewportSize({width:320,height:440});await h.openDetail();await page.click('#pf-send');await page.waitForSelector('#pf-send-go');
  const box=async sel=>page.evaluate(s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom}:null;},sel);const vh=440;
  for(const sel of ['#pf-send-go','#pf-back','#progress','#error']){const b=await box(sel);assert.ok(b&&b.bottom<=vh+1&&b.top>=0,sel+' visible at 320x440: '+JSON.stringify(b));}
  await h.shot('short-popup-send-form');await h.back();await h.closeModal();await page.setViewportSize({width:380,height:600});h.log('short popup (320x440): Send, Back, progress and error visible without scrolling');
  // 9. Lock, reopen, unlock: keys re-derived in a fresh worker, balances replayed from the chain (no cached balance).
  await page.click('#lock');await page.waitForSelector('#unlock-password');await h.shot('locked');await page.close();h.page=await context.newPage();
  await h.page.goto(`chrome-extension://${id}/popup.html`);await h.page.fill('#unlock-password',password);await h.page.click('#unlock');await h.page.waitForSelector('#asset-private-0',{timeout:300000});await h.rowsReady();await h.shot('reopened-unlocked');h.log('reopened and unlocked; private rows restored by local replay',{balance:await h.balanceText()});
  assert.match(await h.balanceText(),/^580(\.0+)? X/);
  // Backend-side audit: no seed, Solana secret or viewing key stored in the run folder.
  const kis=await keyImagesOf(h.page);const blog=await readFile(backend.run+'/requests.log','utf8');assert.ok(kis.length>0);assert.ok(kis.every(k=>!blog.includes(k)),'no key image reached the test backend');assert.equal(h.requests.filter(r=>r.url?.endsWith('/action/relay')).length,0,'no relay was used');h.log('audit: key images never sent to the backend; no relay requests',{keyImages:kis.length});
  const vk=viewPosts[0]&&JSON.parse(viewPosts[0]).viewingKey;const audit=await auditBackend(backend,[...secretsAll,vk]);assert.equal(audit.hits.length,0,'no test secret or viewing key stored by the backend: '+JSON.stringify(audit.hits));h.log('backend run folder audited for secrets',audit);
 }finally{
  const {external,leaks}=await h.finish(backend,{wasm:'vendor/holder.wasm',scheme:'XMR20-TKD1'});
  await context?.close().catch(()=>{});await backend.close();
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no successful request outside the extension, the loopback backend and the test daemon');
 }
});
