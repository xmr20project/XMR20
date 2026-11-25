// Stagenet-aware roles + static parameter service + rehearsal harness: LOCAL integration and negative tests.
// Everything here runs on an offline zero-peer regtest fakechain (SIMULATED). Nothing touches stagenet or mainnet.
//   node --test stagenet-roles.test.mjs      (ports 8952/8953 param servers, 30083/30082 fakechain, 30081/30080/8951 rehearsal)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,symlink,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startParamServer,SERVED} from './stagenet/param-server.mjs';
import {startRoles,startFakechain,checkDaemonNetwork,LAB_BIN,closeFetch} from './stagenet/roles.mjs';
import {service} from '../privacy-integration-20261022/rpc.mjs';
import {openPrivateWallet,memoryCache} from './wallet-lib/private-wallet.mjs';
import {runRehearsal} from './stagenet/rehearsal.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));const runs=dir+'runs/';await mkdir(runs,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');const hexrand=()=>createHash('sha256').update(String(Math.random())+Date.now()).digest('hex');
const results={};const record=(k,v)=>{results[k]=v;};
test.after(async()=>{await writeFile(runs+'stagenet-roles-results.json',JSON.stringify(results,null,1)+'\n');});

test('static parameter service serves exactly the three parameter files and nothing else',async()=>{
 const ps=await startParamServer({dir:dir+'params/test-v1',port:8952});
 try{
  const manifest=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
  for(const name of SERVED){const r=await closeFetch(ps.url+'/params/'+name);assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());
   const want=name==='parameters.json'?manifest.parametersJson:manifest.files[name.replace('.public-pk','')];assert.equal(b.length,want.bytes,name+' length');assert.equal(sha(b),want.sha256,name+' sha256');
   const h=await closeFetch(ps.url+'/params/'+name,{method:'HEAD'});assert.equal(h.status,200);assert.equal(Number(h.headers.get('content-length')),want.bytes);}
  const refused=[];for(const p of ['/params/manifest.json','/params/issuer.secret.json','/params/../stagenet-roles.test.mjs','/params/..%2Fpackage.json','/params/wallet-a.root','/params/journal.json','/params/','/','/runs/stagenet-roles-results.json','/params/normal.public-pk/','/params/NORMAL.public-pk']){const r=await closeFetch(ps.url+p);refused.push({p,status:r.status});assert.equal(r.status,404,p);}
  const post=await closeFetch(ps.url+'/params/parameters.json',{method:'POST',body:'x'});assert.equal(post.status,405);
  const info=await (await closeFetch(ps.url+'/params')).json();assert.deepEqual(Object.keys(info.files).sort(),[...SERVED].sort());assert.match(info.note,/not a trust anchor/);
  record('paramServer',{served:SERVED,refused,post:post.status});
 }finally{await ps.close();}
});

test('a parameter server cannot substitute parameters: the wallet keeps its own manifest and hash checks',async()=>{
 // A second server whose directory holds a byte-flipped proving key (inside a query vector) and a foreign parameters.json.
 const tampered=await mkdtemp(runs+'tampered-params-');
 const pk=await readFile(dir+'params/test-v1/normal.public-pk');pk[Math.floor(pk.length/2)]^=1;await writeFile(tampered+'/normal.public-pk',pk);
 await symlink(dir+'params/test-v1/boundary.public-pk',tampered+'/boundary.public-pk');await copyFile(dir+'params/test-v1/parameters.json',tampered+'/parameters.json');
 const good=await startParamServer({dir:dir+'params/test-v1',port:8952});const bad=await startParamServer({dir:tampered,port:8953});
 const chain=await startFakechain({rpcPort:30083,p2pPort:30082,dir:await mkdtemp(runs+'fakechain-neg-')});
 try{
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
  const manifestBytes=await readFile(dir+'params/test-v1/manifest.json');const manifest=JSON.parse(manifestBytes.toString());
  const w=await openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:chain.rpcUrl,parameterServer:bad.url,cache:memoryCache(),fetch:closeFetch,root:hexrand()});
  await assert.rejects(w.loadProvingKey(0),/sha256|hash|authentic|mismatch/i);
  // The same wallet loads the genuine file from the honest server (same manifest; only the transport changed).
  const w2=await openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:chain.rpcUrl,parameterServer:good.url,cache:memoryCache(),fetch:closeFetch,root:hexrand()});
  const loaded=await w2.loadProvingKey(0);assert.ok(loaded);
  // A foreign parameters.json (another setup) is refused at open time under this manifest.
  await copyFile(dir+'params/test-other/parameters.json',tampered+'/parameters.json');
  await assert.rejects(openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:chain.rpcUrl,parameterServer:bad.url,cache:memoryCache(),fetch:closeFetch,root:hexrand()}),/sha256|hash|ledger|version|differs|mismatch/i);
  w.close();w2.close();record('tamperedServer',{corruptedProvingKeyRefused:true,foreignParametersRefused:true,honestServerLoaded:Boolean(loaded)});
 }finally{await good.close();await bad.close();await chain.close();await rm(tampered,{recursive:true,force:true});}
});

