// Q1 CONTROLLED REPRODUCTION — "replay may label a mixed-time snapshot with the wrong tip hash".
// A disposable fakechain (owned by this test) sits behind a small RPC proxy. The proxy forwards everything verbatim except that
// it stages an A/B/A view of the tip: the FIRST get_block(tip) answer (A) is cached and, before it is returned, the chain is
// reorganised at the tip (pop 1 + mine 1 = B at the same height); the replay then reads branch B; the SECOND get_block(tip)
// (the final consistency check) receives the cached answer A again. This is exactly the interleaving the review derived from
// source. The UNFIXED roles binary (the reviewed candidate's, used read-only) labels branch B's state with tip hash A; the FIXED
// binary refuses the snapshot. No existing service is touched; only the fixture started here is mined on and stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {freeLoopbackPort,listenerOwnedBy} from '../backend/service.mjs';
import {service} from '../../privacy-integration-20261022/rpc.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const ROOT=path.resolve(dir,'../..');
const MONEROD=ROOT+'/operations/native-market-20261016/local-chain/bin/monerod';
const FIXED=dir+'target/release/xmr20-unshielded-lab';
const UNFIXED=path.resolve(dir,'../token-format-unshielded-20261025/target/release/xmr20-unshielded-lab');
const MINER='44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=async(port,method,params={})=>{const r=await fetch(`http://127.0.0.1:${port}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params}),signal:AbortSignal.timeout(20000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
async function fixtureDaemon(){const rpcPort=await freeLoopbackPort(),p2pPort=await freeLoopbackPort();await mkdir(dir+'runs',{recursive:true});const run=await mkdtemp(dir+'runs/replay-fixture-');await mkdir(run+'/chain');await writeFile(run+'/chain/config','');
 const child=spawn(MONEROD,['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',run+'/chain/data','--config-file',run+'/chain/config','--log-file',run+'/chain/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2'],{stdio:'ignore'});
 let exited=false;child.once('exit',()=>{exited=true;});let ok=false;for(let i=0;i<150&&!exited;i++){try{const info=await rpc(rpcPort,'get_info');if(info.nettype==='fakechain'&&info.offline===true&&info.height===1){ok=true;break;}}catch{}await sleep(200);}
 assert.ok(ok&&!exited,'fixture daemon did not start');assert.equal(await listenerOwnedBy(child.pid,rpcPort),true);
 return {rpcPort,run,async stop(){if(!exited){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);if(!exited)child.kill('SIGKILL');}await rm(run,{recursive:true,force:true});}};}
