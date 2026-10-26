// TEST LAB for the bridge service: offline fakechain monerod + persistent indexer service + bridge service (LiteSVM custody),
// all as separate processes on unused loopback ports, exactly as the production layout (indexer and bridge are separate
// services talking over HTTP). SIMULATED: synthetic keys and balances, fixed test-v2 parameter set. Every process started here
// is tracked and stopped by stop(); nothing else is touched. Run folders live under runs/ and are deleted by the test.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startIndexerService,createIndexerClient} from '../bridge/indexer-service.mjs';
import {startBridgeService} from '../bridge/bridge-service.mjs';
import {freeLoopbackPort,listenerOwnedBy} from '../../token-format-unshielded-fix-20261026/backend/service.mjs';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const ROOT=path.resolve(here,'../../..');
export const FMT=path.resolve(here,'../../token-format-unshielded-fix-20261026');
export const BINS={monerod:ROOT+'/operations/native-market-20261016/local-chain/bin/monerod',indexer:FMT+'/target/release/xmr20-indexer',roles:FMT+'/target/release/xmr20-unshielded-lab',wasm:FMT+'/holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// M5 (review): exclusive per-run loopback ports by default; the fakechain daemon must be OUR child (lsof-verified) and fresh (height 1)
// before anything is mined; an occupied port fails the lab without touching whatever listens there.
export async function startLab({rpcPort=null,p2pPort=null,indexerPort=null,bridgePort=null,confirmations=10,exposure,assets,registrySnapshot=null,observers=[],requireObservers=false,log=()=>{},name='lab'}={}){
 rpcPort??=await freeLoopbackPort();p2pPort??=await freeLoopbackPort();indexerPort??=await freeLoopbackPort();bridgePort??=await freeLoopbackPort();
 const run=path.join(here,'../runs',name+'-'+Date.now());await mkdir(run+'/chain',{recursive:true});await writeFile(run+'/chain/config','');
 const daemonRpc=`http://127.0.0.1:${rpcPort}`;
 const rpc=async(method,params={})=>{const r=await fetch(daemonRpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params}),signal:AbortSignal.timeout(20000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 const daemon=spawn(BINS.monerod,['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',run+'/chain/data','--config-file',run+'/chain/config','--log-file',run+'/chain/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2'],{stdio:'ignore'});
 const started=[{name:'monerod',pid:daemon.pid}];
 let exited=false;daemon.once('exit',()=>{exited=true;});let ok=false;for(let i=0;i<150&&!exited;i++){try{const info=await rpc('get_info');assert.equal(info.nettype,'fakechain');assert.equal(info.offline,true);assert.equal(info.height,1,'listener already has a chain: not our fresh daemon');ok=true;break;}catch{await sleep(200);}}
 if(exited||!ok){if(!exited)daemon.kill('SIGKILL');throw Error('REFUSED: fakechain daemon did not start or the RPC port is held by another service');}
 if(!(await listenerOwnedBy(daemon.pid,rpcPort))){daemon.kill('SIGKILL');throw Error('REFUSED: the RPC listener is not owned by our daemon; nothing was mined');}
 const stopAll=[];const custodyInstances={};/* the in-process VM survives bridge restarts, as a real custody chain would */const stop=async()=>{for(const f of stopAll.reverse())await f().catch(()=>{});daemon.kill();await new Promise(r=>daemon.once('exit',r));};
 try{
  // Fixed parameter set, as the production layout: the roles load from a parameter directory and trust a manifest kept elsewhere.
  const src=FMT+'/params/test-v2';await mkdir(run+'/parameters');await mkdir(run+'/trusted');
  for(const f of ['parameters.json','issuer.secret.json','manifest.json'])await copyFile(src+'/'+f,run+'/parameters/'+f);
  for(const f of ['spend_pk.bin','output_pk.bin'])await symlink(src+'/'+f,run+'/parameters/'+f);
  await copyFile(src+'/manifest.json',run+'/trusted/manifest.json');
  const indexer=await startIndexerService({bin:BINS.indexer,paramsDir:run+'/parameters',trustedManifest:run+'/trusted/manifest.json',rpcUrl:daemonRpc,stateDir:run+'/indexer',httpPort:indexerPort,pollMs:1500,maxBlocks:500,log});
  stopAll.push(()=>indexer.close());
  const bridge=await startBridgeService({network:'offline-fakechain',daemonRpc,indexerUrl:indexer.url,httpPort:bridgePort,rolesBin:BINS.roles,paramsDir:run+'/parameters',trustedManifest:run+'/trusted/manifest.json',journalDir:run+'/bridge',confirmations,exposure,observers,requireObservers,assets,custody:{kind:'litesvm',instances:custodyInstances},registrySnapshot,testServices:true,pollMs:1500,origins:[],log});
  stopAll.push(()=>bridge.close());
  // issuer funding: 250 blocks (60 to mature) so credits have spendable XMR
  for(let left=250;left>0;left-=50)await rpc('generateblocks',{wallet_address:bridge.issuerNative,amount_of_blocks:Math.min(50,left)});
  await indexer.sync();
  const BASE=bridge.url.replace(/\/$/,'');
  const post=async(action,body,admin=false)=>{const r=await fetch(`${BASE}/${admin?'admin':'action'}/${action}`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
  // Restart only the bridge service (operator restart): the chain and the indexer keep running.
  const restartBridge=async(over={})=>{const i=stopAll.findIndex(f=>f===stopAll.at(-1));await stopAll.pop()();const b=await startBridgeService({network:'offline-fakechain',daemonRpc,indexerUrl:indexer.url,httpPort:bridgePort,rolesBin:BINS.roles,paramsDir:run+'/parameters',trustedManifest:run+'/trusted/manifest.json',journalDir:run+'/bridge',confirmations,exposure,observers,requireObservers,assets,custody:{kind:'litesvm',instances:custodyInstances},registrySnapshot,testServices:true,pollMs:1500,origins:[],log,...over});stopAll.push(()=>b.close());lab.bridge=b;return b;};
  const lab={run,ports:{rpcPort,p2pPort,indexerPort,bridgePort},daemonRpc,rpc,indexer,indexerClient:createIndexerClient(indexer.url),bridge,BASE,post,restartBridge,started,stop,async cleanup(){await stop();await rm(run,{recursive:true,force:true});}};
  return lab;
 }catch(e){console.error('LAB START FAILURE: '+(e.stack||e.message));await stop();throw e;}
}
// A fake "independent observer" daemon: answers get_transactions with an unknown tx (disagreement) or proxies to the real node.
export async function fakeObserver({port=8993,mode='unknown',proxy=null}={}){
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;
  if(mode==='proxy'){const r=await fetch(proxy+req.url,{method:req.method,headers:{'content-type':'application/json'},body:body||undefined});res.writeHead(r.status,{'content-type':'application/json'});return res.end(await r.text());}
  if(req.url==='/get_transactions'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({status:'OK',txs:[],missed_tx:JSON.parse(body).txs_hashes}));}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:'o',result:{}}));});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${port}`,setMode(m){mode=m;},close:()=>new Promise(r=>server.close(r))};
}
