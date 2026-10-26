// Stagenet-aware LABORATORY ROLES (issuer + indexer) and the local fakechain, for the rehearsal harness and its tests.
//
// The roles are THIS candidate's binary (format/). Every role REQUIRES a trusted
// manifest (XMR20-PARAMS-2) given on a path independent of the parameter directory, authenticates parameters.json and
// the proving keys against it before use, and takes the NETWORK from that manifest: network.kind "offline-fakechain"
// (zero-peer regtest fakechain; all earlier labs) or "stagenet" (a stagenet daemon with NORMAL Monero validation).
// Mainnet is refused twice: here before any process starts, and inside the binary (native::guard) from the daemon's
// own get_info. The daemon's genesis must equal the manifest's; records below network.startHeight are outside the pool.
//
// Nothing here is a production service: the issuer signs credits with the disposable setup's issuer key, which lives in
// params/<set>/issuer.secret.json (synthetic). This module never reads that file; the binary does.
import {spawn} from 'node:child_process';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {service} from '../../privacy-integration-20261022/rpc.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const LAB_BIN=path.resolve(here,'../target/release/xmr20-unshielded-lab');
export const MONEROD=path.resolve(here,'../../../operations/native-market-20261016/local-chain/bin/monerod');
export const SUPPORTED_NETWORKS=['offline-fakechain','stagenet'];
export const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
export async function daemonRpc(rpcUrl,method,params={},timeoutMs=30000){
 const r=await closeFetch(rpcUrl.replace(/\/$/,'')+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'r',method,params}),signal:AbortSignal.timeout(timeoutMs)});
 const v=await r.json();if(v.error)throw Error(`${method}: ${v.error.message}`);return v.result;}
