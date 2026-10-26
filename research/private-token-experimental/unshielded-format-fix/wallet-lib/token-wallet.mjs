// XMR20 token wallet library for the UNSHIELDED-BY-DEFAULT format (EXPERIMENTAL). A documented interface over the shared
// holder engine (holder-wasm compiled to wasm), the chain scanner, the authenticated parameter loader and the carrier
// builder. NO UI, NO bridge-operator logic. Shared components: wallet-extension/src/holder-engine.js (host + scanner),
// holder-params.js (XMR20-PARAMS-2 manifest authentication + cache), holder-carrier.js (daemon RPC for fee quotes/decoys/publication).
//
// Secret boundary: the 32-byte root (or a viewing key) is handed to the wasm engine once; the token spend key, the public
// OWNER key, the viewing key, decrypted notes, witnesses, Monero keys, owned outputs and rings live only in the engine's
// linear memory. Everything that leaves is public: addresses, balances, note ids/commitments and amounts (to the caller),
// finished records, signed carriers.
//
// Interface (amounts are decimal strings of atomic units; hex is lowercase):
//   const w = await openTokenWallet({wasm, manifest, daemonRpc, parameterServer, cache?, fetch?, onProgress?, root? | viewingKey? (+owner?)})
//   w.address()              unified token address "xmr20t1…" (spend wallets)   w.shieldedAddress()   "penumbra1…"   w.ownerKey()  hex32
//   w.nativeAddress()        Monero address for the manifest's network       w.viewingKey()
//   await w.sync()           replay the public chain (handles rollbacks)     w.status()  {public:{balances,notes}, shielded:{balances,notes,spent}, records, pool, tip}
//   w.selectPublic({asset,amount,exclude?})   up to 4 public note ids       w.select({asset,amount,exclude?,max?})  up to 3 shielded commitments
//   w.plan({kind,inputs?,change?})            {wireLengths[], transactions, extraBytes[]}  — exact record sizes BEFORE proving
//   await w.build({kind:'public'|'burn'|'shield'|'unshield'|'private', ...}) -> record(s): {wire|wires, recordId|recordIds, bytes, inputs, amount, change, reserved, transactions}
//   w.verify(wire) / w.verify({wires:[a,b]})  local admission
//   await w.quoteCarrier({kind, wireLen, excludeKeyImages?}) · w.signCarrier(quoteId, wire) · w.cancelQuote(quoteId)
//   await w.publish(blob) · w.lookup(txid) · w.publishWithRecovery(blob, txid, opts) · w.inPool(txid)
//   w.reserveNative(kis) / w.releaseNative(kis) · w.native() · w.close()
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {checkManifest,createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
export const PROTOCOL_VERSION='XMR20-UNSHIELDED-v0.2-experimental';
// Proving-key slots a build kind needs: 0 = Penumbra spend key, 1 = Penumbra output key.
export const SLOTS_FOR={public:[],burn:[],shield:[1],unshield:[0,1],private:[0,1]};
export async function openTokenWallet(opts){
 const {wasm,manifest:manifestArg=null,manifestBytes=null,pinnedManifestSha256=null,daemonRpc,parameterServer,cache=null,fetch:f=globalThis.fetch,random,onProgress=()=>{},root=null,viewingKey=null,owner=null}=opts;
 if((root?1:0)+(viewingKey?1:0)!==1)throw Error('exactly one of root or viewingKey');
 // FIX (review M1): the operational manifest is derived ONLY from the authenticated bytes. A separately supplied object must be
 // identical (canonical JSON) or the call is refused; a pin without bytes cannot be enforced and is refused; the configuration the
 // wallet runs on is an owned, deep-frozen snapshot, so later caller mutation has no effect.
 if(pinnedManifestSha256&&!manifestBytes)throw Error('pinnedManifestSha256 requires manifestBytes: a pin without the bytes it pins cannot be enforced');
 let manifest,manifestSha256=null;
 if(manifestBytes){const checked=await checkManifest(manifestBytes,{expectedSha256:pinnedManifestSha256});manifest=checked.manifest;manifestSha256=checked.sha256;
  if(manifestArg!==null&&canonicalJSON(manifestArg)!==canonicalJSON(manifest))throw Error('manifest object differs from the authenticated manifestBytes (label '+String(manifestArg?.label)+' vs '+manifest.label+'); refusing to operate on an unauthenticated configuration');}
 else{if(!manifestArg)throw Error('manifest required (the shipped XMR20-PARAMS-2 manifest is the trust anchor)');manifest=JSON.parse(JSON.stringify(manifestArg));}
 deepFreeze(manifest);const manifestAuthenticated=Boolean(manifestBytes&&pinnedManifestSha256);
 const module=wasm instanceof WebAssembly.Module?wasm:await WebAssembly.compile(wasm);
 const engine=await createHolderEngine({wasm:module,...(random?{random}:{})});
 const opened=root?engine.call({op:'derive',root,account:0}):engine.call({op:'openViewing',viewingKey,...(owner?{owner}:{})});
 const loader=createParameterLoader({manifest,engine,baseUrl:parameterServer,cache,fetch:f,onProgress});
 const served=await loader.loadServedConfig();
 engine.call({op:'params',manifest,served});
 const scanner=createChainScanner(engine,{rpc:daemonRpc,fetch:f,genesis:manifest.network.genesis,network:manifest.network.kind,startHeight:manifest.network.startHeight||0,onProgress});
 const carrier=root?createCarrierBuilder({engine,rpc:daemonRpc,fetch:f,onProgress,sanityChecks:manifest.network.kind!=='offline-fakechain'}):null;
 const needSpend=()=>{if(!carrier)throw Error('viewing-only wallet: no spending authority');};
 return {
  protocol:PROTOCOL_VERSION,canSpend:Boolean(root),manifestLabel:manifest.label,ledgerDomain:manifest.ledgerDomain,manifest,manifestSha256,manifestAuthenticated,startHeight:manifest.network.startHeight||0,
  address(){return opened.tokenAddress;},
  shieldedAddress(){return opened.shieldedAddress||engine.call({op:'status'}).shieldedAddress;},
  ownerKey(){return opened.ownerKey||null;},
  nativeAddress(){needSpend();return engine.call({op:'nativeAddress'}).nativeAddress;},
  viewingKey(){needSpend();return engine.call({op:'viewingKey'}).viewingKey;},
  async sync(){return scanner.sync();},
  status(){return engine.call({op:'status'});},
  native(){needSpend();return engine.call({op:'nativeStatus'});},
  selectPublic({asset,amount,exclude=[]}){return engine.call({op:'selectPublic',asset,amount,exclude});},
  select({asset,amount,exclude=[],max=3}){return engine.call({op:'select',asset,amount,exclude,max});},
  plan(req){return engine.call({op:'plan',...req});},
  async loadProvingKey(slot){needSpend();return loader.loadProvingKey(slot);},
  // Parameters are authenticated (and loaded) BEFORE any witness is touched; a rejected file stops here with nothing proved.
  async build(req){needSpend();for(const slot of SLOTS_FOR[req.kind]||[])await loader.loadProvingKey(slot);const t=Date.now();const built=engine.call({op:'build',...req});return {...built,provingMs:Date.now()-t};},
  verify(w){return typeof w==='string'?engine.call({op:'verify',wire:w}):engine.call({op:'verify',wires:w.wires});},
  async quoteCarrier({kind,wireLen,excludeKeyImages=[]}){needSpend();return carrier.quote({kind,wireLen,excludeKeyImages});},
  signCarrier(quoteId,wire){needSpend();return carrier.sign(quoteId,wire);},
  cancelQuote(quoteId){needSpend();return carrier.cancel(quoteId);},
  async publish(blob){needSpend();return carrier.publish(blob);},
  async inPool(txid){needSpend();return carrier.inPool(txid);},
  async lookup(txid){needSpend();return carrier.lookup(txid);},
  async publishWithRecovery(blob,txid,o){needSpend();return carrier.publishWithRecovery(blob,txid,o);},
  reserveNative(keyImages){needSpend();return engine.call({op:'nativeReserve',keyImages});},
  releaseNative(keyImages){needSpend();return engine.call({op:'nativeRelease',keyImages});},
  engineVersion(){return engine.call({op:'version'});},
  memoryBytes(){return engine.memoryBytes();},
  close(){engine.call({op:'close'});},
 };
}
export function canonicalJSON(v){return JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(key=>[key,x[key]])):x);}
function deepFreeze(o){if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);for(const v of Object.values(o))deepFreeze(v);}return o;}
export function memoryCache(){const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};}
