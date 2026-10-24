// REAL BROWSER FLOW, holder-controlled keys: loads the isolated private-holder
// test extension in a disposable Chromium profile (Playwright 1.56.1 from
// wallet-cli/node_modules) and drives the actual popup against the synthetic
// backend. Two synthetic wallets are imported in the extension; token keys,
// scanning, proofs and spend authorization run in the extension's holder
// worker (vendor/holder.wasm). Screenshots and a network/console audit land in
// evidence/. Test-service steps are labelled ("TEST SERVICE"). The recovery
// phrases are never screenshotted: the import form is captured before the
// phrase is typed and the "save your keys" screen is skipped.
//
// Exports the shared harness for the recovery and interruption tests.
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {startBackend} from './backend/service.mjs';
const require=createRequire(''+(process.env.XMR20_PLAYWRIGHT_DIR||'../../node_modules')+'/playwright/package.json');
const {chromium}=require('playwright');
export const dir=fileURLToPath(new URL('./',import.meta.url)),ext=dir+'wallet-extension/extension-private-holder-test';
export const PROVE_TIMEOUT=900000;
export const stagenetExt=dir+'wallet-extension/extension-stagenet-test';
export function harness(name,{extensionDir=ext,backendUrl='http://127.0.0.1:8940/',rpcUrl='http://127.0.0.1:30041/'}={}){
 const steps=[],shots=[],requests=[],consoleLines=[],secrets=[];let page=null,evidence=null;
 const h={steps,shots,requests,consoleLines,secrets,get page(){return page;},set page(p){page=p;h.wire(p);},get evidence(){return evidence;}};
 h.log=(step,detail={})=>{steps.push({at:new Date().toISOString(),step,...detail});};
 h.shot=async(label)=>{const file=`${evidence}/${String(shots.length+1).padStart(2,'0')}-${label}.png`;await page.screenshot({path:file,fullPage:!(await page.$('dialog[open]'))});shots.push(file);};
 h.wire=p=>{p.on('request',r=>{const post=r.postData();requests.push({url:r.url(),method:r.method(),post:post?post.length:0});if(post)for(const s of secrets)if(post.includes(s))requests.push({LEAK:true,url:r.url()});});p.on('console',m=>consoleLines.push(m.text().slice(0,300)));p.on('requestfailed',r=>requests.push({failed:r.url(),error:r.failure()?.errorText}));};
 h.settle=async()=>page.waitForFunction(()=>![...document.querySelectorAll('#modal button,#modal input')].some(b=>b.disabled&&!b.dataset.keep),null,{timeout:PROVE_TIMEOUT});
 h.progress=async(re,timeout=PROVE_TIMEOUT)=>{await page.waitForFunction(([src])=>new RegExp(src).test(document.querySelector('#progress')?.textContent||''),[re.source],{timeout});const t=await page.textContent('#progress');await h.settle();return t;};
 h.errorText=async(re,timeout=120000)=>{await page.waitForFunction(([src])=>new RegExp(src).test(document.querySelector('#error')?.textContent||''),[re.source],{timeout});const t=await page.textContent('#error');await h.settle();return t;};
 // Fails fast with the popup's own error text when the private holder cannot open (instead of waiting for the timeout).
 h.rowsReady=async()=>{await page.waitForFunction(()=>(!document.querySelector('#pf-loading')&&document.querySelector('#asset-private-0'))||document.querySelector('#pf-error-row'),null,{timeout:300000});const err=await page.$('#pf-error-row');if(err)throw Error('popup: '+(await err.textContent()));};
 h.importAccount=async({name,seed,solSecret,password,first})=>{
  if(first)await page.click('#start-import');else{await page.click('#accounts');await page.click('#add-import');}
  await page.fill('#name',name);await page.fill('#height','0');if(first){await page.fill('#password',password);await page.fill('#password-confirm',password);}
  await h.shot('import-form-'+name);// captured BEFORE any recovery material is typed
  await page.fill('#sol-secret',solSecret);await page.fill('#xmr-seed',seed);await page.click('#continue');
  await page.waitForFunction(()=>document.querySelector('#backed-up')||!document.querySelector('dialog[open]'),null,{timeout:120000});if(await page.$('#backed-up')){await page.check('#backed-up');await page.click('#finish');}
  await page.waitForFunction(()=>!document.querySelector('dialog[open]'),null,{timeout:60000});await h.rowsReady();h.log('account imported; holder keys derived in the extension and registered by public token address',{name});};
 h.switchAccount=async(index)=>{await page.click('#accounts');await page.locator('[data-account]').nth(index).click();await page.waitForTimeout(200);await h.rowsReady();};
 h.openDetail=async()=>{await page.click('#asset-private-0');await page.waitForSelector('#pf-send');};
 h.back=async()=>{if(await page.$('#pf-back'))await page.click('#pf-back');};
 // The close button is ignored while an operation's trailing refresh still holds the busy guard: keep trying until the dialog is gone.
 h.closeModal=async()=>{await h.settle();for(let i=0;i<120;i++){if(!(await page.$('dialog[open]')))return;await page.click('#close').catch(()=>{});await page.waitForTimeout(500);}throw Error('Modal did not close');};
 h.mine=async()=>{await h.openDetail();await page.click('#pf-mine');await h.progress(/Test chain at block/);await h.closeModal();h.log('TEST SERVICE: mined confirmation blocks');};
 // TEST SERVICE: mine a coinbase reward to the current account's Monero address (carrier-fee funding); it matures after 60 blocks.
 h.fund=async()=>{await h.openDetail();await page.click('#pf-fund');const t=await h.progress(/Mined 1 coinbase output/);await h.closeModal();h.log('TEST SERVICE: mined test XMR to this account for carrier fees',{text:t});return t;};
 // Wait for a text in #progress or the fee review WITHOUT settling (the Send button stays disabled while the holder is asked to approve the fee).
 h.waitText=async(sel,re,timeout=PROVE_TIMEOUT)=>{await page.waitForFunction(([s,src])=>new RegExp(src).test(document.querySelector(s)?.textContent||''),[sel,re.source],{timeout});return page.textContent(sel);};
 // Holder-funded send through the popup: Send -> fee review (exact XMR fee shown BEFORE proving) -> Approve -> proved -> carrier signed -> published.
 h.sendApprove=async({to,amount,re=/Published/,approve=true,shotLabel=null})=>{await page.fill('#pf-to',to);await page.fill('#pf-amount',amount);await page.click('#pf-send-go');const fee=await h.waitText('#pf-fee',/Carrier fee: .* XMR/);if(shotLabel)await h.shot(shotLabel);h.log('fee review shown before proving',{fee:fee.slice(0,200)});
  if(!approve){await page.click('#pf-cancel');const err=await h.errorText(/Cancelled before proving/);return {fee,cancelled:true,error:err};}
  await page.click('#pf-approve');const t=await h.progress(re);return {fee,text:t};};
 h.nativeLine=async()=>{await h.openDetail();const t=await page.textContent('#pf-native');await h.closeModal();return t;};
 h.uiRefresh=async()=>{await page.click('#refresh');await page.waitForTimeout(300);await h.rowsReady();};
 h.balanceText=async()=>page.textContent('#asset-private-0 .asset-amount strong');
 h.tokenAddress=async()=>{await h.openDetail();const t=await page.textContent('.monero-token-detail .address');await h.closeModal();return t.trim();};
 h.newWallet=async(label)=>{const k=await page.evaluate(()=>new Promise((res,rej)=>{const w=new Worker('vendor/keys.worker.js');w.onmessage=({data})=>{w.terminate();data.error?rej(Error(data.error)):res(data.result);};w.postMessage({id:'seed',action:'create'});}));const sol=Keypair.generate();const w={name:label,seed:k.seed,xmr:k.address,sol:sol.publicKey.toBase58(),solSecret:bs58.encode(sol.secretKey)};secrets.push(k.seed,bs58.encode(sol.secretKey));return w;};
 h.launch=async(profileLabel,fixedDir=null)=>{const profile=fixedDir||await mkdtemp(dir+'runs/profile-'+profileLabel+'-');if(fixedDir)await mkdir(fixedDir,{recursive:true});const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:380,height:600},args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`]});let sw=context.serviceWorkers()[0];if(!sw)sw=await context.waitForEvent('serviceworker',{timeout:30000});const id=new URL(sw.url()).host;h.log('extension loaded',{id,profile:profileLabel});return {context,id,profile};};
 h.start=async()=>{evidence=dir+'evidence/'+name+'-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);await mkdir(evidence,{recursive:true});};
 h.finish=async(backend,extra={})=>{const external=requests.filter(r=>r.url&&!r.url.startsWith('chrome-extension://')&&!r.url.startsWith(backendUrl)&&!r.url.startsWith(rpcUrl));const leaks=requests.filter(r=>r.LEAK);
  await writeFile(evidence+'/steps.json',JSON.stringify(steps,null,1));await writeFile(evidence+'/network-audit.json',JSON.stringify({totalRequests:requests.length,backendRequests:requests.filter(r=>r.url?.startsWith(backendUrl)).length,daemonRequests:requests.filter(r=>r.url?.startsWith(rpcUrl)).length,externalRequests:external,secretLeaks:leaks,consoleSample:consoleLines.slice(0,80),screenshots:shots,backendRun:backend?.run,...extra},null,1));
  return {external,leaks};};
 return h;
}
// Key images and carrier blobs are the holder's own data: they must never reach the test backend (they do reach the daemon inside the published transaction, as for any Monero wallet).
export async function keyImagesOf(page){const st=await page.evaluate(async()=>await globalThis.__pfDebug.state());const kis=(st?.holder?.native?.outputs||[]).map(o=>o.keyImage);const carriers=Object.values(st?.journal?.pending||{}).concat(st?.journal?.history||[]).map(p=>p.carrier?.keyImage).filter(Boolean);return [...new Set(kis.concat(carriers))];}
export async function auditBackend(backend,secrets){// the backend's audit log and run folder must contain none of the test secrets
 const {readdir,readFile}=await import('node:fs/promises');const files=[];const walk=async d=>{for(const e of await readdir(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory()){if(e.name==='data')continue;await walk(p);}else if(/\.(json|log|vault)$/.test(e.name))files.push(p);}};await walk(backend.run);
 const hits=[];for(const f of files){const t=await readFile(f,'latin1');for(const s of secrets)if(t.includes(s))hits.push({file:f,secretIndex:secrets.indexOf(s)});}return {filesChecked:files.length,hits};}