// Daemon identity check shared by every caller: refuses mainnet outright, then requires the manifest's network.
export async function checkDaemonNetwork(rpcUrl,manifest){
 const info=await daemonRpc(rpcUrl,'get_info');
 if(info.mainnet===true||info.nettype==='mainnet')throw Error('REFUSED: mainnet daemon ('+rpcUrl+'); this research harness never touches mainnet');
 const kind=manifest.network.kind;
 if(!SUPPORTED_NETWORKS.includes(kind))throw Error('REFUSED: unsupported network.kind '+JSON.stringify(kind)+' in the trusted manifest');
 if(kind==='stagenet'&&!(info.nettype==='stagenet'&&info.stagenet===true))throw Error('REFUSED: the trusted manifest selects stagenet but the daemon reports nettype '+info.nettype);
 if(kind==='offline-fakechain'&&!(info.nettype==='fakechain'&&info.offline===true&&info.incoming_connections_count===0&&info.outgoing_connections_count===0))throw Error('REFUSED: the trusted manifest selects the offline fakechain but the daemon reports nettype '+info.nettype+' offline '+info.offline);
 const genesis=(await daemonRpc(rpcUrl,'get_block',{height:0})).block_header.hash;
 if(genesis!==manifest.network.genesis)throw Error('REFUSED: daemon genesis '+genesis.slice(0,16)+'… is not the trusted manifest\'s network '+manifest.network.genesis.slice(0,16)+'…');
 return {info,genesis,kind,startHeight:manifest.network.startHeight||0};
}
// Start issuer and indexer. `trustedManifest` is a PATH (copied to runDir/trusted/manifest.json so it is never the
// parameter directory's own copy); `paramsDir` holds parameters.json, the proving keys and issuer.secret.json.
export async function startRoles({paramsDir,trustedManifest,rpcUrl,runDir,bin=LAB_BIN,env={},roles=['issuer','indexer'],log=()=>{}}){
 const manifestBytes=await readFile(trustedManifest);const manifest=JSON.parse(manifestBytes.toString('utf8'));
 const net=await checkDaemonNetwork(rpcUrl,manifest);   // refuse before any role process exists
 await mkdir(path.join(runDir,'trusted'),{recursive:true});const trusted=path.join(runDir,'trusted','manifest.json');await copyFile(trustedManifest,trusted);
 const port=new URL(rpcUrl).port||'18081';
 const renv={XMR20_INTEGRATION_RPC_URL:rpcUrl,XMR20_INTEGRATION_RPC_PORT:String(port),...env};
 const started={};
 try{for(const role of roles){started[role]=await service(bin,[role,path.resolve(paramsDir),'--trusted-manifest',trusted],{env:renv});log({role,ready:started[role].ready});}}
 catch(e){for(const s of Object.values(started))await s.kill().catch(()=>{});throw Error('ROLE REFUSED TO START: '+e.message.replace(/\s+/g,' ').slice(0,600));}
 const issuer=started.issuer||null,indexer=started.indexer||null;
 return {
  network:net.kind,startHeight:net.startHeight,genesis:net.genesis,manifest,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),issuer,indexer,
  issuerNativeAddress:issuer?.ready.issuerNativeAddress||null,issuerTokenAddress:issuer?.ready.issuerTokenAddress||null,
  trustedManifest:{issuer:issuer?.ready.trustedManifest||null,indexer:indexer?.ready.trustedManifest||null},
  async assetId(mint){return (await (indexer||issuer).call({op:'asset',mint})).asset;},
  // Issuer PUBLIC credit (XC1, kind 1 = deposit-style credit) to an OWNER KEY carried by an ordinary Monero transaction that the ISSUER's own
  // native wallet funds (its fee is the issuer's, not the holder's). Returns the carrier facts and the record id.
  async credit({owner,asset,amount,kind=1,binding}){const built=await issuer.call({op:'credit',owner,asset,amount:String(amount),kind,binding});const pub=await issuer.call({op:'publishBlob',blob:built.blob});
   return {txid:built.txid,recordId:built.recordId,fee:built.fee,extraBytes:built.extraBytes,nativeBytes:built.nativeBytes,published:pub};},
  async issuerScan(){return issuer.call({op:'scan'});},
  // TEST SERVICE: plain stagenet XMR payments from the issuer's test wallet (several outputs in one transaction).
  async pay(payments){return issuer.call({op:'pay',payments:payments.map(p=>({address:p.address,amount:String(p.amount)}))});},
  async indexerScan(){return (await indexer.call({op:'scan'})).public;},
  async close(){for(const s of [issuer,indexer])if(s)await s.close().catch(()=>{});},
 };
}
// Offline zero-peer regtest fakechain for LOCAL (simulated) runs. Same daemon flags as the test backend.
export async function startFakechain({rpcPort,p2pPort,dir,log=()=>{}}){
 await mkdir(dir+'/data',{recursive:true});await writeFile(dir+'/config','');
 const child=spawn(MONEROD,['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',dir+'/data','--config-file',dir+'/config','--log-file',dir+'/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2'],{stdio:'ignore'});
 const rpcUrl=`http://127.0.0.1:${rpcPort}`;let ready=false;
 for(let i=0;i<150&&!ready;i++){try{const info=await daemonRpc(rpcUrl,'get_info');if(info.nettype==='fakechain'&&info.offline===true)ready=true;}catch{await new Promise(r=>setTimeout(r,200));}}
 if(!ready){child.kill('SIGKILL');throw Error('fakechain daemon did not start');}
 log({fakechain:rpcUrl,pid:child.pid});
 return {rpcUrl,pid:child.pid,
  rpc:(m,p)=>daemonRpc(rpcUrl,m,p),
  async height(){return (await daemonRpc(rpcUrl,'get_info')).height-1;},
  async mine(address,n){for(let left=n;left>0;left-=50)await daemonRpc(rpcUrl,'generateblocks',{wallet_address:address,amount_of_blocks:Math.min(50,left)},120000);return this.height();},
  async close(){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await done;},
 };
}
