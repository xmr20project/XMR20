// MAINNET GATES: every component refuses mainnet unless the trusted manifest says mainnet AND the operator set the explicit flag.
// Synthetic: a tiny fake daemon that claims to be mainnet; no real node, no network, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {freeLoopbackPort} from '../backend/service.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));
const run=(cmd,args,env={})=>new Promise(res=>execFile(cmd,args,{env:{...process.env,...env}},(e,so,se)=>res({code:e?e.code:0,out:so,err:se})));
// The daemon transport probes the node with a batch request first; answer batches and unknown methods with empty results so the
// guard (get_info) is reached, and let the later genesis read fail.
async function fakeDaemon(info){const port=await freeLoopbackPort();const server=createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;let q;try{q=JSON.parse(b||'{}');}catch{q={};}
 const answer=x=>({jsonrpc:'2.0',id:x.id??0,result:x.method==='get_info'?info:{}});
 res.setHeader('content-type','application/json');res.end(JSON.stringify(Array.isArray(q)?q.map(answer):answer(q)));});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));return {port,close:()=>new Promise(r=>server.close(r))};}

test('make-manifest refuses mainnet without the acknowledgement and without a start height',async()=>{
 const tmp=await mkdtemp(dir+'runs/manifest-gate-');try{
  for(const f of ['parameters.json'])await writeFile(tmp+'/'+f,await readFile(dir+'params/test-v2/'+f));
  const {symlink}=await import('node:fs/promises');for(const f of ['spend_pk.bin','output_pk.bin'])await symlink(dir+'params/penumbra-2.1.1/'+f,tmp+'/'+f);
  let r=await run(process.execPath,[dir+'params/make-manifest.mjs',tmp,'--network-kind','mainnet','--start-height','10']);assert.notEqual(r.code,0);assert.match(r.err,/mainnet-acknowledged/);
  r=await run(process.execPath,[dir+'params/make-manifest.mjs',tmp,'--network-kind','mainnet','--mainnet-acknowledged','EXPERIMENTAL-PILOT']);assert.notEqual(r.code,0);assert.match(r.err,/start-height/);
  r=await run(process.execPath,[dir+'params/make-manifest.mjs',tmp,'--network-kind','mainnet','--mainnet-acknowledged','EXPERIMENTAL-PILOT','--start-height','10','--out',tmp+'/m.json']);assert.equal(r.code,0,r.err);
  const m=JSON.parse(await readFile(tmp+'/m.json','utf8'));assert.equal(m.network.kind,'mainnet');assert.match(m.label,/MAINNET PILOT — EXPERIMENTAL/);assert.match(m.warning,/No independent security review/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
test('the roles binary refuses a mainnet daemon without XMR20_MAINNET_PILOT, and a mainnet manifest against a fakechain daemon',{timeout:120000},async()=>{
 const params=dir+'params/mainnet-v1';const manifest=params+'/manifest.json';
 try{await readFile(manifest);}catch{console.error('params/mainnet-v1 not generated (tools/mainnet-setup.mjs); skipping');return;}
 const mainnet=await fakeDaemon({nettype:'mainnet',mainnet:true,synchronized:true,height:3800000});const fake=await fakeDaemon({nettype:'fakechain',offline:true,incoming_connections_count:0,outgoing_connections_count:0,height:1});
 try{const bin=dir+'target/release/xmr20-unshielded-lab';
  const start=(port,env)=>new Promise(res=>{const c=spawn(bin,['indexer',params,'--trusted-manifest',manifest],{env:{...process.env,XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(port),...env}});let err='';c.stderr.on('data',d=>{err+=d;});c.stdout.on('data',()=>{});c.on('exit',code=>res({code,err}));setTimeout(()=>c.kill(),20000);});
  const noFlag=await start(mainnet.port,{});assert.notEqual(noFlag.code,0);assert.match(noFlag.err,/Mainnet daemon refused|XMR20_MAINNET_PILOT/);
  const wrongChain=await start(fake.port,{XMR20_MAINNET_PILOT:'I-UNDERSTAND'});assert.notEqual(wrongChain.code,0);assert.match(wrongChain.err,/Mainnet pilot|synchronized mainnet daemon|nettype/);
  // with the flag and a mainnet daemon the guard passes; the next step (genesis read) fails on the fake daemon, which proves the gate opened
  const flagged=await start(mainnet.port,{XMR20_MAINNET_PILOT:'I-UNDERSTAND'});assert.notEqual(flagged.code,0);assert.doesNotMatch(flagged.err,/Mainnet daemon refused/);
 }finally{await mainnet.close();await fake.close();}
});
test('the bridge service refuses network=mainnet without XMR20_BRIDGE_MAINNET and with test services or a non-RPC custody',async()=>{
 const {startBridgeService}=await import('../../bridge-service-unshielded-20261026/bridge/bridge-service.mjs');
 delete process.env.XMR20_BRIDGE_MAINNET;
 const base={network:'mainnet',daemonRpc:'http://127.0.0.1:1',indexerUrl:'http://127.0.0.1:1',rolesBin:'x',paramsDir:'x',trustedManifest:dir+'params/mainnet-v1/manifest.json',journalDir:'x',assets:[],custody:{kind:'rpc',network:'mainnet-beta'}};
 await assert.rejects(startBridgeService(base),/XMR20_BRIDGE_MAINNET/);
 process.env.XMR20_BRIDGE_MAINNET='I-UNDERSTAND';
 try{await assert.rejects(startBridgeService({...base,custody:{kind:'litesvm'}}),/RPC custody on mainnet-beta/);
  await assert.rejects(startBridgeService({...base,testServices:true}),/test services on mainnet/);}
 finally{delete process.env.XMR20_BRIDGE_MAINNET;}
});
