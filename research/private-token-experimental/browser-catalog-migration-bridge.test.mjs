// CATALOG TOKENS THROUGH THE REAL POPUP (offline fakechain + LiteSVM custody with the REAL mint account bytes of XMR20-launched
// tokens). The lib-level migration suite proves the rule per mint; this suite proves the owner's intended experience in the
// actual extension UI for two catalog tokens with different transfer-fee settings:
//   EXTREMIST (0 bps)  : legacy 10,000 -> migrate in the popup -> exactly 10,000 private -> private transfer 4,000 with exact
//                        change -> a 4,000 redemption is refused BEFORE burning (lab single-payout exposure limit) -> bridge back
//                        100 -> payout refused below the depth, paid exactly 100 at depth -> a second request pays nothing ->
//                        deposit 100 from Solana credits exactly 100.
//   LUKE (150 bps)     : migration INTERRUPTED after signing (popup closed) -> the saved signed claim is submitted automatically,
//                        exactly one credit of 10,000 -> bridge back 100 -> paid 98.5 (fee from the real mint bytes) ->
//                        deposit 100 -> 98.5 private.
// Then the first account's phrase is imported into a FRESH browser profile: the migrated lot is gone, the unmigrated one is
// still offered, balances match exactly. Nothing external is contacted; no secret leaves the popup; synthetic holdings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend} from './browser-harness.mjs';

const DEC=6n,unit=10n**DEC;
const raw=n=>BigInt(Math.round(Number(n)*1e6));          // display amount -> atomic units at 6 decimals (all catalog tokens are 6)
const num=t=>Number(String(t).replace(/[^0-9.]/g,''));

