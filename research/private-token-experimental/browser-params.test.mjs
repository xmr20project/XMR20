// PARAMETER AUTHENTICATION THROUGH THE REAL POPUP. The test backend serves
// faulty parameter files (corrupted query vector with the expected verifying
// key, truncated, missing, foreign configuration) and the popup must show a
// visible refusal with nothing proved, reserved or published. Then the genuine
// files are accepted and a transfer is proved and published. Cache corruption
// and restart from the verified cache are exercised through lock/unlock (a new
// holder worker each time). Secrets are never screenshotted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend,dir} from './browser-harness.mjs';
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
test('parameter authentication in the real popup (faults, cache, restart)',{timeout:2400000},async()=>{
 const h=harness('verified-params');await h.start();
 const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 let context=null;
 try{
  const L=await h.launch('params');context=L.context;h.page=await context.newPage();const page=h.page;
  await page.goto(`chrome-extension://${L.id}/popup.html`);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha');const password='params-password-1';
  await h.importAccount({...alpha,password,first:true});
  const me=await h.tokenAddress();const st0=await page.evaluate(async()=>await globalThis.__pfDebug.state());
  assert.equal(st0.parameters.pinnedInBuild,true);assert.match(st0.parameters.label,/DISPOSABLE TEST SETUP/);assert.equal(st0.parameters.files.normal.sha256,MANIFEST.files.normal.sha256);
  await h.openDetail();const paramsText=await page.textContent('#pf-params');assert.match(paramsText,/authenticated against the manifest shipped in this build/);await h.shot('detail-parameters-note');await h.closeModal();
  h.log('popup reports the shipped parameter manifest (label, pinned hash) and authenticates against it',{label:st0.parameters.label,manifestSha256:st0.parameters.manifestSha256});
  // Deposit 100 X -> 98.5 private; carrier-fee funding (TEST SERVICE) matured by 60 blocks (holder-funded carriers since stage 2).
  await h.openDetail();await page.click('#pf-bridge');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();await h.fund();await h.fund();await backend.actions.mine({blocks:50});await h.mine();assert.match(await h.balanceText(),/^98\.50? X/);
  const relayCount=()=>h.requests.filter(r=>r.url?.endsWith('/action/relay')).length;
  const attempt=async(label,fault,re)=>{backend.faults.normal=fault;const before=relayCount();
   await h.openDetail();await page.click('#pf-send');await page.fill('#pf-to',me);await page.fill('#pf-amount','10');await page.click('#pf-send-go');await h.waitText('#pf-fee',/Carrier fee/);await page.click('#pf-approve');// parameters are authenticated AFTER the fee approval and BEFORE proving
   const err=await h.errorText(re,300000);await h.shot('refused-'+label);
   await h.back();await h.closeModal();await h.uiRefresh();const st=await page.evaluate(async()=>await globalThis.__pfDebug.state());assert.equal(Object.keys(st.journal?.pending||{}).length,0,'no reservation or record left in the journal after '+label);assert.equal(st.holder.native.reserved,'0','XMR input released after '+label);
   assert.equal(relayCount(),before,'nothing was published after '+label);
   const params=await page.evaluate(async()=>await globalThis.__pfDebug.parameters());assert.equal(params.engine.normalLoaded,false,'no proving key loaded after '+label);
   backend.faults.normal=null;h.log('REFUSED visibly, nothing proved or published: '+label,{error:err});return err;};
  // 1. Altered proving-key query vector (verifying key unchanged) -> refused before proving.
  await attempt('corrupt-query','corrupt-query',/Parameters refused: .*sha256 .* does not match the shipped manifest/);
  // 2. Truncated file -> refused. 3. Missing file -> unavailable.
  await attempt('truncated','truncate',/Parameters refused: .*truncated or substituted/);
  await attempt('missing','missing',/Parameters (refused|unavailable): .*missing from the parameter server/);
  // 4. Interrupted download -> refused, retry works below.
  await attempt('interrupted','abort-midway',/Parameters refused: .*interrupted after \d+ bytes/);
  // 5. Genuine files: authenticated, proved, published.
  await h.openDetail();await page.click('#pf-send');const pub=(await h.sendApprove({to:me,amount:'10'})).text;await h.shot('accepted-send-published');await h.back();await h.closeModal();await h.mine();assert.match(await h.balanceText(),/^98\.50? X/);
  let params=await page.evaluate(async()=>await globalThis.__pfDebug.parameters());assert.equal(params.loaded[0].source,'download');assert.equal(params.loaded[0].sha256,MANIFEST.files.normal.sha256);h.log('genuine parameters authenticated and used',{text:pub,loaded:params.loaded[0]});
  // 6. Corrupt the IndexedDB cache from the popup's origin, then lock/unlock (new worker): cache rejected, re-downloaded, send works.
  const key=`${MANIFEST.format}:${MANIFEST.ledgerDomain}:normal:${MANIFEST.files.normal.sha256}`;
  const corrupted=await page.evaluate(async key=>new Promise((res,rej)=>{const r=indexedDB.open('xmr20-holder-parameters',1);r.onsuccess=()=>{const db=r.result;const t=db.transaction('files','readwrite');const s=t.objectStore('files');const g=s.get(key);g.onsuccess=()=>{const v=g.result;if(!v)return res({found:false});const b=new Uint8Array(v);b[1234567]^=0x80;s.put(b,key);t.oncomplete=()=>{db.close();res({found:true,bytes:b.length});};};g.onerror=()=>rej(g.error);};r.onerror=()=>rej(r.error);}),key);
  assert.equal(corrupted.found,true,'cached parameter file present');h.log('cache entry corrupted deliberately (one byte)',corrupted);
  const relock=async()=>{await page.click('#lock');await page.waitForSelector('#unlock-password');await page.fill('#unlock-password',password);await page.click('#unlock');await page.waitForSelector('#asset-private-0',{timeout:300000});await h.rowsReady();};
  await relock();
  await h.openDetail();await page.click('#pf-send');await h.sendApprove({to:me,amount:'5'});await h.back();await h.closeModal();
  params=await page.evaluate(async()=>await globalThis.__pfDebug.parameters());assert.ok(params.log.some(e=>e.event==='cache-rejected'&&e.reason==='sha256'),JSON.stringify(params.log));assert.equal(params.loaded[0].source,'download');h.log('corrupted cache discarded and re-downloaded after unlock; send succeeded',{log:params.log.filter(e=>e.event!=='parameters-loaded'||true)});
  await h.shot('after-cache-corruption-recovery');
  // 7. Restart from the verified cache with the server unable to serve: works, source=cache.
  backend.faults.normal='missing';await relock();
  await h.mine();await h.openDetail();await page.click('#pf-send');await h.sendApprove({to:me,amount:'5'});await h.back();await h.closeModal();backend.faults.normal=null;
  params=await page.evaluate(async()=>await globalThis.__pfDebug.parameters());assert.equal(params.loaded[0].source,'cache');h.log('after restart the authenticated cached file was used; the parameter server was not needed',{loaded:params.loaded[0]});
  await h.mine();assert.match(await h.balanceText(),/^98\.50? X/);
  // 8. The server announces another ledger/version: the worker refuses to open; the row shows the refusal; clearing the fault recovers.
  backend.faults.parameters='foreign';await page.click('#lock');await page.waitForSelector('#unlock-password');await page.fill('#unlock-password',password);await page.click('#unlock');
  await page.waitForSelector('#pf-error-row',{timeout:300000});const rowErr=await page.textContent('#pf-error-row');assert.match(rowErr,/Served parameters\.json rejected: .*another version or ledger/);await h.shot('refused-foreign-configuration');h.log('REFUSED: parameter server configuration from another ledger/version',{error:rowErr});
  backend.faults.parameters=null;await page.click('#refresh');await page.waitForSelector('#asset-private-0',{timeout:300000});await h.rowsReady();assert.match(await h.balanceText(),/^98\.50? X/);
  const audit=await auditBackend(backend,h.secrets);assert.equal(audit.hits.length,0,JSON.stringify(audit.hits));
 }finally{
  const {external,leaks}=await h.finish(backend,{manifestSha256:MANIFEST&&(await import('node:crypto')).createHash('sha256').update(await readFile(dir+'params/test-v1/manifest.json')).digest('hex')});
  await context?.close().catch(()=>{});await backend.close();
  assert.equal(leaks.length,0,'no seed or Solana secret in any request body');assert.equal(external.filter(e=>!e.failed).length,0,'no external requests');
 }
});
