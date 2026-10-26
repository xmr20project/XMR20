// INDEXER SERVICE: supervises the persistent Rust follower (indexer/) and exposes it over loopback HTTP.
// The follower holds the ledger state (reviewed core pool), persists its block/record log under `stateDir`, recovers from
// restarts and reorganisations by itself; this wrapper only schedules `sync`, serialises requests, restarts the child if it
// dies, and answers HTTP. Public data only; the viewing-key endpoint forwards a key the holder chose to share and stores nothing.
//   GET  /health            {ok, tip, daemonTip, behind, synced, invariant, pendingParts, restarts, lastSyncAt}
//   GET  /status | /summary | /events | /records?from=H
//   GET  /owner/<hex32>     public notes and balances of an owner key
//   GET  /record/<id> | /tx/<txid>
//   POST /verify {wire}     local admission result against the current state (nothing is published)
//   POST /view {viewingKey} shielded balances for a full viewing key (explicit holder action)
//   POST /sync              run a sync now (admin/tests)
// Remote listeners (listen != 127.0.0.1) require a bearer token; loopback needs none.
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,appendFile} from 'node:fs/promises';
import {service} from '../../privacy-integration-20261022/rpc.mjs';
export async function startIndexerService({bin,paramsDir,trustedManifest,rpcUrl,stateDir,httpPort=8970,listen='127.0.0.1',pollMs=5000,maxBlocks=500,token=null,log=()=>{},restartLimit=20}){
 if(listen!=='127.0.0.1'&&!token)throw Error('A bearer token is required when the indexer listens beyond loopback');
 await mkdir(stateDir,{recursive:true});
 const port=new URL(rpcUrl).port||'18081';const env={XMR20_INDEXER_SERVICE:'1',XMR20_INTEGRATION_RPC_URL:rpcUrl,XMR20_INTEGRATION_RPC_PORT:String(port),...(process.env.XMR20_MAINNET_PILOT==='I-UNDERSTAND'?{XMR20_MAINNET_PILOT:'I-UNDERSTAND'}:{})};// the mainnet pilot flag is passed through only when the operator set it explicitly
 let child=null,restarts=0,closing=false,lastSync=null,lastError=null,syncing=null;const children=new Set();
 const start=async()=>{child=await service(bin,[paramsDir,'--trusted-manifest',trustedManifest,'--state',stateDir],{env});children.add(child);log({event:'indexer-started',ready:child.ready});return child.ready;};
 const ready=await start();
 const audit=line=>appendFile(stateDir+'/service.log',JSON.stringify({at:new Date().toISOString(),...line})+'\n').catch(()=>{});
 // Every request goes through the child; if the child died, restart it (its state is on disk) up to restartLimit times.
 async function call(req){for(let attempt=0;;attempt++){try{if(!child||child.child.exitCode!==null||child.child.signalCode!==null){if(closing)throw Error('indexer closing');if(restarts>=restartLimit)throw Error('indexer restart limit reached');restarts++;await audit({event:'restart',restarts});await start();}return await child.call(req);}
  catch(e){if(attempt>=1||closing||!/Service exited|EPIPE|closing/.test(e.message))throw e;await audit({event:'call-failed-restarting',error:e.message.slice(0,200)});child=null;}}}
 async function sync(){if(syncing)return syncing;syncing=(async()=>{try{const r=await call({op:'sync',maxBlocks});lastSync={at:new Date().toISOString(),tip:r.tip,daemonTip:r.daemonTip,behind:r.behind,applied:r.applied.length,reorg:r.reorg};lastError=null;if(r.reorg)await audit({event:'reorganisation',...r.reorg});if(r.applied.length)await audit({event:'applied',count:r.applied.length,records:r.applied.map(a=>({height:a.height,txid:a.txid,recordId:a.recordId,result:a.result.record,kind:a.result.kind}))});return r;}
  catch(e){lastError={at:new Date().toISOString(),message:String(e.message).slice(0,300)};await audit({event:'sync-error',error:lastError.message});throw e;}finally{syncing=null;}})();return syncing;}
 const timer=setInterval(()=>{sync().catch(()=>{});},pollMs);
 await sync().catch(e=>log({event:'initial-sync-failed',error:e.message}));
 const authorized=req=>!token||req.headers.authorization===`Bearer ${token}`;
 const json=(res,code,body,extra={})=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store',...extra});res.end(JSON.stringify(body));};
 const server=createServer(async(req,res)=>{try{
  if(!authorized(req))return json(res,401,{error:'unauthorized'});
  const url=new URL(req.url,'http://x');const path=url.pathname;
  if(req.method==='GET'&&path==='/health'){const st=await call({op:'status'});const behind=lastSync?.behind??null;return json(res,st.invariant.ok?200:503,{ok:st.invariant.ok&&!lastError,tip:st.tip,daemonTip:lastSync?.daemonTip??null,behind,synced:behind!==null&&behind<=1,invariant:st.invariant.ok,pendingParts:st.pendingParts,completedOperations:st.completedOperations,restarts,lastSyncAt:lastSync?.at??null,lastError,network:st.network,domain:st.domain,manifestSha256:st.manifestSha256});}
  if(req.method==='GET'&&path==='/status')return json(res,200,{...(await call({op:'status'})),lastSync,restarts});
  if(req.method==='GET'&&path==='/summary')return json(res,200,await call({op:'summary'}));
  if(req.method==='GET'&&path==='/events')return json(res,200,await call({op:'events'}));
  if(req.method==='GET'&&path==='/records')return json(res,200,await call({op:'records',from:Number(url.searchParams.get('from')||0)}));
  let m;
  if(req.method==='GET'&&(m=/^\/owner\/([0-9a-f]{64})$/.exec(path)))return json(res,200,await call({op:'owner',owner:m[1]}));
  if(req.method==='GET'&&(m=/^\/record\/([0-9a-f]{64})$/.exec(path)))return json(res,200,await call({op:'record',id:m[1]}));
  if(req.method==='GET'&&(m=/^\/tx\/([0-9a-f]{64})$/.exec(path)))return json(res,200,await call({op:'tx',txid:m[1]}));
  if(req.method==='POST'){let body='';for await(const c of req){body+=c;if(body.length>65536)throw Error('Too large');}const args=body?JSON.parse(body):{};
   if(path==='/sync')return json(res,200,await sync());
   if(path==='/verify'){if(!/^[0-9a-f]{2,2022}$/.test(args.wire||''))throw Error('wire hex required');return json(res,200,await call({op:'verify',wire:args.wire}));}
   if(path==='/view'){if(typeof args.viewingKey!=='string'||!args.viewingKey.startsWith('penumbrafullviewingkey1'))throw Error('full viewing key required');await audit({event:'view',keyDigest:createHash('sha256').update(args.viewingKey).digest('hex').slice(0,16)});return json(res,200,await call({op:'view',viewingKey:args.viewingKey}));}
   if(path==='/publish'){if(!/^[0-9a-f]+$/.test(args.blob||''))throw Error('blob hex required');return json(res,200,await call({op:'publishBlob',blob:args.blob}));}}
  json(res,404,{error:'not found'});}
  catch(e){json(res,400,{error:String(e.message).slice(0,400)});}});
 await new Promise(r=>server.listen(httpPort,listen,r));
 const url=`http://${listen}:${httpPort}`;log({event:'indexer-http',url});
 return {url,ready,stateDir,call,sync,get lastSync(){return lastSync;},get restarts(){return restarts;},
  // tests: kill the child abruptly to exercise restart-from-disk
  async crashChild(){await child?.kill();},
  async close(){closing=true;clearInterval(timer);server.closeAllConnections?.();await new Promise(r=>server.close(r));await child?.close().catch(()=>{});for(const c of children)await c.kill().catch(()=>{});}};
}
export function createIndexerClient(url,{token=null,fetchImpl=globalThis.fetch}={}){
 const headers={'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),connection:'close'};
 const get=async p=>{const r=await fetchImpl(url+p,{headers,signal:AbortSignal.timeout(60000)});const v=await r.json();if(!r.ok&&v.error)throw Error(v.error);return v;};
 const post=async(p,b)=>{const r=await fetchImpl(url+p,{method:'POST',headers,body:JSON.stringify(b),signal:AbortSignal.timeout(120000)});const v=await r.json();if(!r.ok)throw Error(v.error||'indexer refused');return v;};
 return {url,health:()=>get('/health'),status:()=>get('/status'),summary:()=>get('/summary'),events:()=>get('/events'),records:from=>get('/records?from='+(from||0)),owner:o=>get('/owner/'+o),record:id=>get('/record/'+id),tx:t=>get('/tx/'+t),verify:wire=>post('/verify',{wire}),view:viewingKey=>post('/view',{viewingKey}),sync:()=>post('/sync',{}),publish:blob=>post('/publish',{blob})};
}
export const randomToken=()=>randomBytes(24).toString('hex');
