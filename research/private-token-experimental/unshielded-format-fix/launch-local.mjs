#!/usr/bin/env node
// LAUNCHER for the "XMR20 Wallet — Unshielded format test" extension on the OFFLINE TEST CHAIN (synthetic balances, no real funds).
//   node launch-local.mjs [--profile profiles/owner-local] [--build] [--headless]
// In order: (1) builds the test extension if it is missing or --build is given, (2) starts the test backend (offline fakechain
// monerod, roles binary, LiteSVM custody, parameter transport) on 127.0.0.1:8940 / daemon 127.0.0.1:30041 — the ports compiled into
// the extension, (3) launches Playwright's Chromium with a persistent profile under ./profiles and the extension loaded, opening the
// popup as a tab. Closing the browser window (or Ctrl-C) stops the backend and the fakechain. Your installed extension and normal
// browser profiles are never touched. Everything persists only under ./profiles and ./runs.
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startBackend} from './backend/service.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const ROOT=path.resolve(here,'../..');
const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};const flag=k=>a.includes('--'+k);
const profile=path.resolve(here,opt('profile','profiles/owner-local'));const ext=path.join(here,'wallet-extension/extension-private-holder-test');
const say=m=>console.log('[launch] '+m);
if(flag('build')||!existsSync(ext+'/manifest.json')){say('building the test extension…');await new Promise((res,rej)=>execFile('node',['build.mjs'],{cwd:path.join(here,'wallet-extension'),env:{...process.env,XMR20_PRIVATE_HOLDER_TEST:'local'}},(e,so,se)=>e?rej(Error(se||e.message)):res(so)));}
const manifest=JSON.parse(readFileSync(ext+'/manifest.json','utf8'));say(`extension: ${manifest.name} ${manifest.version}`);
say('starting the offline test backend (fakechain daemon, roles, custody simulator)… about 20 seconds');
const backend=await startBackend({log:m=>console.error('[backend] '+String(m).slice(0,200))});
say(`backend ready at ${backend.url} · daemon ${backend.rpcUrl} · run folder ${backend.run}`);
mkdirSync(path.dirname(profile),{recursive:true});
const require=createRequire(path.join(ROOT,'wallet-cli/node_modules/playwright/package.json'));const {chromium}=require('playwright');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:flag('headless'),viewport:null,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--window-size=440,760']});
let sw=context.serviceWorkers()[0];if(!sw)sw=await context.waitForEvent('serviceworker',{timeout:30000});const id=new URL(sw.url()).host;
const popup=`chrome-extension://${id}/popup.html`;const page=context.pages()[0]||await context.newPage();await page.goto(popup);
writeFileSync(path.join(here,'runs/launch-local.json'),JSON.stringify({pid:process.pid,popup,profile,backend:backend.url,daemon:backend.rpcUrl,run:backend.run,at:new Date().toISOString()},null,1));
say(`popup open: ${popup}`);say(`profile: ${profile}`);
say('First run: "Create" makes a fresh TEST account (Solana key + 25-word Monero phrase; offline chain only, worthless). Then open the X asset: "Mine test XMR" (3x), "Advance test chain", Bridge → deposit 100, then Send (Public / Private), Shield, Unshield.');
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;say('stopping the test backend and the fakechain');await backend.close().catch(()=>{});process.exit(0);};
context.on('close',stop);process.on('SIGINT',stop);process.on('SIGTERM',stop);
