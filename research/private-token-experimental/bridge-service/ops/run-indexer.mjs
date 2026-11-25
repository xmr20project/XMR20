// Start the persistent indexer service from the same configuration file the bridge service uses.
//   node ops/run-indexer.mjs ops/config.json [--state <dir>] [--port <n>]
// Prints one JSON ready line; stops cleanly on SIGINT/SIGTERM. Refuses mainnet exactly as the bridge does (manifest network).
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {startIndexerService} from '../bridge/indexer-service.mjs';
import {loadConfig} from '../bridge/bridge-service.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const file=process.argv[2];if(!file){console.error('usage: node ops/run-indexer.mjs <config.json> [--state dir] [--port n]');process.exit(2);}
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const cfg=await loadConfig(file);const manifest=JSON.parse(await readFile(cfg.trustedManifest,'utf8'));
if(manifest.network.kind==='mainnet'||cfg.network==='mainnet'){console.error('REFUSED: no mainnet manifest exists in this candidate');process.exit(3);}
const url=new URL(cfg.indexerUrl);const port=Number(arg('--port',url.port||8970));
const stateDir=path.resolve(path.dirname(path.resolve(file)),arg('--state',cfg.indexerState||path.join(cfg.journalDir,'..','indexer-state')));
const bin=cfg.indexerBin?path.resolve(path.dirname(path.resolve(file)),cfg.indexerBin):path.resolve(here,'../../token-format-unshielded-20261025/target/release/xmr20-indexer');
const svc=await startIndexerService({bin,paramsDir:cfg.paramsDir,trustedManifest:cfg.trustedManifest,rpcUrl:cfg.daemonRpc,stateDir,httpPort:port,listen:url.hostname,token:cfg.indexerToken||null,pollMs:cfg.indexerPollMs||cfg.pollMs||10000,maxBlocks:cfg.indexerMaxBlocks||500,log:x=>console.error('[indexer] '+(typeof x==='string'?x:JSON.stringify(x).slice(0,300)))});
console.log(JSON.stringify({ready:true,url:svc.url,stateDir,network:manifest.network.kind,pid:process.pid}));
const stop=async()=>{await svc.close().catch(()=>{});process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
