// THE REAL POPUP on the unshielded-by-default format: two isolated wallets in the test extension (Playwright Chromium), the
// candidate's backend (public credits, roles binary, LiteSVM custody) and the offline fakechain. Everything the owner would
// click is exercised: deposit -> PUBLIC balance; Send in PUBLIC mode (1 transaction, fee review says so); Shield (1 tx);
// Send in PRIVATE mode (2 transactions, review shows both fees and the total); recipient sees public and shielded balances
// separately; Unshield (1 tx); Bridge redeem from the PUBLIC balance (refused for shielded funds); legacy lot -> PUBLIC note;
// interruption between the two carriers of a private transfer (test hook) recovered by the journal on refresh with the SAME
// second carrier; fresh-profile restore from the phrase; 320x440 review layout; network/secret audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {startBackend,freeLoopbackPort} from './backend/service.mjs';
import {buildTestExtension} from './browser-harness.mjs';
import {harness,auditBackend} from './browser-harness.mjs';
const num=t=>Number(/([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
test('real popup: public by default, explicit shield/unshield, 2-tx private send, bridge from public only, migration, interruption recovery, restore',{timeout:3600000},async()=>{
 // FIX M5: exclusive per-run endpoints; the test extension is built per run with those endpoints compiled in.
 const ports={rpcPort:await freeLoopbackPort(),p2pPort:await freeLoopbackPort(),httpPort:await freeLoopbackPort()};
 const extensionDir=await buildTestExtension(ports);
 const h=harness('verified-popup-unshielded',{extensionDir,backendUrl:`http://127.0.0.1:${ports.httpPort}/`,rpcUrl:`http://127.0.0.1:${ports.rpcPort}/`});await h.start();h.log('isolated endpoints',{...ports,extensionDir});
 const backend=await startBackend({...ports,log:m=>h.log('backend-error',{message:m})});
 let context=null,context2=null;const results={execution:'SIMULATED (offline fakechain, LiteSVM custody, Playwright Chromium, local test extension)',operations:[]};
 try{
  const L=await h.launch('unshielded');context=L.context;h.page=await context.newPage();let page=h.page;const popup=`chrome-extension://${L.id}/popup.html`;
  await page.goto(popup);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');const password='unshielded-password-1';
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  await h.switchAccount(1);const betaAddress=await h.tokenAddress();await h.switchAccount(0);const alphaAddress=await h.tokenAddress();
  assert.ok(alphaAddress.startsWith('xmr20t1')&&betaAddress.startsWith('xmr20t1'),'unified addresses');
  const state=async()=>await page.evaluate(async()=>await globalThis.__pfDebug.state());
  const balances=async()=>{const s=await state();const X=s.backend.assets[0].asset;return {pub:s.holder.public.balances[X]??'0',sh:s.holder.shielded.balances[X]??'0'};};
  const pending=async()=>(await state()).journal?.pending||{};const history=async()=>(await state()).journal?.history||{};
  // 0. Alpha: three coinbase outputs (TEST SERVICE; a private transfer needs two spendable XMR inputs), matured; deposit 100 X -> PUBLIC.
  await h.fund();await h.fund();await h.fund();
  await h.openDetail();await page.click('#pf-bridge');await h.shot('alpha-bridge-form');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');const dep=await h.progress(/Deposit accepted .*PUBLIC credit/);await h.back();await h.closeModal();
  await backend.actions.mine({blocks:50});await h.mine();let b=await balances();assert.equal(b.pub,'98500000');assert.equal(b.sh,'0');
  await h.openDetail();await h.shot('alpha-detail-public-balance');assert.match(await page.textContent('.monero-token-detail'),/Public balance/);assert.match(await page.textContent('.monero-token-detail'),/shielded/);await h.closeModal();
  h.log('deposit arrived as a PUBLIC note',{text:dep.slice(0,160)});
  // Helper: a Send with a mode; returns the review and published texts.
  async function send(mode,to,amount,re,label){await h.openDetail();await page.click('#pf-send');await page.selectOption('#pf-mode',mode);await page.fill('#pf-to',to);await page.fill('#pf-amount',amount);await page.click('#pf-send-go');
   const review=await h.waitText('#pf-fee',/Monero transaction/);if(label)await h.shot(label+'-fee-review');await page.click('#pf-approve');const text=await h.progress(re);if(label)await h.shot(label+'-published');await h.back();await h.closeModal();return {review,text};}
  // 1. PUBLIC send 20 X Alpha -> Beta: the review says ONE transaction; one carrier; Beta's public balance rises.
  const s1=await send('public',betaAddress,'20',/Public transfer published: 1 transaction/,'alpha-public-send');assert.match(s1.review,/Public transfer: 1 Monero transaction/);
  let pend=Object.values(await pending());assert.equal(pend.length,1);assert.equal(pend[0].kind,'public');assert.equal(pend[0].carriers.length,1);results.operations.push({op:'public send 20',carriers:1,fees:[pend[0].carriers[0].fee]});
  await h.mine();b=await balances();assert.equal(b.pub,'78500000');
  // 2. Shield 50 X: ONE transaction; the review names the boundary disclosure.
  await h.openDetail();await page.click('#pf-shield');await h.shot('alpha-shield-form');await page.fill('#pf-amount','50');await page.click('#pf-shield-go');const r2=await h.waitText('#pf-fee',/Monero transaction/);assert.match(r2,/Shield: 1 Monero transaction/);assert.match(r2,/boundary publishes the amount/);await h.shot('alpha-shield-fee-review');await page.click('#pf-approve');const t2=await h.progress(/Shielded 50 X \(1 transaction/);await h.back();await h.closeModal();
  pend=Object.values(await pending());assert.equal(pend.length,1);results.operations.push({op:'shield 50',carriers:1,fees:[pend[0].carriers[0].fee]});
  await h.mine();b=await balances();assert.equal(b.pub,'28500000');assert.equal(b.sh,'50000000');h.log('shielded 50 X',{text:t2.slice(0,160)});
  // 3. PRIVATE send 30 X Alpha -> Beta: the review says TWO transactions with both fees and the total; two carriers with distinct XMR inputs.
  const s3=await send('private',betaAddress,'30',/Private transfer published: 2 transactions/,'alpha-private-send');assert.match(s3.review,/Private transfer: 2 Monero transactions, total carrier fees/);assert.match(s3.review,/Transaction 1: fee [\s\S]*Transaction 2: fee/);
  pend=Object.values(await pending());assert.equal(pend.length,1);assert.equal(pend[0].kind,'private');assert.equal(pend[0].carriers.length,2);assert.notEqual(pend[0].carriers[0].keyImage,pend[0].carriers[1].keyImage);assert.equal(pend[0].wires.length,2);
  const totalFee=BigInt(pend[0].carriers[0].fee)+BigInt(pend[0].carriers[1].fee);assert.ok(s3.review.includes(`total carrier fees`),s3.review);results.operations.push({op:'private send 30',carriers:2,fees:pend[0].carriers.map(c=>c.fee),totalFee:String(totalFee)});
  await h.mine();b=await balances();assert.equal(b.pub,'28500000');assert.equal(b.sh,'20000000');const hist=await history();assert.equal(hist[0].status,'confirmed');assert.equal(hist[0].txids.length,2);
  // Beta: public 20, shielded 30, scanned by Beta's own keys.
  await h.switchAccount(1);b=await balances();assert.equal(b.pub,'20000000');assert.equal(b.sh,'30000000');await h.openDetail();await h.shot('beta-detail-public-and-shielded');await h.closeModal();
  // 4. Beta tries Bridge redeem of 25 X: PUBLIC balance is 20 -> refused with the unshield hint; nothing reserved.
  await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.fill('#pf-amount','25');await page.click('#pf-bridge-go');const refused=await h.errorText(/Insufficient PUBLIC balance.*Unshield first/);await h.shot('beta-redeem-refused-shielded-not-used');assert.equal(Object.keys(await pending()).length,0);await h.back();await h.closeModal();h.log('REFUSED: bridge never unshields silently',{error:refused});
  // 5. Beta funds XMR, unshields 10 X (1 tx), then redeems 25 X publicly; payout after confirmations.
  await h.fund();await h.fund();await backend.actions.mine({blocks:50});await h.mine();
  await h.openDetail();await page.click('#pf-unshield');await h.shot('beta-unshield-form');await page.fill('#pf-amount','10');await page.click('#pf-unshield-go');const r5=await h.waitText('#pf-fee',/Monero transaction/);assert.match(r5,/Unshield: 1 Monero transaction/);await page.click('#pf-approve');await h.progress(/Unshielded 10 X to your public balance \(1 transaction/);await h.back();await h.closeModal();
  pend=Object.values(await pending());results.operations.push({op:'unshield 10',carriers:1,fees:[pend[0].carriers[0].fee]});await h.mine();b=await balances();assert.equal(b.pub,'30000000');assert.equal(b.sh,'20000000');
  await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.fill('#pf-amount','25');await page.click('#pf-bridge-go');const r6=await h.waitText('#pf-fee',/Monero transaction/);assert.match(r6,/public burn\): 1 Monero transaction/);await page.click('#pf-approve');await h.progress(/Burn published \(1 transaction/);await h.back();await h.closeModal();
  await h.mine();b=await balances();assert.equal(b.pub,'5000000');
  await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.evaluate(()=>{for(const d of document.querySelectorAll('#modal details'))d.open=true;});await page.click('[data-payout]');const paid=await h.progress(/Paid 24\.625 X to your Solana address/);await h.shot('beta-payout-paid');await h.back();await h.closeModal();h.log('payout',{text:paid});
  // 6. Beta: interruption BETWEEN the two carriers of a private transfer (test hook after the first publish), then recovery on refresh.
  await h.openDetail();await page.click('#pf-shield');await page.fill('#pf-amount','5');await page.click('#pf-shield-go');await h.waitText('#pf-fee',/Monero transaction/);await page.click('#pf-approve');await h.progress(/Shielded 5 X/);await h.back();await h.closeModal();await h.mine();b=await balances();assert.equal(b.sh,'25000000');
  await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'broadcasting-second'};});
  await h.openDetail();await page.click('#pf-send');await page.selectOption('#pf-mode','private');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','7');await page.click('#pf-send-go');await h.waitText('#pf-fee',/2 Monero transactions/);await page.click('#pf-approve');
  const hooked=await h.errorText(/TEST HOOK: simulated interruption after broadcasting-second/,900000);await h.shot('beta-private-interrupted-between-carriers');await h.back();await h.closeModal();
  pend=Object.values(await pending());assert.equal(pend.length,1);assert.equal(pend[0].kind,'private');assert.equal(pend[0].carriers[0].status,'published');assert.equal(pend[0].carriers[1].status,'broadcasting','second carrier never left');const secondTxid=pend[0].carriers[1].txid;
  await h.mine();b=await balances();assert.equal(b.sh,'25000000','a lone part A moves nothing');
  await h.uiRefresh();await page.waitForFunction(async()=>{const s=await globalThis.__pfDebug.state();const p=Object.values(s.journal?.pending||{})[0];return p&&p.carriers[1]?.status==='published'||s.journal?.history?.some(x=>x.kind==='private'&&x.txids?.length===2);},null,{timeout:300000});
  pend=Object.values(await pending());assert.equal(pend[0]?.carriers?.[1]?.txid??(await history())[0]?.carriers?.[1]?.txid,secondTxid,'the SAME signed second carrier was re-sent, no new fee');
  await h.mine();b=await balances();assert.equal(b.sh,'18000000');await h.switchAccount(0);b=await balances();assert.equal(b.sh,'27000000');h.log('interrupted private transfer completed by journal recovery with the same second carrier',{error:hooked.slice(0,120)});
  // 7. Alpha migrates its synthetic legacy lot -> PUBLIC note of exactly the lot.
  const lot=(await state()).backend.assets[0].legacy[0];await page.click('#asset-legacy-0-0');await page.waitForSelector('#pf-migrate');await h.shot('alpha-legacy-migrate');await page.click('#pf-migrate');const mig=await h.progress(/Claim credited: .* as a PUBLIC note/);await h.closeModal();
  await h.mine();b=await balances();assert.equal(b.pub,String(28_500_000n+BigInt(lot.amount)));h.log('legacy lot migrated publicly',{amount:lot.amount,text:mig.slice(0,120)});
  // 8. Short popup: Send form at 320x440 keeps the primary action, Back and the fee review reachable.
  await page.setViewportSize({width:320,height:440});await h.openDetail();await page.click('#pf-send');await page.selectOption('#pf-mode','private');const vis=await page.evaluate(()=>['#pf-send-go','#pf-back'].map(s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r&&r.bottom<=innerHeight+1&&r.height>0;}));assert.deepEqual(vis,[true,true]);await h.shot('send-form-320x440');await h.back();await h.closeModal();await page.setViewportSize({width:380,height:600});
  // 9. Fresh profile restore: Alpha's phrase in a new browser profile rebuilds the same public and shielded balances.
  const L2=await h.launch('unshielded-restore');context2=L2.context;const page2=await context2.newPage();h.page=page2;await page2.goto(`chrome-extension://${L2.id}/popup.html`);await page2.waitForSelector('#start-import');
  await h.importAccount({...alpha,password:'restore-pw-2',first:true});const s9=await page2.evaluate(async()=>await globalThis.__pfDebug.state());const X=s9.backend.assets[0].asset;assert.equal(s9.holder.public.balances[X],String(28_500_000n+BigInt(lot.amount)));assert.equal(s9.holder.shielded.balances[X],'27000000');assert.equal(s9.holder.tokenAddress,alphaAddress);await h.shot('alpha-restored-fresh-profile');
  h.page=page;
  // 10. Audit: no external requests, no secrets to the backend or in its files, no key images in backend requests.
  const fin=await h.finish(backend,{results});assert.equal(fin.external.length,0,'external requests');assert.equal(fin.leaks.length,0,'secret leaks');
  const audit=await auditBackend(backend,[alpha.seed,beta.seed,alpha.solSecret,beta.solSecret]);assert.equal(audit.hits.length,0);
  await writeFile(h.evidence+'/results.json',JSON.stringify(results,null,1));
 }catch(e){try{const {writeFile}=await import('node:fs/promises');await writeFile(h.evidence+'/console-on-failure.json',JSON.stringify({error:String(e?.message||e).slice(0,500),consoleLines:h.consoleLines.slice(-80),steps:h.steps.slice(-10)},null,1));}catch{}throw e;}
 finally{await context?.close().catch(()=>{});await context2?.close().catch(()=>{});await backend.close();}
});
