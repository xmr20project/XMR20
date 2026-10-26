// M5 REGRESSION — test isolation of the offline backend. Uses a DISPOSABLE fixture daemon owned by this test (never an existing
// service): the backend must refuse to start when its RPC port is already held by another fakechain, must not mine, publish or
// roll back against it, must leave it running, and must leave no child of its own behind. An occupied HTTP port must fail before
// any process starts. ports:'exclusive' must yield a working backend on fresh loopback ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startBackend,freeLoopbackPort,listenerOwnedBy} from '../backend/service.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const ROOT=path.resolve(dir,'../..');
const MONEROD=ROOT+'/operations/native-market-20261016/local-chain/bin/monerod';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=async(port,method,params={})=>{const r=await fetch(`http://127.0.0.1:${port}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params}),signal:AbortSignal.timeout(10000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
// Disposable fixture: a fakechain daemon this test starts, mines 3 blocks on and later stops. Tracks its pid only.
async function fixtureDaemon(){const rpcPort=await freeLoopbackPort(),p2pPort=await freeLoopbackPort();await mkdir(dir+'runs',{recursive:true});const run=await mkdtemp(dir+'runs/isolation-fixture-');await mkdir(run+'/chain');await writeFile(run+'/chain/config','');
 const child=spawn(MONEROD,['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',run+'/chain/data','--config-file',run+'/chain/config','--log-file',run+'/chain/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2'],{stdio:'ignore'});
 let exited=false;child.once('exit',()=>{exited=true;});let ok=false;for(let i=0;i<150&&!exited;i++){try{const info=await rpc(rpcPort,'get_info');if(info.nettype==='fakechain'&&info.offline===true){ok=true;break;}}catch{}await sleep(200);}
 assert.ok(ok&&!exited,'fixture daemon did not start');
 // give the fixture a distinguishable chain (height 4 after 3 mined blocks) so a foreign chain is never "fresh"
 await rpc(rpcPort,'generateblocks',{wallet_address:'44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A',amount_of_blocks:3});
 const height=async()=>(await rpc(rpcPort,'get_info')).height;
 return {rpcPort,p2pPort,pid:child.pid,run,height,alive:()=>!exited,async stop(){if(!exited){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);if(!exited)child.kill('SIGKILL');}await rm(run,{recursive:true,force:true});}};}

test('occupied RPC port: refused before any mutation; fixture untouched and still running; no orphan of ours',{timeout:120000},async()=>{
 const fx=await fixtureDaemon();
 try{
  const before=await fx.height();assert.equal(before,4);
  assert.equal(await listenerOwnedBy(fx.pid,fx.rpcPort),true,'ownership helper recognises the fixture as owner');
  assert.equal(await listenerOwnedBy(process.pid,fx.rpcPort),false,'ownership helper rejects a non-owner pid');
  const runsBefore=new Set(await readdir(dir+'runs'));
  await assert.rejects(startBackend({rpcPort:fx.rpcPort,p2pPort:await freeLoopbackPort(),httpPort:await freeLoopbackPort(),log:()=>{}}),/REFUSED/);
  assert.equal(await fx.height(),before,'the fixture chain was not advanced (no startup mining against a foreign daemon)');
  assert.equal(fx.alive(),true,'the fixture daemon is still running');
  // the refused backend's run folder exists but its daemon is gone: nothing of ours listens on the fixture port and no stray monerod uses its data dir
  const runsAfter=(await readdir(dir+'runs')).filter(x=>!runsBefore.has(x)&&x.startsWith('backend-'));assert.equal(runsAfter.length,1);
  const stray=await new Promise(r=>{const {execFile}=require_('node:child_process');execFile('pgrep',['-f',dir+'runs/'+runsAfter[0]+'/chain/data'],(e,out)=>r(String(out||'').trim()));});
  assert.equal(stray,'','no daemon of the refused backend survives');
  await rm(dir+'runs/'+runsAfter[0],{recursive:true,force:true});
 }finally{await fx.stop();}
});
test('occupied HTTP port: fails before any process starts',{timeout:60000},async()=>{
 const blocker=net.createServer();const httpPort=await freeLoopbackPort();await new Promise(r=>blocker.listen(httpPort,'127.0.0.1',r));
 try{const runsBefore=new Set(await readdir(dir+'runs'));
  await assert.rejects(startBackend({rpcPort:await freeLoopbackPort(),p2pPort:await freeLoopbackPort(),httpPort,log:()=>{}}),/HTTP port .* unavailable .*nothing was started/);
  const runsAfter=(await readdir(dir+'runs')).filter(x=>!runsBefore.has(x)&&x.startsWith('backend-'));assert.equal(runsAfter.length,0,'no run folder, no daemon');
 }finally{await new Promise(r=>blocker.close(r));}
});
test('exclusive ports: a backend starts on fresh loopback ports, owns its daemon, and stops cleanly',{timeout:300000},async()=>{
 const b=await startBackend({ports:'exclusive',log:()=>{}});
 try{assert.ok(b.ports.rpcPort>1024&&b.ports.httpPort>1024&&b.ports.rpcPort!==b.ports.httpPort);assert.equal(await listenerOwnedBy(b.daemonPid,b.ports.rpcPort),true);
  const info=await rpc(b.ports.rpcPort,'get_info');assert.ok(info.height>=250,'startup mining happened on OUR daemon only');
  const h=await fetch(b.url+'params');assert.equal(h.status,200);}
 finally{await b.close();}
 await sleep(500);assert.equal(await listenerOwnedBy(b.daemonPid,b.ports.rpcPort),false,'daemon stopped');
 await rm(b.run,{recursive:true,force:true});
});
function require_(m){return globalThis.process.getBuiltinModule(m);}