test('catalog tokens in the real popup: migrate (incl. interrupted), transfer, bridge out with real per-mint fees, deposit, fresh-profile recovery',{timeout:3600000},async()=>{
 const h=harness('verified-catalog-popup');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 const results={suite:'browser-catalog-migration-bridge',at:new Date().toISOString(),steps:{}};
 let ctxA=null,ctxB=null;
 try{
  const A=await h.launch('catalog-A');ctxA=A.context;h.page=await ctxA.newPage();let page=h.page;await page.goto(`chrome-extension://${A.id}/popup.html`);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha'),beta=await h.newWallet('Beta');const password='catalog-profile-password-1';
  await h.importAccount({...alpha,password,first:true});await h.importAccount({...beta,password,first:false});
  // ---- helpers bound to a symbol (the harness's own helpers target row 0 = the synthetic main token) ----
  const rows=async()=>(await page.evaluate(async()=>(await globalThis.__pfDebug.state()).backend)).assets;
  const idx=async(sym)=>{const r=await rows();const i=r.findIndex(x=>x.symbol===sym);assert.ok(i>=0,'asset row for '+sym);return i;};
  const row=async(sym)=>(await rows()).find(x=>x.symbol===sym);
  const openDetail=async(sym)=>{await page.click('#asset-private-'+(await idx(sym)));await page.waitForSelector('#pf-send');};
  const exact=async(sym)=>{await openDetail(sym);const t=await page.getAttribute('.monero-token-detail .page-title','title');await h.closeModal();return BigInt(Math.round(num(t.split(' ')[0])*1e6));};
  const legacySelector=async(sym)=>'#asset-legacy-'+(await idx(sym))+'-0';
  const migrate=async(sym)=>{await page.click(await legacySelector(sym));await page.waitForSelector('#pf-migrate');await page.click('#pf-migrate');const t=await progressOrError(/Claim credited/);await h.closeModal();return t;};
  // Fee review OR the popup's error, whichever comes first (the harness's sendApprove waits only for the fee and would sit out the timeout on an error).
  const feeOrError=async()=>{await page.waitForFunction(()=>/Carrier fee/.test(document.querySelector('#pf-fee')?.textContent||'')||/./.test(document.querySelector('#error')?.textContent||''),null,{timeout:900000});const err=await page.textContent('#error').catch(()=>'');if(err&&err.trim()){const nat=await page.evaluate(async()=>{const s=await globalThis.__pfDebug.state();const n=s.holder?.native;return n?{tip:n.tip,outputs:n.outputs?.length,scanned:n.scanned??n.height??null,address:(s.nativeAddress||'').slice(0,12)}:null;}).catch(()=>null);throw Error('popup error: '+err.trim()+' | native='+JSON.stringify(nat));}return page.textContent('#pf-fee');};
  const send=async(sym,to,amt,re=/Published/)=>{await openDetail(sym);await page.click('#pf-send');await page.fill('#pf-to',to);await page.fill('#pf-amount',amt);await page.click('#pf-send-go');const fee=await feeOrError();await page.click('#pf-approve');const text=await progressOrError(re);await h.back();await h.closeModal();return {fee,text};};
  const redeem=async(sym,amt)=>{await openDetail(sym);await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.fill('#pf-amount',amt);await page.click('#pf-bridge-go');const fee=await feeOrError();await page.click('#pf-approve');const t=await progressOrError(/Burn .* published/);await h.back();await h.closeModal();return {fee,text:t};};
  // The operator lists a payout only once the burn record is in a block (its reconcile runs on the chain scan), so callers mine first.
  const requestPayout=async(sym)=>{await h.uiRefresh();await openDetail(sym);await page.click('#pf-bridge');await page.selectOption('#pf-direction','redeem');await page.$$eval('#modal details',ds=>ds.forEach(x=>x.open=true));const btn=await page.waitForSelector('[data-payout]',{timeout:60000});const txid=await btn.getAttribute('data-payout');await btn.click();const t=await progressOrError(/Paid |Payout status/);await h.back().catch(()=>{});await h.closeModal();return {txid,text:t};};
  const deposit=async(sym,amt)=>{await openDetail(sym);await page.click('#pf-bridge');await page.fill('#pf-amount',amt);await page.click('#pf-bridge-go');const t=await progressOrError(/Deposit accepted/);await h.back();await h.closeModal();return t;};
  const addressOf=async(sym)=>{await openDetail(sym);const a=(await page.textContent('.monero-token-detail .address')).trim();await h.closeModal();return a;};
  // Wait for a progress text, but fail fast with the popup's own error instead of sitting out the proving timeout.
  const progressOrError=async(re)=>Promise.race([h.progress(re),h.errorText(/./,900000).then(e=>{throw Error('popup error: '+e);})]);
  const claims=async()=>(await page.evaluate(async()=>(await globalThis.__pfDebug.state()).journal?.claims||{}));
  // ---- 0. catalog rows are present with their REAL mint identities and fee settings; each account was offered one legacy lot per token ----
  const r0=await rows();const ext=r0.find(x=>x.symbol==='EXTREMIST'),luke=r0.find(x=>x.symbol==='LUKE');
  assert.ok(ext&&luke,'EXTREMIST and LUKE rows');assert.equal(ext.feeBps,0);assert.equal(luke.feeBps,150);assert.equal(ext.decimals,6);assert.equal(luke.decimals,6);
  assert.match(ext.mint,/^9MwJfFGc/);assert.match(luke.mint,/^KzTQBqjk/);
  assert.equal(ext.legacy.length,1);assert.equal(ext.legacy[0].amount,'10000000000');assert.equal(luke.legacy[0].amount,'10000000000');
  results.steps.rows={EXTREMIST:{mint:ext.mint,feeBps:ext.feeBps,lot:ext.legacy[0].amount},LUKE:{mint:luke.mint,feeBps:luke.feeBps,lot:luke.legacy[0].amount},catalogRows:r0.filter(x=>x.catalog).length};
  // Carrier-fee funding (TEST SERVICE): Alpha one carrier (transfer), Beta three (two redemptions + headroom); matured by 60 blocks.
  await h.switchAccount(0);/* the popup stays on the account imported last */await h.fund();await h.switchAccount(1);await h.fund();await h.fund();await h.fund();await h.switchAccount(0);await backend.actions.mine({blocks:50});await h.mine();h.log('native lines after funding',{alpha:await h.nativeLine(),beta:await (async()=>{await h.switchAccount(1);const t=await h.nativeLine();await h.switchAccount(0);return t;})()});
  const betaAddr=(await h.switchAccount(1),await addressOf('EXTREMIST'));await h.switchAccount(0);
  // ---- 1. Alpha migrates 10,000 legacy EXTREMIST in the popup: exactly 10,000 private, no fee ----
  const m1=await migrate('EXTREMIST');h.log('1. EXTREMIST migrated in the popup',{text:m1.slice(0,200)});await h.shot('1-extremist-migrated');
  await h.mine();assert.equal(await exact('EXTREMIST'),10000n*unit,'exactly 10,000 private EXTREMIST');assert.equal(await page.$(await legacySelector('EXTREMIST').catch(()=>'#none')),null,'legacy row gone');
  results.steps.migrateEXTREMIST={credited:m1.slice(0,160),privateBalance:'10000000000',feeOnMigration:'0'};
  // ---- 2. Beta's LUKE migration is INTERRUPTED after signing: the popup closes, reconcile submits the saved signed claim ----
  await h.switchAccount(1);await page.evaluate(()=>{globalThis.__pfTest={crashAfter:'claim-signed'};});
  await page.click(await legacySelector('LUKE'));await page.waitForSelector('#pf-migrate');await page.click('#pf-migrate');const c2=await h.errorText(/crash|interrupt|test hook/i,120000).catch(()=>'(popup closed by the test hook)');
  await h.closeModal().catch(()=>{});await h.uiRefresh();let cl={};for(let i=0;i<30&&!Object.values(cl).some(c=>c.phase==='submitted');i++){await page.waitForTimeout(2000);await h.uiRefresh();cl=await claims();}
  assert.ok(Object.values(cl).some(c=>c.phase==='submitted'),'saved signed LUKE claim submitted automatically');
  await h.mine();assert.equal(await exact('LUKE'),10000n*unit,'exactly 10,000 private LUKE after the interrupted migration');
  const pool=await page.evaluate(async()=>(await globalThis.__pfDebug.state()).holder.pool);results.steps.interruptedLUKE={hook:'claim-signed',popupText:String(c2).slice(0,120),credits:pool.credits.length,privateBalance:'10000000000'};
  h.log('2. interrupted LUKE migration completed by reconcile; one credit',{credits:pool.credits.length});await h.shot('2-luke-after-interrupted-claim');
  // ---- 3. Alpha -> Beta 4,000 EXTREMIST privately, exact change ----
  await h.switchAccount(0);await h.uiRefresh();h.log('native line before the transfer',{alpha:await h.nativeLine()});const t3=await send('EXTREMIST',betaAddr,'4000',/Published/);await h.mine();
  assert.equal(await exact('EXTREMIST'),6000n*unit,'Alpha change exactly 6,000');await h.switchAccount(1);assert.equal(await exact('EXTREMIST'),4000n*unit,'Beta received exactly 4,000');
  results.steps.transfer={amount:'4000000000',change:'6000000000',fee:t3.fee.slice(0,80)};h.log('3. private transfer with exact change',{fee:t3.fee.slice(0,80)});
  // ---- 4. Beta bridges 4,000 EXTREMIST back to Solana: pending until the depth, then paid EXACTLY 4,000 (0 bps), never twice ----
  const solBefore=BigInt((await row('EXTREMIST')).solanaBalance);
  // 4a. A redemption above the lab's single-payout exposure limit is refused BEFORE anything is proved or burned (attempt 7 of this
  //     suite found the popup burning first and the operator refusing the payout afterwards).
  let over=null;try{await redeem('EXTREMIST','4000');}catch(e){over=e.message;}assert.match(String(over),/Exposure|limit/i,'over-limit redemption refused up front: '+over);await h.closeModal().catch(()=>{});
  const pendAfter=await page.evaluate(async()=>Object.keys((await globalThis.__pfDebug.state()).journal?.pending||{}).length);assert.equal(pendAfter,0,'nothing pending after the refusal');assert.equal(await exact('EXTREMIST'),4000n*unit,'balance untouched by the refused redemption');
  results.steps.redeemOverLimit={requested:'4000000000',refused:String(over).slice(0,200),burned:false};
  const r4=await redeem('EXTREMIST','100');h.log('4. EXTREMIST burn published',{text:r4.text.slice(0,200)});
  await backend.actions.mine({blocks:1});/* the burn is now in a block with 1 confirmation: listed, far below the depth */// The operator REFUSES a payout below the depth (the popup shows its reason); the request must not pay and the entry stays pending.
  let early;try{early=await requestPayout('EXTREMIST');}catch(e){if(!/Only \d+ confirmations|confirmation/i.test(e.message))throw e;await h.closeModal().catch(()=>{});const p=(await row('EXTREMIST')).payouts[0];early={txid:p.txid,text:'refused below depth: '+e.message.slice(0,160)};}
  assert.doesNotMatch(early.text,/^Paid /,'nothing paid before the confirmation depth');
  const p0=(await row('EXTREMIST')).payouts.find(p=>p.txid===early.txid);assert.ok(p0&&p0.status!=='paid',`payout pending before depth (status ${p0?.status}, ${p0?.confirmations} conf)`);
  await h.mine();const paid=await requestPayout('EXTREMIST');assert.match(paid.text,/^Paid 100(\.0+)? EXTREMIST/,'paid exactly 100 EXTREMIST: '+paid.text);
  // A second payout request for the same burn (the popup button is gone once paid; the test asks the operator directly as the button would).
  const again=await backend.actions.payout({symbol:'EXTREMIST',txid:early.txid});assert.equal(again.status,'paid');assert.equal(again.repeated,true,'second request pays nothing');
  const solAfter=BigInt((await row('EXTREMIST')).solanaBalance);assert.equal(solAfter-solBefore,100n*unit,'Solana balance rose by exactly 100 (no token fee on this mint, and no second payout)');
  assert.equal(await exact('EXTREMIST'),3900n*unit,'Beta private EXTREMIST exactly 3,900 after redeeming 100');
  results.steps.redeemEXTREMIST={txid:early.txid,beforeDepth:early.text.slice(0,120),paid:paid.text.slice(0,120),repeat:{status:again.status,repeated:again.repeated},solanaDelta:(solAfter-solBefore).toString(),carrierFee:r4.fee.slice(0,80)};await h.shot('4-extremist-paid');
  // ---- 5. Beta bridges 100 LUKE back: paid 98.5 (150 bps read from the REAL mint account bytes) ----
  const lukeBefore=BigInt((await row('LUKE')).solanaBalance);const r5=await redeem('LUKE','100');await h.mine();const paidL=await requestPayout('LUKE');
  assert.match(paidL.text,/^Paid 98\.5(0+)? LUKE/,'paid 98.5 LUKE: '+paidL.text);const lukeAfter=BigInt((await row('LUKE')).solanaBalance);assert.equal(lukeAfter-lukeBefore,98500000n);
  assert.equal(await exact('LUKE'),9900n*unit,'Beta private LUKE exactly 9,900');results.steps.redeemLUKE={paid:paidL.text.slice(0,120),solanaDelta:(lukeAfter-lukeBefore).toString(),feeBps:150,carrierFee:r5.fee.slice(0,80)};
  // ---- 6. Deposits from Solana: EXTREMIST 100 -> 100 (0 bps); LUKE 100 -> 98.5 (150 bps) ----
  const d6=await deposit('EXTREMIST','100');await h.switchAccount(0);const d6b=await deposit('LUKE','100');await h.mine();
  assert.equal(await exact('LUKE'),98500000n,'Alpha private LUKE 98.5 after a 100 deposit at 150 bps');
  await h.switchAccount(1);assert.equal(await exact('EXTREMIST'),4000n*unit,'Beta private EXTREMIST back to 4,000 after a 100 deposit at 0 bps');
  results.steps.deposits={EXTREMIST:{gross:'100000000',credited:'100000000',text:d6.slice(0,120)},LUKE:{gross:'100000000',credited:'98500000',text:d6b.slice(0,120)}};h.log('6. deposits credited at each mint\'s own fee',{});
  // ---- 7. Fresh profile: Alpha's phrase alone restores the same catalog balances; the migrated lot is not offered again ----
  const finalA={EXTREMIST:await (async()=>{await h.switchAccount(0);return exact('EXTREMIST');})(),LUKE:await exact('LUKE')};
  await ctxA.close();ctxA=null;
  const B=await h.launch('catalog-B');ctxB=B.context;h.page=await ctxB.newPage();page=h.page;await page.goto(`chrome-extension://${B.id}/popup.html`);await page.waitForSelector('#start-import');
  await h.importAccount({...alpha,password:'another-password-2',first:true});
  assert.equal(await exact('EXTREMIST'),finalA.EXTREMIST,'restored EXTREMIST balance');assert.equal(await exact('LUKE'),finalA.LUKE,'restored LUKE balance');
  const rB=await rows();assert.equal(rB.find(x=>x.symbol==='EXTREMIST').legacy.filter(l=>!l.claimed).length,0,'migrated EXTREMIST lot not offered again');
  assert.equal(rB.find(x=>x.symbol==='LUKE').legacy.filter(l=>!l.claimed).length,1,'unmigrated LUKE lot still offered to Alpha');
  results.steps.freshProfile={EXTREMIST:finalA.EXTREMIST.toString(),LUKE:finalA.LUKE.toString(),extremistLegacyOffered:0,lukeLegacyOffered:1};await h.shot('7-fresh-profile');
  results.ok=true;
 }finally{
  const {external,leaks}=await h.finish(backend,{results});await ctxA?.close().catch(()=>{});await ctxB?.close().catch(()=>{});
  const kiOk=await auditBackend(backend,h.secrets).catch(e=>({error:String(e.message)}));results.audit={external:external.length,leaks:leaks.length,backendAudit:kiOk===undefined?'ok':kiOk};
  await backend.close();await writeFile(new URL('./runs/catalog-popup-results.json',import.meta.url),JSON.stringify(results,null,1));
  assert.equal(leaks.length,0);assert.equal(external.filter(e=>!e.failed).length,0);
 }
});
