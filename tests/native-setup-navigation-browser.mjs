import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..'),ops=join(root,'operations/codex-saved-setup-20261021'),candidate=process.env.XMR20_NAVIGATION_PACKAGE||join(ops,'extension-candidate');
const out=process.env.XMR20_NAVIGATION_OUTDIR||join(ops,'navigation');
const {chromium}=createRequire(join(root,'wallet-cli/package.json'))('playwright');
const temp=await mkdtemp(join(tmpdir(),'xmr20-public-navigation-'));let browser,server;
try{
 await mkdir(out,{recursive:true});
 await build({entryPoints:[join(import.meta.dirname,'native-setup-navigation.fixture.js')],outfile:join(temp,'fixture.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',inject:[join(root,'wallet-extension/src/polyfill.js')],logLevel:'silent'});
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disposable setup navigation</title><link rel="stylesheet" href="/style.css"><body><dialog></dialog><script type="module" src="/fixture.js"></script></body></html>');return;}
  const files={'/fixture.js':join(temp,'fixture.js'),'/style.css':join(candidate,'style.css'),'/market-entry.css':join(candidate,'market-entry.css')};
  if(!files[path])return res.writeHead(404).end();res.setHeader('content-type',path.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(files[path]));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:'/Users/mark/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',headless:true,args:['--disable-background-networking']});
 const checks=[];
 for(const mode of ['convert','redeem'])for(const size of [{width:360,height:600},{width:390,height:480}]){
  const page=await browser.newPage({viewport:size}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin+'/?mode='+mode);await page.waitForFunction(()=>fixture.ready);
  if(mode==='redeem')await page.getByRole('alert').filter({hasText:'M00'}).waitFor();
  const shortcut=page.getByRole('button',{name:'Finish Monero setup',exact:true});assert.equal(await shortcut.count(),1);assert.equal(await shortcut.isEnabled(),true);
  const box=await shortcut.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=size.height);assert.equal(box.height,48);
  await page.screenshot({path:join(out,mode+'-'+size.width+'-'+size.height+'.png')});
  await page.evaluate(()=>fixture.calls=[]);await shortcut.click();await page.waitForFunction(()=>fixture.ready);
  await page.getByRole('heading',{name:'Finish Monero setup',exact:true}).waitFor();assert.equal(await page.locator('select').count(),0);
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>['balance','sync','quote','SIGN'].includes(c))),false);
  const resume=page.getByRole('button',{name:'7.53M EXTREMIST · Resume'});await resume.waitFor();
  await page.screenshot({path:join(out,'saved-'+mode+'-'+size.width+'-'+size.height+'.png')});
  await resume.click();await page.getByRole('button',{name:'Publish',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>['balance','sync','quote','SIGN'].includes(c))),false);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('dialog').length),1);assert.equal(browser.contexts().length,1);assert.deepEqual(errors,[]);
  checks.push({mode,...size,savedEntry:true,samePopup:true,noNewSignature:true,exactRecovery:true});await page.close();
 }
 // A confirmed, allocated setup is finished: no shortcut, and the saved entry is not offered for resume.
 for(const mode of ['convert-finished','redeem-finished'])for(const size of [{width:390,height:480}]){
  const page=await browser.newPage({viewport:size}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin+'/?mode='+mode);await page.waitForFunction(()=>fixture.ready);
  if(mode==='redeem-finished')await page.getByRole('alert').filter({hasText:'M00'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Finish Monero setup',exact:true}).count(),0,'finished setup must not offer the shortcut');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(c=>['setup-status','setup-mark'].includes(c))),['setup-status','setup-mark']);
  if(mode==='convert-finished'){
   const done=page.getByRole('button',{name:'7.53M EXTREMIST · Complete'});await page.locator('.native-send-recovery summary').click();await done.waitFor();
   assert.equal(await done.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'7.53M EXTREMIST · Resume'}).count(),0);
  }
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>['sync','SIGN','publish'].includes(c))),false);
  await page.screenshot({path:join(out,mode+'-'+size.width+'-'+size.height+'.png')});
  assert.deepEqual(errors,[]);checks.push({mode,...size,shortcutHidden:true,noNewSignature:true});await page.close();
 }
 // The orange swap button switches direction inside the same popup; no "From" menu remains.
 {
  const page=await browser.newPage({viewport:{width:390,height:600}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin+'/?mode=convert-finished&receipts=ok');await page.waitForFunction(()=>fixture.ready);
  await page.getByRole('heading',{name:'Bridge to Monero',exact:true}).waitFor();assert.equal(await page.locator('select').count(),0);
  assert.equal(await page.getByRole('button',{name:'Previously bridged tokens'}).count(),0,'no earlier balance, no link');
  // Tokens | SOL <-> XMR tabs replace the visual title; the heading remains for assistive technology.
  assert.equal(await page.getByRole('tab',{name:'Tokens'}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'SOL ↔ XMR'}).click();assert.equal(await page.evaluate(()=>fixture.calls.includes('coins')),true);
  await page.screenshot({path:join(out,'swap-convert-390-600.png')});
  await page.getByRole('button',{name:'Reverse bridge direction'}).click();await page.waitForFunction(()=>fixture.ready);
  // Bridge to Solana draws its panels before syncing; the switch stays usable even when that sync fails.
  await page.getByRole('heading',{name:'Bridge to Solana',exact:true}).waitFor();await page.locator('.bridge-token-panels').waitFor();
  // Each direction opens a fresh shadow root; let its stylesheet apply before capturing.
  await page.waitForFunction(()=>{const host=document.querySelector('dialog div');const panel=host?.shadowRoot?.querySelector('.bridge-token-panel');return panel&&getComputedStyle(panel).backgroundColor==='rgb(32, 32, 32)';});
  await page.screenshot({path:join(out,'swap-redeem-390-600.png')});
  await page.getByRole('button',{name:'Reverse bridge direction'}).click();await page.waitForFunction(()=>fixture.ready);
  await page.getByRole('heading',{name:'Bridge to Monero',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>['SIGN','publish'].includes(c))),false);assert.equal(await page.evaluate(()=>document.querySelectorAll('dialog').length),1);
  await page.goto(origin+'/?mode=redeem-finished&legacy=1');await page.waitForFunction(()=>fixture.ready);
  await page.getByRole('button',{name:'Previously bridged tokens'}).click();assert.equal(await page.evaluate(()=>fixture.calls.includes('legacy')),true);
  assert.deepEqual(errors,[]);checks.push({swap:true,noFromMenu:true,legacyLinkOnlyWhenOffered:true});await page.close();
 }
 await writeFile(join(out,'report.json'),JSON.stringify({passed:true,checks,publicFixture:true,ownerDataAccess:false,mainnetTransactions:0},null,2)+'\n');console.log(JSON.stringify({passed:true,scenarios:checks.length}));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
