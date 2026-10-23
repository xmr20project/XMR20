#!/usr/bin/env node
// STAGENET CARRIER REHEARSAL HARNESS — runnable, NOT RUN in this session (no blockchain download, no public broadcast).
// Drives the holder wallet library against a user-supplied, already-synced Monero STAGENET node with NORMAL
// validation (monerod sanity checks ON, do_not_relay honoured, real stagenet fee rate and output distribution).
// It separates TOKEN PROOF VALIDITY (local admission by the engine/indexer rules) from NATIVE ACCEPTANCE
// (daemon accepts the carrier into its pool; it mines; confirmations grow).
//
// Prerequisites the operator must provide (none are started here):
//   --rpc http://<stagenet node>:38081        a synced stagenet monerod (your own; do not point this at mainnet)
//   --params http://127.0.0.1:<port>          a parameter server serving params/stagenet-v0 (node backend/… is NOT
//                                             usable: the lab backend is fakechain-only; serve the three files statically)
//   --manifest params/stagenet-v0/manifest.json  (made by stagenet/make-stagenet-manifest.mjs; network.kind "stagenet")
//   --root <64 hex>                           a synthetic stagenet wallet root; fund its STAGENET address from the faucet
//   --issuer-credit <wire hex>                an XB3 credit for this wallet produced by a stagenet-aware issuer role
//                                             (the lab issuer/indexer still refuse non-fakechain daemons: see README-STAGENET.txt)
//   --to <penumbra1…>                         recipient (a second instance of this harness / the CLI wallet)
// Steps: sync -> report native balance/unlock -> quote carrier (real fee rate, real decoys) -> prove 1-, 2-, 3-note
// transfers -> sign -> publish with sanity checks ON -> poll pool/confirmations -> uncertain-broadcast retry (same
// blob) -> report sizes, fees, timings. Every step writes to --out (JSON) so a reviewer can see exactly what ran.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const args=process.argv.slice(2);const opt=(k,d=null)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const RPC=opt('rpc'),PARAMS=opt('params'),MANIFEST=opt('manifest',path.join(here,'../params/stagenet-v0/manifest.json')),ROOT=opt('root'),TO=opt('to'),OUT=opt('out',path.join(here,'../runs/stagenet-rehearsal.json'));
const WASM=opt('wasm',path.join(here,'../holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
const report={startedAt:new Date().toISOString(),network:'stagenet',sanityChecks:true,steps:[]};const step=(name,data)=>{report.steps.push({at:new Date().toISOString(),name,...data});console.error(name,JSON.stringify(data).slice(0,300));};
const save=()=>writeFile(OUT,JSON.stringify(report,null,1)+'\n');
if(!RPC||!PARAMS||!ROOT){console.error('usage: rehearsal.mjs --rpc URL --params URL --root HEX [--to penumbra1…] [--manifest …] [--out …]');process.exit(2);}
const manifestBytes=new Uint8Array(await readFile(MANIFEST));const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
if(manifest.network.kind!=='stagenet'){console.error('manifest is not a stagenet manifest');process.exit(2);}
const info=await fetch(RPC+'/json_rpc',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:'0',method:'get_info'})}).then(r=>r.json()).then(v=>v.result);
if(info.nettype!=='stagenet'){console.error('REFUSED: node nettype is '+info.nettype+', not stagenet');process.exit(2);}
if(info.mainnet){console.error('REFUSED: mainnet node');process.exit(2);}
step('node',{nettype:info.nettype,height:info.height,synchronized:info.synchronized,offline:info.offline,busy_syncing:info.busy_syncing});
if(!info.synchronized){console.error('REFUSED: node not synchronized; a full stagenet sync is required (not performed by this harness)');await save();process.exit(3);}
const w=await openPrivateWallet({wasm:await readFile(WASM),manifest,manifestBytes,daemonRpc:RPC,parameterServer:PARAMS,cache:memoryCache(),root:ROOT,onProgress:p=>{if(p.phase==='scan'&&p.height%5000===0)console.error('scan',p.height,'/',p.target);}});
step('wallet',{tokenAddress:w.address(),stagenetAddress:w.nativeAddress(),ledgerDomain:w.ledgerDomain});
const t0=Date.now();const s=await w.sync();step('sync',{...s,ms:Date.now()-t0});
const n=w.native();step('native',{unlocked:n.unlocked,locked:n.locked,outputs:n.outputs.length});
if(BigInt(n.unlocked)===0n){step('blocked',{reason:'no unlocked stagenet XMR: fund '+w.nativeAddress()+' from the stagenet faucet and wait 10 confirmations'});await save();process.exit(3);}
const q=await w.quoteCarrier({kind:'send'});step('quote',{fee:q.fee,weight:q.weight,feePerWeight:q.feePerWeight,ringSize:q.ringSize,rounds:q.rounds,note:'REAL stagenet fee rate and decoy distribution; still not a mainnet measurement'});
const st=w.status();step('tokens',{balances:st.balances,notes:st.notes.length});
if(!TO||!Object.keys(st.balances).length){step('blocked',{reason:'no token notes (an issuer credit on this stagenet-anchored pool is required) or no --to'});w.cancelQuote(q.quoteId);await save();process.exit(3);}
const asset=Object.keys(st.balances)[0];
for(const wanted of [1,2,3]){const notes=st.notes.filter(x=>x.asset===asset).sort((a,b)=>BigInt(a.amount)>BigInt(b.amount)?-1:1).slice(0,wanted);if(notes.length<wanted){step('skip',{inputs:wanted,reason:'not enough notes'});continue;}
 const amount=(notes.reduce((n,x)=>n+BigInt(x.amount),0n)-1n).toString();const qq=wanted===1?q:await w.quoteCarrier({kind:'send'});
 const tp=Date.now();const built=await w.prove({kind:'send',to:TO,amount,notes:notes.map(x=>x.commitment)});const provingMs=Date.now()-tp;
 const ts=Date.now();const carrier=w.signCarrier(qq.quoteId,built.wire);const signMs=Date.now()-ts;
 step('proof',{inputs:wanted,recordBytes:built.bytes,provingMs,localAdmission:w.verify(built.wire).record});
 const pub=await w.publish(carrier.blob);step('publish',{inputs:wanted,txid:carrier.txid,nativeBytes:carrier.nativeBytes,extraBytes:carrier.extraBytes,fee:carrier.fee,signMs,accepted:pub.ok,reply:pub});
 if(!pub.ok){step('native-rejected',{inputs:wanted,reason:pub.reason,note:'token proof valid locally; native transaction refused by the node (sanity checks / relay rules)'});continue;}
 // uncertain broadcast: re-send the SAME blob once (idempotent), then poll the pool.
 const again=await w.publish(carrier.blob);step('resend',{txid:carrier.txid,ok:again.ok,status:again.status});
 for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,20000));const inPool=await w.inPool(carrier.txid);await w.sync();const rec=w.status().records[built.recordId];step('poll',{txid:carrier.txid,inPool,record:rec?.status||null,confirmations:rec?.confirmations||0});if(rec?.confirmations>=10)break;}
 await w.sync();}
report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({out:OUT,steps:report.steps.length}));w.close();