test('roles take the network from the trusted manifest: stagenet vs fakechain, mainnet, genesis, RPC URL, start height',async()=>{
 const chain=await startFakechain({rpcPort:30083,p2pPort:30082,dir:await mkdtemp(runs+'fakechain-neg-')});
 const run=await mkdtemp(runs+'roles-neg-');const out={};
 const patched=async(name,fn,from=dir+'params/test-v1/manifest.json')=>{const m=JSON.parse(await readFile(from,'utf8'));fn(m);const p=run+'/'+name+'.json';await writeFile(p,JSON.stringify(m));return p;};
 const binaryRefusal=async(label,paramsDir,trusted,env={})=>{let err=null;let s=null;try{s=await service(LAB_BIN,['indexer',paramsDir,'--trusted-manifest',trusted],{env:{XMR20_INTEGRATION_RPC_URL:chain.rpcUrl,...env}});}catch(e){err=e.message.replace(/\s+/g,' ');}
  if(s){await s.kill();}out[label]={refused:Boolean(err),reason:err?.slice(0,300)||null};return err;};
 try{
  // 1. stagenet manifest, fakechain daemon: refused by the harness before any process, and by the binary itself.
  await assert.rejects(startRoles({paramsDir:dir+'params/stagenet-v0',trustedManifest:dir+'params/stagenet-v0/manifest.json',rpcUrl:chain.rpcUrl,runDir:run+'/a'}),/REFUSED: the trusted manifest selects stagenet/);
  assert.match(await binaryRefusal('binary: stagenet manifest vs fakechain daemon',dir+'params/stagenet-v0',dir+'params/stagenet-v0/manifest.json'),/Stagenet daemon required/);
  // 2. mainnet is refused at both layers (manifest kind "mainnet").
  const mainnetManifest=await patched('mainnet',m=>{m.network.kind='mainnet';});
  await assert.rejects(startRoles({paramsDir:dir+'params/test-v1',trustedManifest:mainnetManifest,rpcUrl:chain.rpcUrl,runDir:run+'/b'}),/REFUSED: unsupported network.kind "mainnet"/);
  assert.match(await binaryRefusal('binary: manifest kind mainnet',dir+'params/test-v1',mainnetManifest),/Unsupported network|mainnet/);
  // 3. genesis mismatch (another chain's genesis in the manifest) refused before any process.
  const genesisManifest=await patched('genesis',m=>{m.network.genesis='11'.repeat(32);});
  await assert.rejects(startRoles({paramsDir:dir+'params/test-v1',trustedManifest:genesisManifest,rpcUrl:chain.rpcUrl,runDir:run+'/c'}),/REFUSED: daemon genesis/);
  // 4. a daemon URL that is not a Monero daemon (the parameter server) is refused.
  const ps=await startParamServer({dir:dir+'params/test-v1',port:8952});
  try{await assert.rejects(startRoles({paramsDir:dir+'params/test-v1',trustedManifest:dir+'params/test-v1/manifest.json',rpcUrl:ps.url,runDir:run+'/d'}));}finally{await ps.close();}
  // 5. positive: fakechain manifest, URL override wins over a wrong legacy port variable; roles start and report their trusted manifest.
  const roles=await startRoles({paramsDir:dir+'params/test-v1',trustedManifest:dir+'params/test-v1/manifest.json',rpcUrl:chain.rpcUrl,runDir:run+'/e',env:{XMR20_INTEGRATION_RPC_PORT:'1'}});
  try{assert.equal(roles.network,'offline-fakechain');assert.equal(roles.startHeight,0);assert.equal(roles.trustedManifest.indexer.sha256,roles.manifestSha256);
   assert.match(roles.issuerNativeAddress,/^4/,'fakechain addresses use the mainnet format');const pub=await roles.indexerScan();out.positive={network:roles.network,tip:pub.tip,issuerAddressPrefix:roles.issuerNativeAddress[0]};}
  finally{await roles.close();}
  // 6. start height ABOVE the tip: roles start with an empty pool (the pool begins in the future), and records below it are ignored.
  const future=await patched('future',m=>{m.network.startHeight=1000;});
  const roles2=await startRoles({paramsDir:dir+'params/test-v1',trustedManifest:future,rpcUrl:chain.rpcUrl,runDir:run+'/f'});
  try{assert.equal(roles2.startHeight,1000);const pub=await roles2.indexerScan();out.futureStart={startHeight:1000,tip:pub.tip,blocks:pub.canonicalBlocks.length};assert.equal(pub.canonicalBlocks.length,0);}
  finally{await roles2.close();}
  record('roleNetworkSelection',out);
 }finally{await chain.close();}
});

