#!/usr/bin/env node
// LAUNCHER for "XMR20 Stagenet — Test funds only": opens the stagenet test extension in a DEDICATED browser profile.
//   node launch.mjs [--profile profiles/owner-stagenet] [--port 8961] [--rpc http://127.0.0.1:38091] [--build] [--headless]
// What it does, in order: (1) checks the isolated stagenet node (starts it with its own start.sh ONLY if it is not
// running and at least 20 GB are free; never touches any other process), (2) builds the extension if it is missing or
// --build is given, (3) starts the stagenet test service (issuer + indexer roles, parameter transport, faucet/credit test
// services) on 127.0.0.1:<port>, (4) launches Playwright's Chromium with a persistent profile under ./profiles and the
// extension loaded, opening the popup as a tab. Closing the browser window (or Ctrl-C) stops the test service; the node
// keeps running. Your installed extension and normal browser profiles are never touched.
import {createRequire} from 'node:module';
import {execFile,spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startStagenetBackend,DEFAULT_PORT,DEFAULT_RPC} from './backend/stagenet-service.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const ROOT=path.resolve(here,'../..');
const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};const flag=k=>a.includes('--'+k);
const rpc=opt('rpc',DEFAULT_RPC),port=Number(opt('port',DEFAULT_PORT)),profile=path.resolve(here,opt('profile','profiles/owner-stagenet'));
const ext=path.join(here,'wallet-extension/extension-stagenet-test');
const NODE=path.join(ROOT,'operations/stagenet-node-20261023');
const say=m=>console.log('[launch] '+m);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function nodeInfo(){try{const r=await fetch(rpc+'/get_info',{method:'POST',body:'{}',signal:AbortSignal.timeout(4000)});return await r.json();}catch{return null;}}
function freeGb(){return new Promise(res=>execFile('df',['-g','/'],(e,out)=>res(e?0:Number(out.trim().split('\n').pop().split(/\s+/)[3]))));}
// 1. Node
let info=await nodeInfo();
if(!info){const free=await freeGb();say(`stagenet node not answering at ${rpc}; free disk ${free} GB`);
 if(rpc!==DEFAULT_RPC)throw Error('The node at '+rpc+' is not reachable; start it yourself.');
 if(free<20)throw Error(`BLOCKED: only ${free} GB free (the node needs its 12 GB reserve plus headroom). Free disk space, then run again.`);
 if(!existsSync(NODE+'/start.sh'))throw Error('Node start script missing: '+NODE+'/start.sh');
 say('starting the isolated stagenet node with its own start.sh and disk-space watchdog (only this node is ever stopped by the watchdog)');
 spawn('sh',[NODE+'/start.sh'],{detached:true,stdio:'ignore'}).unref();if(existsSync(NODE+'/space-watch.sh'))spawn('sh',[NODE+'/space-watch.sh'],{detached:true,stdio:'ignore'}).unref();
 for(let i=0;i<60&&!info;i++){await sleep(2000);info=await nodeInfo();}
 if(!info)throw Error('The node did not answer within 2 minutes; see '+NODE+'/logs/monerod.log');}
if(info.mainnet===true||info.nettype==='mainnet')throw Error('REFUSED: the node at '+rpc+' is MAINNET. This wallet is stagenet-only.');
if(info.nettype!=='stagenet')throw Error('REFUSED: the node reports network '+info.nettype+'; stagenet required.');
say(`stagenet node ok: height ${info.height-1}${info.synchronized?'':' (still synchronizing — balances lag until it catches up)'}`);
// 2. Extension build
if(flag('build')||!existsSync(ext+'/manifest.json')){say('building the stagenet test extension…');await new Promise((res,rej)=>execFile('node',['build.mjs'],{cwd:path.join(here,'wallet-extension'),env:{...process.env,XMR20_PRIVATE_HOLDER_TEST:'stagenet'}},(e,out,err)=>e?rej(Error(err||e.message)):res(out)));}
const manifest=JSON.parse(readFileSync(ext+'/manifest.json','utf8'));say(`extension: ${manifest.name} ${manifest.version} (${ext})`);
// 3. Test service
say('starting the stagenet test service (issuer + indexer roles replay the pool from the manifest start height; this can take a minute)…');
const backend=await startStagenetBackend({rpcUrl:rpc,httpPort:port,log:m=>console.error('[service] '+m)});
const issuer=await backend.issuer();say(`test service ready at ${backend.url} · asset ${backend.asset.slice(0,16)}… · issuer ${issuer.nativeAddress?.slice(0,12)}… unlocked ${issuer.unlocked??'?'} piconero`);
// 4. Browser
mkdirSync(path.dirname(profile),{recursive:true});
const require=createRequire(path.join(ROOT,'wallet-cli/node_modules/playwright/package.json'));const {chromium}=require('playwright');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:flag('headless'),viewport:null,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--window-size=420,720']});
let sw=context.serviceWorkers()[0];if(!sw)sw=await context.waitForEvent('serviceworker',{timeout:30000});const id=new URL(sw.url()).host;
const popup=`chrome-extension://${id}/popup.html`;const page=context.pages()[0]||await context.newPage();await page.goto(popup);
say(`popup open: ${popup}`);say(`profile: ${profile}`);say('First run: "Create" makes a fresh test account (Solana key + 25-word Monero phrase; stagenet only). Open the X asset for your private token address, the faucet and the issuer test-credit buttons. Close the browser window to stop.');
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;say('stopping the test service (the node keeps running)');await backend.close().catch(()=>{});process.exit(0);};
context.on('close',stop);process.on('SIGINT',stop);process.on('SIGTERM',stop);