// Proxy with the A/B/A trap at `trap.height`.
async function proxy(daemonPort){const port=await freeLoopbackPort();const trap={height:null,calls:0,cachedA:null,mutated:false,log:[]};
 const server=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);const raw=Buffer.concat(parts);const body=raw;
  let q=null;if(req.url==='/json_rpc'){try{q=JSON.parse(raw.toString('utf8'));}catch{}}// binary (epee) endpoints are forwarded byte for byte
  // The scan reads the tip block THREE times: (1) the snapshot tip hash, (2) inside the replay loop, (3) the final check.
  // A/B/A = answer A to (1) and reorganise, forward (2) so the replay sees B, answer the cached A to (3).
  const isTip=req.url==='/json_rpc'&&q?.method==='get_block'&&q.params?.height===trap.height;
  if(isTip){trap.calls++;
   if(trap.calls===2){trap.log.push('tip call 2 (replay loop): forwarded, chain now shows B');}
   else if(trap.calls===1){const r=await fetch(`http://127.0.0.1:${daemonPort}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body});trap.cachedA=await r.text();
    // reorganise the tip BEFORE answering: the replay that follows sees branch B at this height
    const pop=await (await fetch(`http://127.0.0.1:${daemonPort}/pop_blocks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:1})})).json();assert.equal(pop.status,'OK');
    await rpc(daemonPort,'flush_txpool',{txids:[]});await rpc(daemonPort,'generateblocks',{wallet_address:MINER,amount_of_blocks:1});trap.mutated=true;trap.log.push('tip call 1: answered A, chain reorganised to B');
    res.writeHead(200,{'content-type':'application/json'});return res.end(trap.cachedA);}
   else{trap.log.push('tip call '+trap.calls+' (final check): answered cached A');res.writeHead(200,{'content-type':'application/json'});return res.end(trap.cachedA);}}
  const r=await fetch(`http://127.0.0.1:${daemonPort}${req.url}`,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/octet-stream'},body:req.method==='POST'?raw:undefined});
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/octet-stream'});res.end(Buffer.from(await r.arrayBuffer()));});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));return {port,trap,close:()=>new Promise(r=>server.close(r))};}
async function scanWith(bin,proxyPort,label){const idx=await service(bin,['indexer',dir+'params/test-v2','--trusted-manifest',dir+'params/test-v2/manifest.json'],{env:{XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(proxyPort)}});
 try{const r=await idx.call({op:'scan'});return {ok:true,public:r.public};}catch(e){return {ok:false,error:e.message};}finally{await idx.close().catch(()=>{});await idx.kill().catch(()=>{});}}

test('Q1: an A/B/A tip view during replay is accepted by the reviewed binary (defect) and refused by the fixed binary',{timeout:300000},async()=>{
 await access(FIXED);const haveUnfixed=await access(UNFIXED).then(()=>true,()=>false);
 const fx=await fixtureDaemon();const px=await proxy(fx.rpcPort);
 try{
  await rpc(fx.rpcPort,'generateblocks',{wallet_address:MINER,amount_of_blocks:12});const tip=(await rpc(fx.rpcPort,'get_info')).height-1;assert.equal(tip,12);
  const hashA=(await rpc(fx.rpcPort,'get_block',{height:tip})).block_header.hash;
  const evidence={tip,hashA,unfixed:null,fixed:null};
  if(haveUnfixed){px.trap.height=tip;px.trap.calls=0;px.trap.cachedA=null;
   const r=await scanWith(UNFIXED,px.port,'unfixed');console.error(JSON.stringify({unfixed:r.ok?{ok:true,tipHash:r.public.tipHash,last:r.public.canonicalBlocks.at(-1)}:{ok:false,error:r.error.slice(0,300)},calls:px.trap.calls,log:px.trap.log}));assert.equal(px.trap.calls,3,'the scan read the tip three times (snapshot, replay, final check)');
   const hashB=(await rpc(fx.rpcPort,'get_block',{height:tip})).block_header.hash;assert.notEqual(hashB,hashA,'the chain was reorganised between the two tip reads');
   assert.equal(r.ok,true,'UNFIXED: the mixed snapshot is accepted');
   const last=r.public.canonicalBlocks.at(-1);assert.equal(last.height,tip);assert.equal(r.public.tipHash,hashA,'labelled with tip A');assert.equal(last.hash,hashB,'...but replayed from branch B');
   evidence.unfixed={accepted:true,tipHash:r.public.tipHash,replayedTipHash:last.hash,mismatch:true};
   // reset the fixture tip for the next run: hashA is gone; the current tip is B — stage a fresh A/B/A with the new tip
  }
  const hashA2=(await rpc(fx.rpcPort,'get_block',{height:tip})).block_header.hash;px.trap.height=tip;px.trap.calls=0;px.trap.cachedA=null;px.trap.mutated=false;
  const r2=await scanWith(FIXED,px.port,'fixed');assert.equal(px.trap.calls,2,'the fixed binary stops after the replay (before the final check)');
  const hashB2=(await rpc(fx.rpcPort,'get_block',{height:tip})).block_header.hash;assert.notEqual(hashB2,hashA2);
  assert.equal(r2.ok,false,'FIXED: the mixed snapshot is refused');assert.match(r2.error,/replayed tip differs|Inconsistent canonical chain snapshot/);
  evidence.fixed={accepted:false,error:r2.error.slice(0,200)};
  // and a quiet chain scans fine with the fixed binary (no trap)
  px.trap.height=null;const r3=await scanWith(FIXED,px.port,'fixed-quiet');assert.equal(r3.ok,true,r3.error);assert.equal(r3.public.tipHash,r3.public.canonicalBlocks.at(-1).hash);
  evidence.fixedQuiet={accepted:true,tipHash:r3.public.tipHash};
  await writeFile(dir+'runs/replay-snapshot-evidence.json',JSON.stringify({...evidence,proxyLog:px.trap.log,unfixedBinary:haveUnfixed?UNFIXED.replace(ROOT,'<XMR20>'):null},null,1));
  console.error(JSON.stringify(evidence));
 }finally{await px.close();await fx.stop();}
});
