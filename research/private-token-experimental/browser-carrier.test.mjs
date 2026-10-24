// HOLDER-FUNDED CARRIERS THROUGH THE REAL POPUP, two isolated wallets.
// The holder's own extension quotes the exact XMR network fee BEFORE proving,
// asks for approval, proves the record, builds and signs the ordinary Monero
// carrier (record in tx_extra) and publishes it straight to the test daemon.
// Covered: 1/2/3-input transfers with exact token change; actual record and
// tx_extra sizes; daemon acceptance; exact XMR fee accounting; no XMR, locked
// XMR, cancellation, interrupted approval, failed construction; lost broadcast
// reply (same carrier re-sent, one fee); restart with a signed carrier; two
// popups concurrently (distinct native inputs); 320x440 review layout;
// redemption carrier; audit: no key image or carrier data reaches the backend,
// no relay requests, no external requests, no secret leaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend,keyImagesOf} from './browser-harness.mjs';
const bal=t=>Number(/^([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
const PICO=1_000_000_000_000n;
test('holder-funded carriers in the real popup (two wallets)',{timeout:3000000},async()=>{
 const h=harness('verified-carrier');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 let context=null;const results={transfers:[]};
 try{
  const L=await h.launch('carrier');context=L.context;h.page=await context.newPage();let page=h.page;const popup=`chrome-extension://${L.id}/popup.html`;
  await page.goto(popup);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');const password='carrier-password-1';
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  await h.switchAccount(1);const betaAddress=await h.tokenAddress();await h.switchAccount(0);const alphaAddress=await h.tokenAddress();
  const state=async()=>await page.evaluate(async()=>await globalThis.__pfDebug.state());
  const nativeTotal=async()=>{const n=(await state()).holder.native;return BigInt(n.unlocked)+BigInt(n.locked)+BigInt(n.reserved);};
  const pending=async()=>(await state()).journal?.pending||{};
  const history=async()=>(await state()).journal?.history||[];
  const daemonTxCount=async()=>h.requests.filter(r=>r.url?.endsWith('/send_raw_transaction')).length;
  // 0. Alpha: two coinbase outputs (TEST SERVICE), matured by 60 blocks; Beta: none yet. Deposit 100 X to Alpha.
  await h.fund();await h.fund();await h.openDetail();await page.click('#pf-bridge');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();
  await backend.actions.mine({blocks:50});await h.mine();assert.equal(bal(await h.balanceText()),98.5);
  const line0=await h.nativeLine();assert.match(line0,/XMR for carrier fees: [1-9][\d.]* XMR spendable/);h.log('Alpha holds matured test XMR (two outputs) for carrier fees',{line:line0});await h.openDetail();await h.shot('alpha-detail-with-xmr-line');await h.closeModal();
  // Helper: one holder-funded send with exact assertions on tokens, sizes and XMR fee.
  async function sendAndCheck(to,amount,expectInputs,expectChange,label){const before=await nativeTotal();const tokBefore=bal(await h.balanceText());
   await h.openDetail();await page.click('#pf-send');const r=await h.sendApprove({to,amount,re:/Published/,shotLabel:label?label+'-fee-review':null});if(label)await h.shot(label+'-published');
   const m=/\((\d+)-byte record, (\d+) inputs?, change ([\d.]+) X; proved locally in (\d+) s; carrier [0-9a-f]+… (\d+) bytes, tx_extra (\d+) bytes, fee ([\d.]+) XMR paid from this wallet\)/.exec(r.text);assert.ok(m,'published text: '+r.text);
   assert.equal(m[1],'996');assert.equal(Number(m[2]),expectInputs);assert.equal(m[3],expectChange);
   const feeMatch=/Carrier fee: ([\d.]+) XMR/.exec(r.fee);assert.equal(feeMatch[1],m[7],'the fee paid equals the fee approved');
   await h.back();await h.closeModal();const pend=Object.values(await pending());assert.equal(pend.length,1);assert.equal(pend[0].status,'published');const carrier=pend[0].carrier;assert.ok(carrier.blob&&carrier.txid&&carrier.keyImage);
   await h.mine();const after=await nativeTotal();assert.equal(before-after,BigInt(carrier.fee),'XMR fell by exactly the carrier fee');assert.equal(bal(await h.balanceText()),Math.round((tokBefore-Number(amount))*1e6)/1e6);
   const row={label,amount,inputs:Number(m[2]),change:m[3],recordBytes:Number(m[1]),nativeBytes:Number(m[5]),extraBytes:Number(m[6]),feeXmr:m[7],feePiconero:carrier.fee,provingS:Number(m[4]),txid:carrier.txid};results.transfers.push(row);h.log('holder-funded transfer confirmed',row);return row;}
  // 1. One input: Alpha -> Beta 20 X (change 78.5); fee shown before proving, approved, paid from Alpha's XMR.
  const t1=await sendAndCheck(betaAddress,'20',1,'78.5','alpha-1-input');assert.equal(t1.nativeBytes,2520);assert.equal(t1.extraBytes,1056);
  // 2. Beta has tokens but NO XMR: the fee quote fails visibly; nothing is reserved or published.
  await h.switchAccount(1);assert.equal(bal(await h.balanceText()),20);await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','5');const txBefore=await daemonTxCount();await page.click('#pf-send-go');
  const noXmr=await h.errorText(/No spendable XMR for the carrier fee: unlocked 0 piconero .*locked 0 \(/,120000);await h.shot('beta-no-xmr-refused');assert.equal(Object.keys(await pending()).length,0,'no reservation left');assert.equal(await daemonTxCount(),txBefore);h.log('REFUSED: Beta has no XMR for the carrier fee (nothing reserved or published)',{error:noXmr});
  // 3. Locked XMR: fund Beta, try at once -> refused with the unlock height; mature -> works (1 input, change 15).
  await h.back();await h.closeModal();await h.fund();await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','5');await page.click('#pf-send-go');const locked=await h.errorText(/No spendable XMR .* locked \d+ \(unlocks by block \d+\)/,120000);h.log('REFUSED: Beta’s XMR is a locked coinbase output',{error:locked});await h.shot('beta-locked-xmr-refused');await h.back();await h.closeModal();
  await backend.actions.mine({blocks:50});await h.mine();await sendAndCheck(alphaAddress,'5',1,'15','beta-1-input');
  // 4. Cancellation at the fee review: nothing proved, reserved or published; the XMR input is released.
  await h.openDetail();await page.click('#pf-send');const c=await h.sendApprove({to:alphaAddress,amount:'1',approve:false,shotLabel:'beta-fee-review-cancel'});assert.match(c.error,/Cancelled before proving/);assert.equal(Object.keys(await pending()).length,0);await h.back();await h.closeModal();await h.uiRefresh();const nAfterCancel=(await state()).holder.native;assert.equal(nAfterCancel.reserved,'0','no XMR left reserved after cancel (after a refresh; the pre-refresh snapshot may still show the released quote)');h.log('cancelled at review: nothing reserved, proved or published',{error:c.error});
  // 5. Interrupted right after approval (test hook): the quoted entry is stale and released; no proof, no fee.
  await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'approved'};});await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','1');await page.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await page.click('#pf-approve');
  const hooked=await h.errorText(/TEST HOOK: simulated interruption after approved/,60000);h.log('interrupted after approval (test hook)',{error:hooked});await h.back();await h.closeModal();await page.waitForTimeout(21000);await h.uiRefresh();assert.equal(Object.keys(await pending()).length,0,'stale quoted entry released');assert.equal((await state()).holder.native.reserved,'0');
  // 6. Two inputs: Alpha 78.5 + 5 -> send 80 (change 3.5). Beta returns 3 and 2 so Alpha can make a 3-input spend.
  await h.switchAccount(0);await h.uiRefresh();assert.equal(bal(await h.balanceText()),83.5);await sendAndCheck(betaAddress,'80',2,'3.5','alpha-2-inputs');
  await h.switchAccount(1);await sendAndCheck(alphaAddress,'3',1,'77','beta-return-3');await sendAndCheck(alphaAddress,'2',1,'75','beta-return-2');// largest-first: Beta spends its 80 X note, then the 77 X change
  // 7. Three inputs: Alpha 3.5 + 3 + 2 -> send 8 (change 0.5).
  await h.switchAccount(0);await h.uiRefresh();assert.equal(bal(await h.balanceText()),8.5);const t3=await sendAndCheck(betaAddress,'8',3,'0.5','alpha-3-inputs');assert.equal(t3.nativeBytes,2520,'carrier size does not depend on the number of token inputs (fixed 996-byte record)');
  // 8. Lost broadcast reply: the daemon accepts the carrier but the popup never hears back -> the SAME signed carrier is re-sent on refresh; one carrier, one fee.
  await h.switchAccount(1);const beforeLost=await nativeTotal();await page.route('**/send_raw_transaction',async route=>{await route.fetch();await route.abort('connectionreset');});
  await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','4');await page.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await page.click('#pf-approve');const lostErr=await h.errorText(/daemon did not answer .* re-sent as the same transaction/,900000);await page.unroute('**/send_raw_transaction');await h.shot('beta-lost-broadcast-reply');
  let pend=Object.values(await pending());assert.equal(pend.length,1);assert.equal(pend[0].status,'signed');const lostTxid=pend[0].carrier.txid;h.log('lost broadcast reply: signed carrier saved in the journal',{error:lostErr,txid:lostTxid});
  await h.back();await h.closeModal();await h.uiRefresh();for(let i=0;i<40;i++){pend=Object.values(await pending());if(pend.length===1&&pend[0].status==='published')break;await page.waitForTimeout(2000);await h.uiRefresh();}
  assert.equal(pend[0].status,'published');assert.equal(pend[0].carrier.txid,lostTxid,'the SAME carrier was re-sent');assert.equal(pend[0].publishAttempts,1);await h.mine();assert.equal(beforeLost-(await nativeTotal()),BigInt(pend[0].carrier.fee),'exactly one fee paid');assert.equal(bal(await h.balanceText()),94);h.log('same carrier re-sent after the lost reply; one fee; tokens exact',{fee:pend[0].carrier.fee});
  // 9. Restart with a signed carrier: interrupted after signing (test hook), lock/unlock -> reconcile re-sends the saved carrier (same txid), one fee.
  const beforeRestart=await nativeTotal();await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'signed'};});await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',alphaAddress);await page.fill('#pf-amount','6');await page.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await page.click('#pf-approve');const sErr=await h.errorText(/TEST HOOK: simulated interruption after signed/,900000);await h.shot('beta-signed-interrupted');
  await h.back();await h.closeModal();let st9=await state();h.log('9. journal right after the signed-interruption',{pending:Object.values(st9.journal?.pending||{}).map(p=>({status:p.status,txid:p.carrier?.txid})),history:(st9.journal?.history||[]).slice(0,3).map(p=>({status:p.status,txid:p.carrier?.txid,error:p.error}))});
  for(let i=0;i<10&&!Object.values(await pending()).some(p=>p.carrier?.txid);i++){await page.waitForTimeout(1000);}
  pend=Object.values(await pending()).filter(p=>p.carrier?.txid);assert.equal(pend.length,1,'signed carrier saved in the journal: '+JSON.stringify(st9.journal));assert.ok(['signed','published'].includes(pend[0].status));const restartTxid=pend[0].carrier.txid;
  await page.click('#lock');await page.waitForSelector('#unlock-password');await page.fill('#unlock-password',password);await page.click('#unlock');await page.waitForSelector('#asset-private-0',{timeout:300000});await h.rowsReady();
  // The popup reopens on the first account; the interrupted send belongs to Beta (account 1).
  await h.switchAccount(1);
  for(let i=0;i<40;i++){pend=Object.values(await pending());if(pend.length===1&&pend[0].status==='published')break;await page.waitForTimeout(2000);await h.uiRefresh();}
  h.log('9. journal after lock/unlock and reconcile',{pending:pend.map(p=>({status:p.status,txid:p.carrier?.txid})),history:(await history()).slice(0,2).map(p=>({status:p.status,txid:p.carrier?.txid}))});
  assert.equal(pend[0]?.status,'published','saved signed carrier re-sent after unlock');assert.equal(pend[0].carrier.txid,restartTxid);await h.mine();assert.equal(beforeRestart-(await nativeTotal()),BigInt(pend[0].carrier.fee));assert.equal(bal(await h.balanceText()),88);h.log('after lock/unlock the saved signed carrier was re-sent once (same transaction)',{txid:restartTxid});
  // 10. Concurrent sends from two popups (Alpha has two XMR outputs): distinct native inputs, no conflicting carriers.
  await h.switchAccount(0);await h.uiRefresh();const nA=(await state()).holder.native;assert.ok(nA.outputs.filter(o=>!o.spent).length>=2,'Alpha has at least two XMR outputs');const beforeConc=await nativeTotal();
  const page2=await context.newPage();h.wire(page2);await page2.goto(popup);await page2.waitForSelector('#asset-private-0',{timeout:300000});
  const start=async(p,amt)=>{await p.click('#asset-private-0');await p.waitForSelector('#pf-send');await p.click('#pf-send');await p.fill('#pf-to',betaAddress);await p.fill('#pf-amount',amt);await p.click('#pf-send-go');await p.waitForFunction(()=>/Carrier fee/.test(document.querySelector('#pf-fee')?.textContent||'')||/./.test(document.querySelector('#error')?.textContent||''),null,{timeout:300000});const err=await p.textContent('#error');if(err)return {error:err};await p.click('#pf-approve');return {approved:true};};
  const [s1,s2]=await Promise.all([start(page,'0.2'),start(page2,'0.1')]);h.log('two popups quoted carriers concurrently',{popup1:s1,popup2:s2});
  const wait=p=>p.waitForFunction(()=>/Published|reserved|No spendable/.test((document.querySelector('#progress')?.textContent||'')+(document.querySelector('#error')?.textContent||'')),null,{timeout:900000}).then(async()=>((await p.textContent('#progress'))+' | '+(await p.textContent('#error'))));
  const [r1,r2]=await Promise.all([s1.approved?wait(page):Promise.resolve(s1.error),s2.approved?wait(page2):Promise.resolve(s2.error)]);await h.shot('alpha-concurrent-popup1');
  const published=[r1,r2].filter(t=>/Published/.test(t)).length;const pendAll=Object.values(await pending());const kis=pendAll.map(p=>p.carrier?.keyImage).filter(Boolean);assert.equal(new Set(kis).size,kis.length,'distinct native inputs across the concurrent carriers');assert.equal(kis.length,published);
  await page2.close();await h.back().catch(()=>{});await h.closeModal().catch(()=>{});await h.mine();const fees=pendAll.reduce((n,p)=>n+BigInt(p.carrier?.fee||0),0n);assert.equal(beforeConc-(await nativeTotal()),fees,'XMR fell by exactly the sum of the carrier fees');h.log('concurrent sends: no conflicting native inputs; fees exact',{published,r1,r2});results.concurrent={published,distinctInputs:true};
  // 11. Review layout at 320x440: approve and cancel stay in view; then cancel.
  await page.setViewportSize({width:320,height:440});await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',betaAddress);await page.fill('#pf-amount','0.1');await page.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await h.shot('short-popup-fee-review');
  const box=async sel=>page.evaluate(s=>{const r=document.querySelector(s)?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom}:null;},sel);for(const sel of ['#pf-approve','#pf-cancel']){const b=await box(sel);assert.ok(b&&b.top>=0&&b.bottom<=441,sel+' visible at 320x440: '+JSON.stringify(b));}
  await page.click('#pf-cancel');await h.errorText(/Cancelled before proving/);await h.back();await h.closeModal();await page.setViewportSize({width:380,height:600});h.log('fee review approve/cancel visible at 320x440');
  // 12. Redemption carrier (925-byte XB3 record) is holder-funded too.
  await h.switchAccount(1);const beforeRedeem=await nativeTotal();await h.openDetail();await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.fill('#pf-amount','1');await page.click('#pf-bridge-go');const feeR=await h.waitText('#pf-fee',/Carrier fee: .* XMR/);assert.match(feeR,/925-byte record/);await page.click('#pf-approve');const burn=await h.progress(/Burn .* published/);const mr=/\((\d+)-byte record.*fee ([\d.]+) XMR paid from this wallet/.exec(burn);assert.equal(mr[1],'925');await h.back();await h.closeModal();
  const redeemCarrier=Object.values(await pending())[0].carrier;await h.mine();assert.equal(beforeRedeem-(await nativeTotal()),BigInt(redeemCarrier.fee));results.redemption={nativeBytes:redeemCarrier.nativeBytes,extraBytes:redeemCarrier.extraBytes,fee:redeemCarrier.fee};h.log('redemption carried by a holder-funded carrier',results.redemption);
  // 13. Audit: no key image / carrier reached the backend; no relay requests; secrets never left.
  const allKi=[...new Set((await keyImagesOf(page)).concat(await (async()=>{await h.switchAccount(0);return keyImagesOf(page);})()))];const blog=await readFile(backend.run+'/requests.log','utf8');assert.ok(allKi.length>=4);assert.ok(allKi.every(k=>!blog.includes(k)),'no key image in backend requests');assert.equal(h.requests.filter(r=>r.url?.endsWith('/action/relay')).length,0,'no relay requests');
  for(const t of results.transfers)assert.ok(!blog.includes(t.txid)||/payout/.test(blog),'carrier txids are not sent to the backend except an explicit payout request');
  const audit=await auditBackend(backend,h.secrets);assert.equal(audit.hits.length,0,JSON.stringify(audit.hits));results.audit={keyImagesChecked:allKi.length,backendHits:0,relayRequests:0};
 }finally{
  const {external,leaks}=await h.finish(backend,{results});await context?.close().catch(()=>{});await backend.close();
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no external requests');
 }
});
