// STAGENET test service for the "XMR20 Stagenet — Test funds only" extension build. TEST FUNDS ONLY.
//
// What it is: the loopback counterpart of backend/service.mjs for PUBLIC STAGENET. It starts nothing on the chain side
// (the isolated stagenet node runs separately, operations/stagenet-node-20261023), checks that node is STAGENET (mainnet
// refused before anything else), starts the laboratory issuer and indexer roles bound to the TRUSTED stagenet manifest,
// serves the three parameter files as plain transport, and offers the popup a small set of labelled TEST SERVICES:
//   state     network facts, confirmations, the asset list, which test services exist (no mine, no fund, no bridge)
//   register  remembers a holder by PUBLIC token address (+ its stagenet XMR address for the faucet); no keys
//   credit    TEST SERVICE: the lab issuer publishes an XB3 credit of a fixed amount to the holder's private address and
//             pays that carrier's stagenet fee itself (rate-limited per address)
//   faucet    TEST SERVICE: asks the public cypherfaucet.com API for 0.01 worthless stagenet XMR for the holder's address
//   view      explicit viewing-key sharing with the test indexer (the key is forwarded, never stored)
// What it never holds: seeds, spend keys, viewing keys (except in flight for `view`), carriers, key images, journals.
// Holder facts (token address, stagenet address, credits issued) persist in runs/stagenet-backend-state.json so the
// owner's wallets stay registered across restarts. Audit log: <run>/requests.log. Bridge payouts and native XMR trading:
// not present here at all (gated elsewhere; nothing in this file pays anyone).
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startRoles,checkDaemonNetwork,daemonRpc} from '../stagenet/roles.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url)),candidate=path.resolve(dir,'..');
export const CONFIRMATIONS=10;            // lab setting; not a reviewed depth for any claim
export const DEFAULT_RPC='http://127.0.0.1:38091',DEFAULT_PORT=8961;
export const ASSET_DENOM='uxmr20private-rehearsal';   // the stagenet rehearsal asset (same ledger domain as the roles milestone)
const STAGENET_ADDRESS=/^5[1-9A-HJ-NP-Za-km-z]{94}$/;
export async function startStagenetBackend({rpcUrl=DEFAULT_RPC,httpPort=DEFAULT_PORT,manifestPath=path.join(candidate,'params/stagenet-v0-trusted/manifest.json'),paramsDir=path.join(candidate,'params/stagenet-v0'),runDir=null,stateFile=path.join(candidate,'runs/stagenet-backend-state.json'),faucetLog=path.join(candidate,'runs/faucet-claims.jsonl'),creditAmount='10000000',maxCreditsPerAddress=6,log=()=>{},faucetEnabled=true}={}){
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(manifest.network?.kind!=='stagenet')throw Error('REFUSED: the trusted manifest is not a stagenet manifest ('+manifest.network?.kind+').');
 const net=await checkDaemonNetwork(rpcUrl,manifest);   // refuses mainnet, requires nettype stagenet and the manifest genesis
 const run=runDir||path.join(candidate,'runs','stagenet-backend-'+new Date().toISOString().replace(/[:.]/g,'-').slice(0,19));await mkdir(run,{recursive:true});
 const audit=line=>appendFile(run+'/requests.log',JSON.stringify({at:new Date().toISOString(),...line})+'\n');
 // Persistent holder facts (public data only).
 let state={holders:{},aliases:{}};try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
 const persist=()=>writeFile(stateFile,JSON.stringify(state,null,1));
 const roles=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl,runDir:run,log:x=>log(JSON.stringify(x))});
 const asset=await roles.assetId(ASSET_DENOM);
 // The lab issuer learns the network and its spendable outputs from a scan; credits before any scan are refused by its
 // fakechain default guard (found by the stagenet popup run, attempt 3). Scan once now and again before every credit.
 await roles.issuerScan();
 const pkInfo={};for(const name of ['normal','boundary']){const file=path.join(paramsDir,name+'.public-pk');pkInfo[name]={bytes:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')};}
 const holder=id=>{const h=state.holders[state.aliases[id]];assert.ok(h,'Account not registered with the stagenet test service');return h;};
 const issuerFacts=async()=>{try{const s=await roles.issuerScan();return {nativeAddress:roles.issuerNativeAddress,unlocked:String(s.issuerNative??s.native?.unlocked??'?')};}catch(e){return {nativeAddress:roles.issuerNativeAddress,error:e.message.slice(0,200)};}};
 const actions={
  async state({id}){const pub=await roles.indexerScan();const info=await daemonRpc(rpcUrl,'get_info');const registered=Boolean(state.aliases[id]);const h=registered?holder(id):null;
   return {network:'stagenet',nettype:info.nettype,synchronized:info.synchronized,tip:info.height-1,poolTip:pub.tip,startHeight:net.startHeight,confirmations:CONFIRMATIONS,rpcUrl,registered,tokenAddress:h?.tokenAddress??null,relay:null,carrierFunding:'holder',
    features:{mine:false,fund:false,bridge:false,credit:true,faucet:faucetEnabled,view:true},creditAmount,creditsIssued:h?.credits?.length??0,explorer:'https://stagenet.xmrchain.net/tx/',
    assets:[{symbol:'X',name:'XMR20 private (stagenet test)',asset,layout:'stagenet-test',viewingKeyShared:Boolean(h?.viewingShared?.includes('X')),legacy:[],payouts:[],solanaBalance:'0'}],
    note:'STAGENET — test funds only. No bridge, no payouts, no trading. Nothing here is a production service.'};},
  async register({id,sol,xmr,tokenAddress}){assert.match(id,/^[A-Za-z0-9_-]{1,64}$/);assert.ok(typeof tokenAddress==='string'&&tokenAddress.startsWith('penumbra1')&&tokenAddress.length<200,'Private token address required');assert.match(String(xmr),STAGENET_ADDRESS,'A STAGENET Monero address is required (mainnet addresses are refused)');
   const existing=state.holders[tokenAddress];if(existing){state.aliases[id]=tokenAddress;if(!existing.ids.includes(id))existing.ids.push(id);await persist();await audit({action:'register',id,tokenAddress,existing:true});return {registered:true,tokenAddress,existing:true,note:'Known holder (same private address): facts reattached; no private state exists on this service.'};}
   state.holders[tokenAddress]={tokenAddress,xmr,sol:typeof sol==='string'?sol:null,ids:[id],viewingShared:[],credits:[],registeredAt:new Date().toISOString()};state.aliases[id]=tokenAddress;await persist();await audit({action:'register',id,tokenAddress});
   return {registered:true,tokenAddress,note:'Holder registered by public token address. This service holds no holder keys.'};},
  // TEST SERVICE: issuer-funded XB3 credit to the holder's private address. The issuer's own stagenet XMR pays the carrier.
  async credit({id,symbol}){const h=holder(id);assert.equal(symbol,'X','asset');assert.ok(h.credits.length<maxCreditsPerAddress,'Credit limit reached for this address ('+maxCreditsPerAddress+' per address in this test service)');
   await roles.issuerScan();const binding=randomBytes(32).toString('hex');const c=await roles.credit({to:h.tokenAddress,asset,amount:creditAmount,binding});
   h.credits.push({txid:c.txid,amount:creditAmount,fee:String(c.fee),at:new Date().toISOString()});await persist();await audit({action:'credit',id,tokenAddress:h.tokenAddress,txid:c.txid,amount:creditAmount,issuerFee:String(c.fee)});
   return {txid:c.txid,recordId:c.recordId,amount:creditAmount,fee:String(c.fee),extraBytes:c.extraBytes,nativeBytes:c.nativeBytes,confirmations:CONFIRMATIONS,note:'TEST SERVICE: credit published on stagenet by the lab issuer (issuer-paid fee). Visible after '+CONFIRMATIONS+' confirmations.'};},
  // TEST SERVICE: public faucet claim for the holder's stagenet address (worthless coins). One claim per address per hour.
  async faucet({id}){assert.ok(faucetEnabled,'Faucet requests are disabled in this service');const h=holder(id);
   let last=null;try{for(const l of (await readFile(faucetLog,'utf8')).split('\n'))if(l){const r=JSON.parse(l);if(r.address===h.xmr&&r.ok)last=r.at;}}catch{}
   if(last&&Date.now()-Date.parse(last)<3600_000)return {ok:false,error:'rate_limited_locally',message:'This address already received faucet coins at '+last+'; the faucet allows one claim per address per hour.'};
   const out=await new Promise((res,rej)=>execFile('sh',[path.join(candidate,'stagenet/faucet-claim.sh'),h.xmr,faucetLog],{timeout:90000},(e,stdout,stderr)=>e?rej(Error(stderr||e.message)):res(stdout)));
   const r=JSON.parse(out.trim().split('\n').pop());await audit({action:'faucet',id,address:h.xmr,ok:r.ok,txid:r.txid||null,error:r.error||null});
   return {ok:Boolean(r.ok),amount:r.amount||null,txid:r.txid||null,error:r.error||null,message:r.message||null,address:h.xmr,note:'TEST SERVICE: public stagenet faucet (worthless coins); spendable after 10 confirmations.'};},
  // Explicit viewing-key sharing: forwarded to the indexer process for this request only; nothing stored.
  async view({id,symbol,viewingKey}){const h=holder(id);assert.equal(symbol,'X','asset');assert.ok(typeof viewingKey==='string'&&viewingKey.startsWith('penumbrafullviewingkey1'),'Full viewing key required');await roles.indexerScan();const v=await roles.indexer.call({op:'view',viewingKey});if(!h.viewingShared.includes('X'))h.viewingShared.push('X');await persist();await audit({action:'view',id,symbol});return {balance:v.balances?.[asset]??'0',notes:v.notes,canSpend:false};},
  async issuer(){return issuerFacts();},
 };
 const server=createServer(async(req,res)=>{const origin=req.headers.origin||'';const cors={'access-control-allow-origin':origin||'*','access-control-allow-headers':'content-type','access-control-allow-methods':'POST, GET, OPTIONS','vary':'origin'};try{
  if(req.headers.host!==`127.0.0.1:${httpPort}`)throw Error('Loopback host only');
  if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))throw Error('Origin not allowed');
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  if(req.method==='GET'&&req.url==='/params'){res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify({network:'stagenet',provingKeys:pkInfo,confirmations:CONFIRMATIONS,rpcUrl,label:manifest.label,note:'Transport only: the holder authenticates parameters against the manifest shipped in its own build.'}));}
  if(req.method==='GET'&&/^\/params\/(normal\.public-pk|boundary\.public-pk|parameters\.json)$/.test(req.url)){const name=req.url.slice(8);const file=path.join(paramsDir,name);const size=(await stat(file)).size;await audit({action:'serve-parameter',name});res.writeHead(200,{'content-type':name.endsWith('.json')?'application/json':'application/octet-stream','content-length':String(size),'cache-control':'no-store',...cors});return createReadStream(file).pipe(res);}
  if(req.method==='POST'&&req.url.startsWith('/action/')){const name=req.url.slice(8);if(!actions[name])throw Error('Unknown action');let body='';for await(const c of req){body+=c;if(body.length>16384)throw Error('Too large');}const args=JSON.parse(body||'{}');
   for(const k of Object.keys(args))if(/seed|secret|private|unlock|password|spend|image|carrier|blob|ring|wire/i.test(k))throw Error('Refused: secret-looking or carrier field '+k);
   if(name!=='view'&&Object.values(args).some(v=>typeof v==='string'&&v.startsWith('penumbrafullviewingkey')))throw Error('Refused: viewing key outside the explicit share action');
   const result=await actions[name](args);res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify(result));}
  res.writeHead(404,cors);res.end();}
  catch(e){log(e.message);res.writeHead(400,{'content-type':'application/json',...cors});res.end(JSON.stringify({error:String(e.message).slice(0,400)}));}});
 await new Promise(r=>server.listen(httpPort,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${httpPort}/`,rpcUrl,run,network:'stagenet',startHeight:net.startHeight,asset,manifestSha256:roles.manifestSha256,issuerNativeAddress:roles.issuerNativeAddress,roles,actions,state,stateFile,async issuer(){return issuerFacts();},
  async close(){await new Promise(r=>server.close(r));await roles.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
 const b=await startStagenetBackend({rpcUrl:opt('rpc',DEFAULT_RPC),httpPort:Number(opt('port',DEFAULT_PORT)),log:console.error});await writeFile(b.run+'/pid',String(process.pid));
 console.log(JSON.stringify({ready:true,url:b.url,rpcUrl:b.rpcUrl,run:b.run,network:b.network,startHeight:b.startHeight,asset:b.asset,issuer:await b.issuer(),pid:process.pid,note:'STAGENET test service (test funds only). Stop with: kill '+process.pid}));
 const stop=async()=>{await b.close().catch(()=>{});process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