test('rehearsal harness, LOCAL mode (simulated fakechain, start height 40): credit → transfer → recovery → transfers',async()=>{
 const r=await runRehearsal({mode:'local',startHeight:40,out:runs+'rehearsal-local.json',log:()=>{}});
 const names=r.steps.map(s=>s.name);
 assert.equal(r.failed,null,'harness failed: '+JSON.stringify(r.failed));assert.equal(r.blocked,null,'harness blocked: '+JSON.stringify(r.blocked));
 assert.match(r.execution,/SIMULATED/);assert.equal(r.sanityChecks,false);
 const roles=r.steps.find(s=>s.name==='roles');assert.equal(roles.network,'offline-fakechain');assert.equal(roles.startHeight,40);
 const syncs=r.steps.filter(s=>s.name==='sync');assert.ok(syncs.every(s=>s.A.startHeight===40&&s.B.startHeight===40),'wallets scan from the start height');
 assert.equal(r.summary.transfers.length,3);assert.deepEqual(r.summary.inputCounts,[1,3,2]);
 assert.deepEqual(r.summary.transfers.map(t=>t.change),['1000000','500000','500000']);
 const fees=r.steps.filter(s=>s.name==='fee-accounting');assert.equal(fees.length,3);assert.ok(fees.every(f=>f.exact===true),'holder paid exactly the quoted fee');
 const resends=r.steps.filter(s=>s.name==='resend-same-blob');assert.equal(resends.length,3);assert.ok(resends.every(x=>x.inPool===true||x.ok===true));
 const recoveries=r.steps.filter(s=>s.name==='recovery');assert.equal(recoveries.length,2);assert.ok(recoveries.every(x=>x.same===true));
 const asserts=r.steps.filter(s=>s.name==='assert-notes');assert.ok(asserts.length>=8&&asserts.every(a=>a.ok===true));
 const admissions=r.steps.filter(s=>s.name==='admission');assert.ok(admissions.every(a=>a.sender==='accepted'&&a.recipient==='accepted'&&a.indexer==='accepted'));
 assert.ok(names.includes('fee-review')&&names.includes('param-server'));
 record('rehearsalLocal',{execution:r.execution,transfers:r.summary.transfers,credits:r.summary.credits.map(c=>({amount:c.amount,issuerFee:c.issuerFee,extraBytes:c.extraBytes})),final:r.summary.final,fees:r.summary.fees});
});
