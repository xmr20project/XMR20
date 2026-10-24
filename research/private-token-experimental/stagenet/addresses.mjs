#!/usr/bin/env node
// Print the three STAGENET funding addresses (issuer, wallet A, wallet B) WITHOUT a synced node, so faucet coins can be
// requested while the node is still synchronizing. Starts the lab issuer against the (possibly syncing) daemon only to
// read its native address, opens the two holder wallets from --wallet-dir (roots created there, mode 0600, never
// logged), prints the addresses and stops everything it started. Nothing is broadcast; no funds are moved.
// The daemon must already report nettype stagenet with the manifest's genesis (mainnet is refused by every layer).
//   node stagenet/addresses.mjs --rpc http://127.0.0.1:38091 --manifest runs/stagenet/trusted-manifest.json \
//        --params-dir params/stagenet-v0 --wallet-dir runs/stagenet/wallets [--param-port 8951] [--out runs/stagenet/addresses.json]
import {readFile,writeFile,mkdir,mkdtemp,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
import {startParamServer} from './param-server.mjs';
import {startRoles,checkDaemonNetwork,closeFetch} from './roles.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const CANDIDATE=path.resolve(here,'..');
const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
const rpcUrl=opt('rpc');if(!rpcUrl)throw Error('--rpc required');
const paramsDir=path.resolve(opt('params-dir',path.join(CANDIDATE,'params/stagenet-v0')));
const manifestPath=path.resolve(opt('manifest',path.join(paramsDir,'manifest.json')));
const walletDir=path.resolve(opt('wallet-dir',path.join(CANDIDATE,'runs/stagenet/wallets')));await mkdir(walletDir,{recursive:true});
const manifestBytes=new Uint8Array(await readFile(manifestPath));const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
if(manifest.network.kind!=='stagenet')throw Error('stagenet manifest required');
const net=await checkDaemonNetwork(rpcUrl,manifest);   // refuses mainnet / wrong nettype / wrong genesis
const log=m=>console.error(typeof m==='string'?m:JSON.stringify(m).slice(0,300));
const own=[];
try{
 const ps=await startParamServer({dir:paramsDir,port:Number(opt('param-port','8951')),log});own.push(ps);
 const run=await mkdtemp(path.join(CANDIDATE,'runs','addresses-'));
 const roles=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl,runDir:run,log,roles:['issuer']});own.push(roles);
 const rootOf=async(name)=>{const f=path.join(walletDir,`${name}.root`);try{const t=(await readFile(f,'utf8')).trim();if(!/^[0-9a-f]{64}$/.test(t))throw Error('bad root file '+f);return t;}catch(e){if(e.code!=='ENOENT')throw e;const r=Buffer.from(randomBytes(32)).toString('hex');await writeFile(f,r+'\n',{mode:0o600});await chmod(f,0o600);return r;}};
 const wasm=await WebAssembly.compile(await readFile(opt('wasm',path.join(CANDIDATE,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'))));
 const out={network:net.kind,genesis:net.genesis,startHeight:net.startHeight,daemonHeight:net.info.height,synchronized:net.info.synchronized,trustedManifestSha256:roles.manifestSha256,walletDir,
  issuer:{native:roles.issuerNativeAddress,token:roles.issuerTokenAddress}};
 for(const [k,name] of [['A','wallet-a'],['B','wallet-b']]){const w=await openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:rpcUrl,parameterServer:ps.url,cache:memoryCache(),fetch:closeFetch,root:await rootOf(name)});
  out[k]={native:w.nativeAddress(),token:w.address()};w.close();}
 out.fundingNeeded={issuer:'> 0.01 XMR unlocked, ideally 2-3 separate outputs (one per credit carrier; change relocks 10 blocks)',A:'> 0 unlocked (holder-paid carrier fees)',B:'> 0 unlocked'};
 out.note='STAGENET addresses for worthless faucet coins; funds must arrive at or above startHeight; 10 confirmations before use';
 const outFile=opt('out');if(outFile){await mkdir(path.dirname(path.resolve(outFile)),{recursive:true});await writeFile(outFile,JSON.stringify(out,null,1)+'\n');}
 console.log(JSON.stringify(out,null,1));
}finally{for(const c of own.reverse())await c.close().catch(()=>{});}
