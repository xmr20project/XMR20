// XMR20 private-token wallet library (EXPERIMENTAL, stage 4). A small documented interface over
// the shared holder engine (holder-wasm compiled to wasm), the chain scanner, the authenticated
// parameter loader and the carrier builder. It contains NO UI and NO bridge-operator logic.
//
// Secret boundary: the 32-byte root (or the token viewing key for view-only wallets) is handed to the
// wasm engine once; the token spend key, viewing key, decrypted notes, witnesses, Monero keys, owned
// outputs and rings live only in the engine's linear memory. This module never stores or logs them.
// Everything that leaves is public (addresses, balances, note commitments/amounts to the caller,
// finished records, signed carriers).
//
// SHARED COMPONENTS (not an independent implementation): engine wasm, holder-engine.js (host +
// scanner), holder-params.js (manifest authentication + cache), holder-carrier.js (daemon RPC for
// fee quotes/decoys/publication). See SPEC section 11.
//
// Interface (all amounts are decimal strings of atomic units; hex is lowercase):
//   const lib = await openPrivateWallet(opts) where opts = {
//     wasm: WebAssembly.Module | BufferSource,     // the holder engine
//     manifest: object,                            // the shipped XMR20-PARAMS-1 manifest (trust anchor)
//     manifestBytes?: Uint8Array, pinnedManifestSha256?: hex,   // optional hash check of the shipped manifest
//     daemonRpc: 'http://127.0.0.1:30041',         // Monero daemon JSON-RPC base URL
//     parameterServer: 'http://127.0.0.1:8940',    // serves /params/parameters.json and /params/<name>.public-pk
//     cache?: {get,put,delete}, fetch?: fn, random?: fn, onProgress?: fn,
//     root?: hex32 | viewingKey?: 'penumbrafullviewingkey1…' (exactly one)
//   }
//   lib.address()            -> 'penumbra1…'            lib.nativeAddress() -> Monero address for the manifest's network (spend wallets)
//   lib.viewingKey()         -> 'penumbrafullviewingkey1…' (spend wallets; explicit export)
//   lib.canSpend             -> boolean
//   await lib.sync()         -> {tip, tipHash, applied, received}   (replays the public chain; handles rollbacks)
//   lib.status()             -> {balances, notes[{commitment,amount,asset,position}], spent[], tip, records, pool}
//   lib.native()             -> {address, unlocked, locked, reserved, outputs[]} (spend wallets)
//   lib.select({asset, amount, exclude?}) -> {notes[commitments], total, change}
//   await lib.loadProvingKey(0|1)        -> authenticated parameter info (download or cache)
//   await lib.prove({kind:'send'|'redeem', to?, amount, binding?, notes}) -> {wire, recordId, bytes, inputs, change, provingMs}
//   lib.verify(wire)         -> local admission result ({record:'accepted'|'rejected', error?})
//   await lib.quoteCarrier({kind, excludeKeyImages?}) -> {quoteId, fee, weight, feePerWeight, keyImage, inputAmount, changeAmount, ringSize, recordBytes, illustrativeMainnetFee}
//   lib.signCarrier(quoteId, wire)       -> {txid, blob, fee, keyImage, nativeBytes, extraBytes}
//   lib.cancelQuote(quoteId)
//   await lib.publish(blob)  -> {ok, status, reason?, doubleSpend?}   (idempotent on monerod for the same blob)
//   await lib.inPool(txid)
//   await lib.lookup(txid)   -> {known, inPool, blockHeight, confirmations}   (ask the daemon BEFORE retrying an uncertain broadcast)
//   await lib.publishWithRecovery(blob, txid, {attempts?, onAttempt?}) -> {ok, status, recovered, resends, trail[]}
//                            (transport failure = UNCERTAIN: lookup first, re-send the SAME blob only if the daemon does not know it)
//   lib.reserveNative(keyImages[]) / lib.releaseNative(keyImages[])
//   lib.memoryBytes()
//   lib.close()
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {checkManifest,createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
export const PROTOCOL_VERSION='XMR20-PRIVATE-v0.1-experimental';
export async function openPrivateWallet(opts){
 const {wasm,manifest,manifestBytes=null,pinnedManifestSha256=null,daemonRpc,parameterServer,cache=null,fetch:f=globalThis.fetch,random,onProgress=()=>{},root=null,viewingKey=null}=opts;
 if(!manifest)throw Error('manifest required (the shipped XMR20-PARAMS-1 manifest is the trust anchor)');
 if((root?1:0)+(viewingKey?1:0)!==1)throw Error('exactly one of root or viewingKey');
 if(manifestBytes){await checkManifest(manifestBytes,{expectedSha256:pinnedManifestSha256});}
 const module=wasm instanceof WebAssembly.Module?wasm:await WebAssembly.compile(wasm);
 const engine=await createHolderEngine({wasm:module,...(random?{random}:{})});
 const opened=root?engine.call({op:'derive',root,account:0}):engine.call({op:'openViewing',viewingKey});
 const loader=createParameterLoader({manifest,engine,baseUrl:parameterServer,cache,fetch:f,onProgress});
 const served=await loader.loadServedConfig();
 engine.call({op:'params',manifest,served});
 const scanner=createChainScanner(engine,{rpc:daemonRpc,fetch:f,genesis:manifest.network.genesis,network:manifest.network.kind,startHeight:manifest.network.startHeight||0,onProgress});
 const carrier=root?createCarrierBuilder({engine,rpc:daemonRpc,fetch:f,onProgress,sanityChecks:manifest.network.kind!=='offline-fakechain'}):null;
 const needSpend=()=>{if(!carrier)throw Error('viewing-only wallet: no spending authority');};
 return {
  protocol:PROTOCOL_VERSION,canSpend:Boolean(root),manifestLabel:manifest.label,ledgerDomain:manifest.ledgerDomain,
  address(){return opened.tokenAddress;},
  nativeAddress(){needSpend();return engine.call({op:'nativeAddress'}).nativeAddress;},  // formatted for the manifest's network (stagenet prefix on stagenet)
  viewingKey(){needSpend();return engine.call({op:'viewingKey'}).viewingKey;},
  async sync(){return scanner.sync();},
  status(){return engine.call({op:'status'});},
  native(){needSpend();return engine.call({op:'nativeStatus'});},
  select({asset,amount,exclude=[]}){return engine.call({op:'select',asset,amount,exclude});},
  async loadProvingKey(slot){needSpend();return loader.loadProvingKey(slot);},
  async prove({kind,to,amount,binding,notes}){needSpend();await loader.loadProvingKey(kind==='redeem'?1:0);const t=Date.now();const built=engine.call({op:'build',kind,to,amount,binding,notes});return {...built,provingMs:Date.now()-t};},
  verify(wire){return engine.call({op:'verify',wire});},
  async quoteCarrier({kind,excludeKeyImages=[]}){needSpend();return carrier.quote({kind,excludeKeyImages});},
  signCarrier(quoteId,wire){needSpend();return carrier.sign(quoteId,wire);},
  cancelQuote(quoteId){needSpend();return carrier.cancel(quoteId);},
  async publish(blob){needSpend();return carrier.publish(blob);},
  async inPool(txid){needSpend();return carrier.inPool(txid);},
  async lookup(txid){needSpend();return carrier.lookup(txid);},
  async publishWithRecovery(blob,txid,opts){needSpend();return carrier.publishWithRecovery(blob,txid,opts);},
  reserveNative(keyImages){needSpend();return engine.call({op:'nativeReserve',keyImages});},
  releaseNative(keyImages){needSpend();return engine.call({op:'nativeRelease',keyImages});},
  engineVersion(){return engine.call({op:'version'});},
  memoryBytes(){return engine.memoryBytes();},
  close(){engine.call({op:'close'});},
 };
}
// In-memory parameter cache (tests, short-lived CLIs). Persistent callers supply their own {get,put,delete}.
export function memoryCache(){const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};}
