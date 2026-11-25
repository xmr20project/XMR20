// Long-lived holder worker for the private-holder test build. One instance per
// unlocked account; the popup terminates it on lock, account switch or close.
//
// Secret boundary: the recovery phrase enters this worker once ("open"). The
// shipping monero-ts build turns it into the account's private spend key (the
// phrase's own 32 bytes); that root goes into the wasm engine's `derive` op and
// is wiped. From then on the token spend key, full viewing key, decrypted notes,
// proof witnesses and randomizers exist only inside the wasm linear memory of
// this worker. Replies carry public data: token address, balances, note
// commitments and amounts (to the popup only), finished records.
// Explicit exception: `viewingKey` returns the full viewing key when the user
// chooses to share it. Scanning uses the Monero daemon's public RPC directly.
//
// Parameter trust (this candidate): the manifest shipped in this build
// (parameters-manifest.json, sha256 compiled in as __PARAMS_MANIFEST_SHA256__)
// is the only trust anchor for proving/verifying parameters. The parameter
// server's parameters.json and proving-key files are authenticated against it
// before parsing; cached files are re-authenticated on every read.
import {createHolderEngine,createChainScanner} from './holder-engine.js';
import {checkManifest,createParameterLoader,createIndexedDbCache} from './holder-params.js';
import {createCarrierBuilder} from './holder-carrier.js';
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
const hexToBytes=h=>Uint8Array.from(h.match(/../g),x=>parseInt(x,16));
const PINNED_MANIFEST_SHA256=typeof __PARAMS_MANIFEST_SHA256__==='string'?__PARAMS_MANIFEST_SHA256__:null;
let engine=null,scanner=null,backend='',params=null,loader=null,carrier=null,tokenAddress='',network=null;const paramLog=[];
const post=(id,progress)=>self.postMessage({id,progress});
// The account stores its MAINNET-format address (the extension's key worker). The engine formats the same keys for the
// manifest's network (stagenet prefix on stagenet), so the match is checked against the address of the same seed in that
// network: monero-ts networkType 0 = mainnet (the saved account), 2 = stagenet. Both addresses come from one key pair.
async function rootFromSeed(seed,owner,networkKind='offline-fakechain'){
 if(typeof seed!=='string'||seed.trim().split(/\s+/).length!==25)throw Error('Saved Monero wallet is unavailable.');
 importScripts('monero-0.11.16.js');const m=await self.monero_ts({print:()=>{},printErr:()=>{}});
 const clean=seed.trim().toLowerCase().replace(/\s+/g,' ');
 const openAs=networkType=>new Promise((resolve,reject)=>m.create_full_wallet(JSON.stringify({networkType,seed:clean,seedOffset:'',path:'',password:'',restoreHeight:0}),'private-holder-offline',v=>typeof v==='number'&&v>0?resolve(v):reject(Error('Monero keys unavailable.'))));
 const p=await openAs(0);let expectedNative=owner;
 try{if(m.get_address(p,0,0)!==owner)throw Error('Saved Monero wallet does not match this account.');if(typeof m.get_private_spend_key!=='function')throw Error('BLOCKER: this monero-ts build exposes no private spend key accessor.');
  if(networkKind==='stagenet'){const q=await openAs(2);try{expectedNative=m.get_address(q,0,0);}finally{await new Promise(r=>m.close(q,false,0,r));}}
  const root=hexToBytes(m.get_private_spend_key(p));if(root.length!==32)throw Error('Unexpected key length');return {root,expectedNative};}
 finally{await new Promise(r=>m.close(p,false,0,r));}
}
async function shippedManifest(){
 const r=await fetch('parameters-manifest.json');if(!r.ok)throw Error('This build ships no parameter manifest; parameters cannot be authenticated.');
 const {manifest,sha256}=await checkManifest(new Uint8Array(await r.arrayBuffer()),{expectedSha256:PINNED_MANIFEST_SHA256});
 return {manifest,sha256,pinned:Boolean(PINNED_MANIFEST_SHA256)};
}
self.onmessage=async({data})=>{if(typeof data?.id!=='string')return;const {id,action}=data;try{let result;
 switch(action){
  case 'open':{
   if(engine)throw Error('Already open');backend=data.backend;const wasm=await WebAssembly.compileStreaming(fetch('holder.wasm'));engine=await createHolderEngine({wasm});
   post(id,{phase:'params',text:'Checking the parameter manifest shipped with this build…'});
   const shipped=await shippedManifest();params=shipped;const manifestKind=shipped.manifest.network?.kind||'offline-fakechain';
   post(id,{phase:'keys',text:'Deriving the private token keys from this account’s recovery phrase inside the extension…'});
   let {root,expectedNative}=await rootFromSeed(data.seed,data.owner,manifestKind);data.seed='';const d=engine.call({op:'derive',root:Array.from(root,b=>b.toString(16).padStart(2,'0')).join(''),account:0});root.fill(0);root=null;

   loader=createParameterLoader({manifest:shipped.manifest,engine,baseUrl:backend,cache:createIndexedDbCache(),onProgress:p=>post(id,p),log:e=>{paramLog.push({at:Date.now(),...e});if(paramLog.length>50)paramLog.shift();}});
   post(id,{phase:'params',text:'Authenticating the parameter server’s configuration against the shipped manifest…'});
   const served=await loader.loadServedConfig();
   engine.call({op:'params',manifest:shipped.manifest,served});
   // The engine's native wallet (carrier fees) must be the account's own Monero wallet. The engine formats the address for the
   // manifest's network only once the parameters (and so the network) are loaded, hence the check happens here.
   const nativeAddress=engine.call({op:'nativeAddress'}).nativeAddress;
   if(nativeAddress!==expectedNative){engine.call({op:'close'});throw Error('Derived Monero address does not match this account ('+manifestKind+').');}
   // NETWORK from the shipped manifest (offline-fakechain | stagenet). Mainnet is refused here, before anything is scanned,
   // from the daemon's own get_info; the scanner refuses again on every sync and checks the genesis against the manifest.
   const net=shipped.manifest.network||{};const kind=net.kind||'offline-fakechain';if(!['offline-fakechain','stagenet'].includes(kind))throw Error('REFUSED: the shipped manifest selects an unsupported network ('+kind+').');
   const infoR=await fetch(data.rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'n',method:'get_info'}),signal:AbortSignal.timeout(30000)});if(!infoR.ok)throw Error('The Monero node did not answer (HTTP '+infoR.status+').');const info=(await infoR.json()).result||{};
   if(info.mainnet===true||info.nettype==='mainnet')throw Error('REFUSED: this test wallet never connects to a MAINNET node ('+data.rpc+'). Use the isolated stagenet node.');
   if(kind==='stagenet'&&!(info.nettype==='stagenet'&&info.stagenet===true))throw Error('REFUSED: the node at '+data.rpc+' reports network "'+info.nettype+'"; this wallet is bound to STAGENET (test funds only).');
   network={kind,startHeight:Number(net.startHeight)||0,nettype:info.nettype};
   scanner=createChainScanner(engine,{rpc:data.rpc,genesis:net.genesis,network:kind,startHeight:network.startHeight,onProgress:p=>post(id,{...p,text:`Scanning the public ${kind==='stagenet'?'stagenet':'test'} chain locally · block ${p.height} of ${p.target}`})});
   // monerod sanity checks ON off the fakechain (normal validation); only the tiny offline chain cannot satisfy them.
   carrier=createCarrierBuilder({engine,rpc:data.rpc,onProgress:p=>post(id,p),sanityChecks:kind!=='offline-fakechain'});
   tokenAddress=d.tokenAddress;result={tokenAddress,nativeAddress,scheme:d.scheme,domain:shipped.manifest.ledgerDomain,network,parameters:{label:shipped.manifest.label,manifestSha256:shipped.sha256,pinnedInBuild:shipped.pinned,files:Object.fromEntries(Object.entries(shipped.manifest.files).map(([k,v])=>[k,{bytes:v.bytes,sha256:v.sha256}]))},engine:engine.call({op:'version'})};break;}
  case 'sync':{if(!scanner)throw Error('Not open');const s=await scanner.sync();if(Array.isArray(data.reserveKeyImages))engine.call({op:'nativeReserve',keyImages:data.reserveKeyImages});result={...engine.call({op:'status'}),scan:s,native:engine.call({op:'nativeStatus',exclude:data.reserveKeyImages||[]})};break;}
  case 'nativeStatus':result=engine.call({op:'nativeStatus',exclude:data.exclude||[]});break;
  case 'nativeRelease':result=engine.call({op:'nativeRelease',keyImages:data.keyImages||[]});break;
  // Carrier fee quote BEFORE any proof: input chosen and ring sampled in the engine; the daemon answers get_outs/distribution through this worker. Returns the exact fee for approval.
  case 'carrierQuote':{carrier.onProgress=p=>post(id,p);const q=await carrier.quote({kind:data.kind,excludeKeyImages:data.exclude||[]});result=q;break;}
  case 'carrierCancel':result=carrier.cancel(data.quoteId);break;
  // Sign the carrier for a finished record with the approved quote (fee must match), then publish it straight to the daemon.
  case 'carrierSign':result=carrier.sign(data.quoteId,data.wire);break;
  case 'carrierPublish':result=await carrier.publish(data.blob);break;
  case 'carrierInPool':result={inPool:await carrier.inPool(data.txid)};break;
  // Lookup BEFORE any retry: does the daemon hold this carrier (pool or chain)? {known:false} only on a positive "missing".
  case 'carrierLookup':result=await carrier.lookup(data.txid);break;
  // Publish with lost-reply recovery: a transport failure is UNCERTAIN -> the daemon is asked -> the SAME blob is re-sent only
  // if the daemon positively does not know it. Never a new carrier, never a second fee. The popup journals 'broadcasting'
  // before calling this, so a crash anywhere inside resumes by the same lookup-first procedure.
  case 'carrierPublishRecover':{carrier.onProgress=p=>post(id,p);result=await carrier.publishWithRecovery(data.blob,data.txid,{attempts:data.attempts||3,lookupRetries:data.lookupRetries||3,delayMs:data.delayMs??1500,onAttempt:async a=>post(id,{phase:'carrier',text:a.action==='send'?(a.attempt?`Re-sending the SAME signed carrier (attempt ${a.attempt+1}; the daemon did not know it)…`:'Sending the signed carrier to the node…'):'No reply from the node; asking it whether the carrier arrived before any retry…'})});break;}
  case 'status':result=engine.call({op:'status'});break;
  case 'parameters':result={label:params?.manifest.label,manifestSha256:params?.sha256,pinnedInBuild:params?.pinned,loaded:loader?.loaded??{},log:paramLog.slice(-20),engine:engine?.call({op:'version'}).parameters};break;
  case 'select':result=engine.call({op:'select',asset:data.asset,amount:data.amount,exclude:data.exclude||[]});break;
  case 'build':{const slot=data.kind==='redeem'?1:0;
   // Parameters are authenticated (and loaded into the engine) BEFORE any witness is touched; a rejected file stops here with nothing proved or published.
   const pk=await loader.loadProvingKey(slot).catch(e=>{throw Error((e.name==='ParameterRejected'?'Parameters refused: ':'Parameters unavailable: ')+e.message+' Nothing was proved or published.');});
   post(id,{phase:'prove',text:`Proving the ${data.kind==='redeem'?'redemption':'transfer'} locally (${data.notes.length} input${data.notes.length===1?'':'s'})… this takes a while in the browser.`});
   const started=Date.now();const built=engine.call({op:'build',kind:data.kind,to:data.to,amount:data.amount,binding:data.binding,notes:data.notes});result={...built,provingMs:Date.now()-started,provingKey:pk};break;}
  case 'verify':result=engine.call({op:'verify',wire:data.wire});break;
  case 'viewingKey':result=engine.call({op:'viewingKey'});break;// explicit user action only
  case 'close':if(engine)engine.call({op:'close'});result={closed:true};setTimeout(()=>self.close(),10);break;
  default:throw Error('Unknown action');
 }
 self.postMessage({id,result});
 }catch(e){self.postMessage({id,error:String(e?.message||e).slice(0,600)});}finally{if(data)data.seed='';}};
