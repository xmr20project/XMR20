// UNSHIELDED-FORMAT TEST backend for the isolated extension build. SYNTHETIC ONLY. Deposits and migration claims are
// credited as PUBLIC notes (XC1) to the holder's owner key; payouts follow PUBLIC burns (XR1). Shielding is the holder's
// explicit action in the wallet; this service never sees shielded balances unless a viewing key is shared explicitly.
// Boots the integration lab's real processes (offline fakechain monerod, Rust
// issuer/indexer roles, compiled Solana custody in LiteSVM, the lab Operator
// with its journal and exposure policy) and exposes bridge/operator actions to
// the extension over 127.0.0.1 JSON with a chrome-extension:// origin allow-list.
//
// Boundary statement (what this service does NOT hold any more):
// - No holder wallet. Private note keys, viewing keys, note selection, proofs
//   and spend authorization live in the extension's holder worker (wasm built
//   from holder-wasm/). This service never receives a seed, spend key or
//   viewing key except through the explicit `view` action, which the user
//   triggers to share a viewing key with the indexer.
// - The extension scans the public chain itself from the daemon's RPC; this
//   service does not compute or cache holder balances.
// What it still does (labelled test/operator roles):
// - NO RELAY (stage 2, research/privacy-carrier-20261023): the holder's own
//   extension builds, signs, pays for and publishes the native carrier
//   transaction directly to the test daemon. This service never sees a
//   carrier, a key image or a record before it is on chain. The lab relay
//   wallet process is gone from this backend.
// - `fund`: TEST SERVICE: mines test XMR (coinbase) to the holder's registered
//   public Monero address so the holder can pay carrier fees. Labelled.
// - Operator: Solana deposits (signed in the popup), credits, redemption
//   bindings, exactly-once payouts, synthetic legacy snapshot and claims.
// - `mine`: advances the offline test chain. Test service only.
// Parameters (this candidate): the backend no longer generates a Groth16 setup
// per run. It serves the FIXED, labelled test parameter set params/<set>/
// (default test-v1) as plain files. The holder authenticates every file against
// the manifest shipped in its build; nothing this server says about the files
// is a trust anchor. `faults` (tests only) lets a test serve missing, truncated,
// interrupted, corrupted, foreign or swapped files to prove the holder rejects
// them before use.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,appendFile,readFile,stat,copyFile,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Transaction,PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {execute,signed} from '../../../proof-of-concepts/joint-escrow-wallet/core-next/test-fixture.mjs';
import {bridgeInstruction,decodeBridgeReceipt} from '../../../proof-of-concepts/joint-escrow-wallet/core-monero-send/bridge-sdk.mjs';
import {service} from '../../privacy-integration-20261022/rpc.mjs';
import {createBridge,net as netOf,tax} from './solana.mjs';   // this candidate: per-token mint identity (any XMR20-launched token)
import {Registry,PROFILE,legacyMessageHash} from './migration-registry.mjs';
import {Operator,bindingFor,CONFIRMATIONS as DEFAULT_CONFIRMATIONS,EXPOSURE} from './operator.mjs';
import {parseTokenAddress} from './address.mjs';
import {ORDER} from '../../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../../website/services/native-market/xn1/bytes.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url)),lab=path.resolve(dir,'../../privacy-integration-20261022'),root=path.resolve(dir,'../../..');
// Roles binary of THIS candidate (format/): indexer + issuer for the unshielded format; every role requires --trusted-manifest.
const bin=path.resolve(dir,'../target/release/xmr20-unshielded-lab');
const G=ed25519.ExtendedPoint.BASE,point=hex=>ed25519.ExtendedPoint.fromHex(hex,false),Hs=b=>le(keccak_256(b))%ORDER;
const varint=n=>{const out=[];let x=BigInt(n);while(x>=0x80n){out.push(Number(x&0x7fn)|0x80);x>>=7n;}out.push(Number(x));return Buffer.from(out);};
const randomScalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
const hex32=b=>Buffer.from(b).toString('hex');
export const EXTENSION_ORIGIN='chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla';
// Public half of Monero's one-time output derivation: P = Hs(8 r A || i) G + B.
export function legacyOutputFor({A,B},r,index){const D=point(A).multiply(8n).multiply(r).toRawBytes();const h=Hs(Buffer.concat([Buffer.from(D),varint(index)]));return {P:hex32(G.multiply(h).add(point(B)).toRawBytes()),R:hex32(G.multiply(r).toRawBytes()),index};}
// Two registered holders x 492,500,000 = 985,000,000 = the net legacy position migrated to reserve (1,000,000,000 gross, one fee). Register both test accounts before the first X operation.
const LEGACY_LOT='492500000';
// THIRD-PARTY LEGACY TOKENS (this candidate): tokens already held on Monero in the legacy XMR20 format by holders who never
// bridged through the private path. Acceptance case: 10,000 EXTREMIST legacy -> exactly 10,000 private EXTREMIST, same Solana
// mint and decimals, backing preserved, no deposit and no bridge tax for the migration itself (the credit carrier's XMR fee is
// paid by the lab issuer and disclosed). In this SYNTHETIC service the EXTREMIST mint is a stand-in (the fixture's second
// observed mint); the real mint/decimals come from migration/third-party-assets.json at cutover and are reported, not used.
// CATALOG-DRIVEN (this candidate): migration/third-party-assets.json lists EVERY token launched through XMR20 (symbol, real
// Solana mint, decimals). Each becomes an asset with its own custody state and its own cutover snapshot; the asset id is
// derived from the mint exactly as for the main token, so nothing is special-cased per symbol. New launches are appended to
// the catalog (or registered at runtime with the `addAsset` test action) and migrate through the same path.
// Acceptance lot per holder: 10,000 units at the token's decimals; the synthetic legacy gross is the smallest value whose net
// after the ONE historical 1.5% fee (tax = ceil(gross*150/10000)) equals two lots exactly (checked by the migration test).
import {readFileSync as readSync} from 'node:fs';
export const CATALOG=JSON.parse(readSync(new URL('../migration/third-party-assets.json',import.meta.url),'utf8'));
export const acceptanceLot=decimals=>(10000n*10n**BigInt(decimals)).toString();
export function legacyGrossFor(netTarget,bps=150){const t=n=>(BigInt(n)*BigInt(bps)+9999n)/10000n;let g=(BigInt(netTarget)*10000n)/BigInt(10000-bps);while(g-t(g)<BigInt(netTarget))g++;while(g-t(g)>BigInt(netTarget))g--;assert.equal(g-t(g),BigInt(netTarget));return g;}
export const catalogAsset=c=>({symbol:c.key||c.symbol,ticker:c.symbol,name:c.name+(c.mintAccount?' (private test; synthetic custody with the REAL mint account bytes)':' (private test; synthetic custody at the real mint address)'),mintData:c.mintAccount?.base64||null,catalog:{inscriptionVersion:c.inscriptionVersion??null,transferTaxBps:c.transferTaxBps??null,onChainTransferFeeBps:c.mintAccount?.onChainTransferFeeBps??null,hasSolanaBridge:c.hasSolanaBridge??null,bridgeVersion:c.bridgeVersion??null,solanaNetworkLabel:c.solanaNetworkLabel??null},layout:'synthetic',mintAddress:c.mint,decimals:c.decimals,legacyLot:acceptanceLot(c.decimals),legacyGross:legacyGrossFor(2n*BigInt(acceptanceLot(c.decimals)),c.mintAccount?(c.mintAccount.onChainTransferFeeBps||0):150)});
export const THIRD_PARTY_ASSETS=CATALOG.assets.filter(c=>(CATALOG.testInstances||[]).includes(c.key||c.symbol)).map(catalogAsset);
export const PARAMS_ROOT=path.resolve(dir,'../params');
// roleFaults (tests only): tamper the ROLES' local parameter copy / trusted manifest before the issuer and indexer start:
//   {file:'normal'|'boundary'|'parameters', kind:'missing'|'truncate'|'corrupt-query'|'foreign'|'swap'} and/or {manifest:'foreign'|'tamper-genesis'|'tamper-hash'|'missing'|'pin-mismatch'}.
// observers (this candidate): RPC URLs of INDEPENDENT Monero nodes that must agree before a payout is admitted. The gate is a
// control against one lying, eclipsed or stale node; it does NOT remove the rollback-loss counterexample (two honest nodes
// follow the same reorganisation). requireObservers=true refuses payouts when no observer is configured.
// confirmations: payout/credit depth used by this service instance (default = the lab's 10). A PROVISIONAL risk policy, not finality:
// settlement/payout-depth-policy.test.mjs exercises 20 with rollbacks below, at and beyond the threshold.
export async function startBackend({rpcPort=30041,p2pPort=30040,httpPort=8940,log=()=>{},origins=[EXTENSION_ORIGIN],paramsSet='test-v2',faults={},roleFaults=null,observers=[],requireObservers=false,confirmations=DEFAULT_CONFIRMATIONS}={}){
 const CONFIRMATIONS=Number(confirmations);assert.ok(Number.isInteger(CONFIRMATIONS)&&CONFIRMATIONS>=1&&CONFIRMATIONS<=200,'confirmations');
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const run=await mkdtemp((await mkdir(dir+'../runs',{recursive:true}),dir+'../runs/backend-'));await mkdir(run+'/chain');await writeFile(run+'/chain/config','');
 const audit=async(line)=>appendFile(run+'/requests.log',JSON.stringify({at:new Date().toISOString(),...line})+'\n');
 const rpc=async(method,params={})=>{const r=await fetch(`http://127.0.0.1:${rpcPort}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'b',method,params}),signal:AbortSignal.timeout(20000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 const daemon=spawn(root+'/operations/native-market-20261016/local-chain/bin/monerod',['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',run+'/chain/data','--config-file',run+'/chain/config','--log-file',run+'/chain/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2',...(origins.length?['--rpc-access-control-origins',origins.join(',')]:[])],{stdio:'ignore'});
 let ready=false;for(let i=0;i<150;i++){try{const info=await rpc('get_info');assert.equal(info.nettype,'fakechain');assert.equal(info.offline,true);ready=true;break;}catch{await sleep(200);}}assert(ready,'daemon');
 // Any failure after this point must not leave the fakechain running (an orphaned child keeps a test runner alive forever).
 try{return await (async()=>{
 const env={XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(rpcPort)};
 // Fixed parameter set: small files copied, proving keys linked read-only into the run folder for the lab roles.
 const paramsDir=path.join(PARAMS_ROOT,paramsSet);await mkdir(run+'/parameters');
 for(const f of ['parameters.json','issuer.secret.json','manifest.json'])await copyFile(path.join(paramsDir,f),run+'/parameters/'+f);
 for(const f of ['spend_pk.bin','output_pk.bin'])await symlink(path.join(paramsDir,f),run+'/parameters/'+f);
 const config=JSON.parse(await readFile(run+'/parameters/parameters.json','utf8'));const manifest=JSON.parse(await readFile(run+'/parameters/manifest.json','utf8'));
 // The roles' trusted manifest lives OUTSIDE the parameter directory (anchored independently of what they load).
 await mkdir(run+'/trusted');await copyFile(path.join(paramsDir,'manifest.json'),run+'/trusted/manifest.json');const roleEnv={};
 if(roleFaults){const {rm,writeFile:wf}=await import('node:fs/promises');const pd=run+'/parameters';
  if(roleFaults.file){const name=roleFaults.file==='parameters'?'parameters.json':roleFaults.file+'_pk.bin';const target=pd+'/'+name;await rm(target,{force:true});const k=roleFaults.kind;
   if(k==='missing'){}
   else if(k==='foreign')await copyFile(path.join(PARAMS_ROOT,'test-other',name),target);
   else if(k==='swap')await copyFile(path.join(paramsDir,roleFaults.file==='spend'?'output_pk.bin':'spend_pk.bin'),target);
   else{const b=await readFile(path.join(paramsDir,name));if(k==='truncate')await wf(target,b.subarray(0,Math.floor(b.length*0.9)));else if(k==='corrupt-query'){b[Math.floor(b.length/2)]^=1;await wf(target,b);}else throw Error('unknown role fault '+k);}}
  if(roleFaults.manifest){const t=run+'/trusted/manifest.json';
   if(roleFaults.manifest==='missing')await rm(t,{force:true});
   else if(roleFaults.manifest==='foreign')await copyFile(path.join(PARAMS_ROOT,'test-other','manifest.json'),t);
   else if(roleFaults.manifest==='tamper-genesis'){const m=JSON.parse(await readFile(t,'utf8'));m.network.genesis='00'.repeat(32);await wf(t,JSON.stringify(m));}
   else if(roleFaults.manifest==='tamper-hash'){const m=JSON.parse(await readFile(t,'utf8'));m.files.spend.sha256='11'.repeat(32);await wf(t,JSON.stringify(m));}
   else if(roleFaults.manifest==='pin-mismatch'){roleEnv.XMR20_TRUSTED_MANIFEST_SHA256='22'.repeat(32);}
   else throw Error('unknown manifest fault');}}
 assert.equal((await rpc('get_block',{height:0})).block_header.hash,config.chain,'daemon genesis must match the fixed parameter set');
 const pkInfo={};for(const name of ['spend','output']){const file=paramsDir+'/'+name+'_pk.bin';pkInfo[name]={bytes:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')};}
 const roleArgs=p=>[p,run+'/parameters','--trusted-manifest',run+'/trusted/manifest.json'];const renv={...env,...roleEnv};
 let issuer,indexer;try{issuer=await service(bin,roleArgs('issuer'),{env:renv});indexer=await service(bin,roleArgs('indexer'),{env:renv});}
 catch(e){daemon.kill();await issuer?.close().catch(()=>{});throw Error('ROLE REFUSED TO START: '+e.message);}
 const issuerNative=issuer.ready.issuerNativeAddress;const roleManifests={issuer:issuer.ready.trustedManifest,indexer:indexer.ready.trustedManifest};
 const mineTo=async(address,n)=>{for(let left=n;left>0;left-=50)await rpc('generateblocks',{wallet_address:address,amount_of_blocks:Math.min(50,left)});};
 await mineTo(issuerNative,250);
 // Gamma decoy sampling on a short fakechain occasionally finds no usable ring members ("hit decoy selection round limit"); the failing calls build nothing durable, so they are simply retried.
 const withDecoyRetry=async(fn)=>{for(let i=0;;i++){try{return await fn();}catch(e){if(i>=5||!/decoy selection/.test(e.message))throw e;await sleep(100);}}};
 // Two assets: X = real XMR20 mint layout with a synthetic legacy position; S = new synthetic token, PUBLIC by default, no legacy.
 const assets={};
 const TABLE=[{symbol:'X',layout:'xmr20',legacyGross:1_000_000_000n,legacyLot:LEGACY_LOT,name:'XMR20 (private test)'},{symbol:'S',layout:'synthetic',legacyGross:0n,legacyLot:null,name:'XCAT private (test)'},...THIRD_PARTY_ASSETS];
 const mintDecimals=bridge=>{try{const m=bridge.vm.getAccount(bridge.addresses.mint.toBase58());return Buffer.from(m.data)[44];}catch{return null;}};
 const addAssetRow=async(row)=>{const {symbol,layout,legacyGross}=row;assert.ok(!assets[symbol],'asset exists');
  const bridge=createBridge({legacyGross,layout,mintAddress:row.mintAddress||null,decimals:row.decimals??null,mintData:row.mintData||null});const asset=(await indexer.call({op:'asset',mint:bridge.mint})).asset;
  assert.ok(!Object.values(assets).some(a=>a.asset===asset),'asset id collision (same mint)');
  // The synthetic legacy position backs exactly maxLots lots: the cutover snapshot can never list more rights than the legacy supply.
  const maxLots=row.legacyLot?Number(bridge.net(legacyGross)/BigInt(row.legacyLot)):0;
  assets[symbol]={symbol,ticker:row.ticker||symbol,catalog:row.catalog||null,layout,bridge,asset,legacyRows:[],registry:null,operator:null,name:row.name,legacyLot:row.legacyLot,maxLots,decimals:mintDecimals(bridge),addedAt:(await rpc('get_info')).height-1};return assets[symbol];};
 for(const row of TABLE)await addAssetRow(row);
 // One cutover snapshot per asset: rights fixed by the rows registered BEFORE the asset's registry is built (first operation).
 const snapshotOf=(a)=>({profile:PROFILE,kind:'synthetic-extension-test-snapshot',asset:a.symbol,checkpoint:{height:'registration'},rows:a.legacyRows.map(r=>({claim:r.claim,amount:r.amount,legacyOwner:r.P}))});
 const operatorFor=async(symbol)=>{const a=assets[symbol];if(a.operator)return a.operator;const registry=a.legacyLot?(a.registry??=new Registry(snapshotOf(a))):new Registry({rows:[]});
  a.operator=await Operator.open({file:run+'/operator-'+symbol+'.json',bridge:a.bridge,node:issuer,registry,asset:a.asset,confirmations:CONFIRMATIONS});if(a.legacyLot){const m=a.bridge.migrateLegacy();assert.ok(m.ok,'legacy migration to reserve');a.cutover={migratedToReserveAtTip:(await rpc('get_info')).height-1,legacyPositionAfter:a.bridge.state().legacyPosition};}return a.operator;};
 await operatorFor('S');
 // Holder records are keyed by TOKEN ADDRESS (the public identity the extension derives). An extension install id is only an alias, so a fresh install that derives the same address finds the same bridge-side facts (Solana account, legacy lots). Nothing private is kept here.
 const holders=new Map(),aliases=new Map();
 const fundExternal=(bridge,owner,amount)=>{const pk=new PublicKey(owner);bridge.vm.airdrop(owner,10_000_000_000n);const ata=getAssociatedTokenAddressSync(bridge.addresses.mint,pk,false,TOKEN);
  const r=execute(bridge.vm,signed(bridge.vm,[createAssociatedTokenAccountIdempotentInstruction(bridge.operator.publicKey,ata,pk,bridge.addresses.mint,TOKEN)],bridge.operator));assert.ok(r.ok,'ata');
  if(amount>0n){const acc=bridge.vm.getAccount(ata.toBase58()),data=Buffer.from(acc.data);data.writeBigUInt64LE(amount,64);bridge.vm.setAccount({...acc,address:ata.toBase58(),programAddress:TOKEN.toBase58(),data});}return ata;};
 const pendingDeposits=new Map();
 const holder=id=>{const h=holders.get(aliases.get(id));assert.ok(h,'Account not registered with the test backend');return h;};
 const mine=async(n=CONFIRMATIONS)=>mineTo(issuerNative,n);
 async function state(id){const s=await indexer.call({op:'scan'});const registered=aliases.has(id);const h=registered?holder(id):null;
  const out={tip:s.public.tip,confirmations:CONFIRMATIONS,exposure:EXPOSURE,rpcUrl:`http://127.0.0.1:${rpcPort}`,registered,tokenAddress:h?.tokenAddress??null,ownerKey:h?.ownerKey??null,relay:null,carrierFunding:'holder',format:'XMR20-UNSHIELDED-v0.2-experimental',defaultMode:'public',pool:s.public.state,assets:[]};
  for(const a of Object.values(assets)){const op=a.operator;if(op)await op.reconcile(s);
   const row={symbol:a.symbol,ticker:a.ticker||a.symbol,catalog:a.catalog||null,name:a.name,asset:a.asset,mint:a.bridge.mint,decimals:a.decimals,feeBps:a.bridge.feeBps,layout:a.layout,liabilities:op?op.liabilities(s):null,payouts:[],cutover:a.cutover||null,operator:op?{halted:op.state.halted,paused:op.state.paused,confirmations:op.confirmations,incidents:op.state.incidents}:null};
   if(h){row.payouts=op?Object.entries(op.state.payouts).filter(([,p])=>op.state.requests[p.binding]?.destination===h.sol).map(([txid,p])=>({txid,amount:p.amount,status:p.status,confirmations:p.confirmations})):[];row.solanaBalance=h.ata[a.symbol]?a.bridge.tokenBalance(h.ata[a.symbol]):'0';row.viewingKeyShared=h.viewingShared.has(a.symbol);
    if(a.legacyLot){row.legacy=a.legacyRows.filter(r=>r.tokenAddress===h.tokenAddress).map(r=>({claim:r.claim,amount:r.amount,P:r.P,txPublicKey:r.R,outputIndex:r.index,claimed:Boolean(a.operator?.state.credits[r.claim])}));}}
   out.assets.push(row);}
  return out;}
 const actions={
  async register({id,sol,xmr,A,B,tokenAddress}){assert.match(id,/^[A-Za-z0-9_-]{1,64}$/);assert.match(A,/^[0-9a-f]{64}$/);assert.match(B,/^[0-9a-f]{64}$/);assert.ok(typeof sol==='string'&&sol.length>=32&&sol.length<=44);assert.ok(typeof tokenAddress==='string'&&tokenAddress.startsWith('xmr20t1')&&tokenAddress.length<300,'Unified token address (xmr20t1…) required');const ownerKey=parseTokenAddress(tokenAddress).ownerKey;
   if(holders.has(tokenAddress)){const h=holders.get(tokenAddress);assert.equal(h.sol,sol,'This private address is registered with another Solana account');aliases.set(id,tokenAddress);await audit({action:'register',id,tokenAddress,existing:true});return {registered:true,tokenAddress,existing:true,note:'Known holder (same private address): bridge-side facts reattached; no private state exists on this service.'};}
   const ata={};for(const a of Object.values(assets))ata[a.symbol]=fundExternal(a.bridge,sol,1_000_000_000n);
   const index=holders.size;let late=false;
   // Synthetic legacy lots for every legacy-bearing asset (X and the third-party tokens): one one-time output key per holder and
   // asset, fixed at registration. A holder registering AFTER an asset's cutover snapshot gets no lot for it (late registration).
   for(const a of Object.values(assets)){if(!a.legacyLot)continue;if(a.registry){late=true;continue;}if(a.legacyRows.length>=a.maxLots)continue;const r=randomScalar();const lot=legacyOutputFor({A,B},r,index);a.legacyRows.push({tokenAddress,claim:createHash('sha256').update('synthetic legacy lot '+a.symbol+' '+tokenAddress).digest('hex'),amount:a.legacyLot,...lot});}
   holders.set(tokenAddress,{tokenAddress,ownerKey,sol,xmr,A,B,ata,viewingShared:new Set(),ids:new Set([id])});aliases.set(id,tokenAddress);await audit({action:'register',id,tokenAddress});
   return {registered:true,tokenAddress,ownerKey,legacyLots:Object.fromEntries(Object.values(assets).filter(a=>a.legacyLot).map(a=>[a.symbol,a.legacyRows.some(r=>r.tokenAddress===tokenAddress)?a.legacyLot:'0'])),lateRegistration:late,note:'Holder registered by public token address. This service holds no holder keys.'};},
  async state({id}){return state(id);},
  // FUTURE TOKEN (test service): a token launched later is registered from its catalog row at runtime; holders already known
  // get their synthetic legacy lot for it (its cutover snapshot is taken when its first operation builds the registry).
  async addAsset({symbol}){const c=CATALOG.assets.find(a=>(a.key||a.symbol)===symbol);assert.ok(c,'Unknown catalog token');const a=await addAssetRow(catalogAsset(c));
   for(const h of holders.values()){h.ata[a.symbol]=fundExternal(a.bridge,h.sol,1_000_000_000n);/* same synthetic external holding every holder gets at registration */if(a.legacyRows.length>=a.maxLots)continue;const r=randomScalar();const lot=legacyOutputFor({A:h.A,B:h.B},r,a.legacyRows.length);a.legacyRows.push({tokenAddress:h.tokenAddress,claim:createHash('sha256').update('synthetic legacy lot '+a.symbol+' '+h.tokenAddress).digest('hex'),amount:a.legacyLot,...lot});}
   await audit({action:'addAsset',symbol,asset:a.asset,mint:a.bridge.mint});return {symbol,asset:a.asset,mint:a.bridge.mint,decimals:a.decimals,legacyLot:a.legacyLot,holdersWithLots:a.legacyRows.length};},
  async depositPrepare({id,symbol,amount}){const h=holder(id),a=assets[symbol];assert.ok(a,'asset');const gross=BigInt(amount);assert.ok(gross>0n);assert.ok(a.bridge.net(gross)>0n,'Bridge fee consumes the amount');await operatorFor(symbol);
   const nonce=randomBytes(32).toString('hex');const c={...a.bridge.config,owner:h.sol};const ix=bridgeInstruction(c,a.bridge.options,{kind:'deposit',amount:String(gross),fee:a.bridge.tax(gross).toString(),nonce,binding:createHash('sha256').update('deposit binding '+nonce).digest('hex')});
   const tx=new Transaction({recentBlockhash:a.bridge.vm.latestBlockhash(),feePayer:new PublicKey(h.sol)}).add(ix.instruction);
   pendingDeposits.set(nonce,{tokenAddress:h.tokenAddress,symbol,receipt:ix.receipt,gross});
   return {nonce,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),review:{gross:String(gross),fee:a.bridge.tax(gross).toString(),feeBps:a.bridge.feeBps,net:a.bridge.net(gross).toString(),mint:a.bridge.mint,program:ix.instruction.programId.toBase58(),owner:h.sol,creditTo:h.tokenAddress}};},
  async depositSubmit({id,nonce,transaction}){const p=pendingDeposits.get(nonce);const h=holder(id);assert.ok(p&&p.tokenAddress===h.tokenAddress,'Unknown deposit');pendingDeposits.delete(nonce);const a=assets[p.symbol];
   const tx=Transaction.from(Buffer.from(transaction,'base64'));assert.ok(tx.signatures.some(s=>s.publicKey.toBase58()===h.sol&&s.signature),'Transaction not signed by the account');
   const x=execute(a.bridge.vm,tx);assert.ok(x.ok,'Solana deposit rejected: '+x.logs.join(' | '));const receipt=decodeBridgeReceipt(a.bridge.vm.getAccount(p.receipt.toBase58()).data);a.bridge.receipts.push(receipt);
   const op=await operatorFor(p.symbol);const c=await withDecoyRetry(()=>op.creditDeposit(receipt,h.ownerKey));await audit({action:'deposit',id,symbol:p.symbol,gross:String(p.gross),credit:c.txid});
   return {receipt:{nonce:receipt.nonce,net:String(receipt.net)},credit:{txid:c.txid,status:c.status,binding:receipt.nonce,kind:'public'},note:'PUBLIC credit published on the test chain to your owner key; your wallet sees it after '+CONFIRMATIONS+' confirmations. Shield it explicitly if you want a shielded balance.'};},
  // TEST SERVICE: mine `blocks` coinbase rewards to this holder's public Monero address (carrier-fee funding for the test). Coinbase matures after 60 blocks.
  async fund({id,blocks}){const h=holder(id);const n=Math.min(10,Math.max(1,Number(blocks)||1));assert.match(h.xmr,/^4[1-9A-HJ-NP-Za-km-z]{94}$/,'Registered Monero address required');await mineTo(h.xmr,n);await audit({action:'fund',id,blocks:n});return {funded:n,address:h.xmr,maturesAfter:60,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: '+n+' coinbase output(s) mined to this account. Mainnet XMR is bought or received, never mined by a service.'};},
  // amount (optional, atomic units): refused HERE, before anything is proved or burned, when a single payout would exceed the lab
  // exposure limit — otherwise the holder could burn tokens the operator then refuses to pay (found by the catalog popup suite).
  async redeemPrepare({id,symbol,amount=null}){const h=holder(id),a=assets[symbol];assert.ok(a,'asset');const op=await operatorFor(symbol);if(amount!==null){assert.ok(/^\d+$/.test(String(amount)),'amount');assert.ok(BigInt(amount)<=BigInt(op.exposure.maxSinglePayout),`Exposure: single payout above lab limit (max ${op.exposure.maxSinglePayout} atomic units per payout); nothing was proved or burned`);}const request=randomBytes(32).toString('hex'),destination=h.sol,binding=bindingFor(destination,request);op.registerRedemption(binding,destination,request);await op.persist();await audit({action:'redeemPrepare',id,symbol,binding,amount});return {binding,destination,request,confirmations:CONFIRMATIONS,maxSinglePayout:op.exposure.maxSinglePayout};},
  // Independent observation GATE: every configured observer must report the burn mined at the same height with the same block
  // hash as the primary node and with at least CONFIRMATIONS confirmations. Any disagreement, missing answer or missing
  // observer (when required) WITHHOLDS the payout (status stays pending; nothing is paid). The outcome is returned and audited.
  async observe({txid}){const primary=await (await fetch(`http://127.0.0.1:${rpcPort}/get_transactions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:false,prune:true})})).json();const pt=(primary.txs||[])[0];
   const view=async(url)=>{try{const r=await (await fetch(url+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[txid],decode_as_json:false,prune:true}),signal:AbortSignal.timeout(20000)})).json();const t=(r.txs||[])[0];if(!t)return {url,known:false};
     const hdr=t.in_pool?null:await (await fetch(url+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'o',method:'get_block_header_by_height',params:{height:t.block_height}})})).json();return {url,known:true,inPool:Boolean(t.in_pool),height:t.in_pool?null:t.block_height,confirmations:t.in_pool?0:Number(t.confirmations||0),blockHash:hdr?.result?.block_header?.hash||null};}catch(e){return {url,error:String(e.message).slice(0,120)};}};
   const mine=await view(`http://127.0.0.1:${rpcPort}`);const others=await Promise.all(observers.map(view));
   const agree=o=>o.known&&!o.inPool&&o.height===mine.height&&o.blockHash===mine.blockHash&&o.confirmations>=CONFIRMATIONS;
   const ok=Boolean(pt)&&mine.known&&!mine.inPool&&mine.confirmations>=CONFIRMATIONS&&(!requireObservers||observers.length>0)&&others.every(agree);
   return {ok,txid,primary:mine,observers:others,reason:ok?null:!pt?'primary node does not know the burn':requireObservers&&!observers.length?'no independent observer configured':others.filter(o=>!agree(o)).map(o=>o.url+': '+(o.error||(!o.known?'unknown':o.inPool?'in pool':o.height!==mine.height||o.blockHash!==mine.blockHash?'different block':'only '+o.confirmations+' confirmations'))).join('; ')||'primary below confirmations'};},
  // TEST SERVICE: explicit operator recovery after a reorganisation incident (never automatic).
  async resume({symbol,note}){const op=await operatorFor(symbol);const r=await op.resume(note);await audit({action:'resume',symbol,note:note||null});return r;},
  async payout({symbol,txid}){const op=await operatorFor(symbol);const a=assets[symbol];const s=await indexer.call({op:'scan'});await op.reconcile(s);
   if(observers.length||requireObservers){const obs=await actions.observe({txid});await audit({action:'observe',txid,ok:obs.ok,reason:obs.reason});if(!obs.ok)throw Error('Payout withheld: independent observation does not confirm the burn ('+obs.reason+'). Nothing was paid; the redemption stays pending.');}
   const p=await op.payout(txid);return {status:p.status,net:p.receipt?a.bridge.net(BigInt(p.amount)).toString():null,feeBps:a.bridge.feeBps,repeated:Boolean(p.repeated)};},
  async mine({blocks}){await mine(Math.min(50,Number(blocks)||CONFIRMATIONS));return {tip:(await rpc('get_info')).height-1};},
  // TEST SERVICE: controlled rollback (monerod /pop_blocks, then flush the pool so popped carriers do not return by themselves). Stage-3 recovery tests only.
  async pop({blocks}){const n=Math.min(50,Math.max(1,Number(blocks)||1));const before=(await rpc('get_info')).height-1;const r=await fetch(`http://127.0.0.1:${rpcPort}/pop_blocks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();assert.equal(v.status,'OK','pop_blocks');await rpc('flush_txpool',{txids:[]});await audit({action:'pop',blocks:n});return {popped:n,from:before,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: chain rolled back; pool flushed.'};},
  // TEST SERVICE: controlled rollback (monerod /pop_blocks, then flush the pool so popped carriers do not return by themselves). Stage-3 recovery tests only.
  async pop({blocks}){const n=Math.min(50,Math.max(1,Number(blocks)||1));const before=(await rpc('get_info')).height-1;const r=await fetch(`http://127.0.0.1:${rpcPort}/pop_blocks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();assert.equal(v.status,'OK','pop_blocks');await rpc('flush_txpool',{txids:[]});await audit({action:'pop',blocks:n});return {popped:n,from:before,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: chain rolled back; pool flushed.'};},
  // Explicit viewing-key sharing: the key arrives ONLY in this request, is handed to the indexer process and is not stored by this service.
  async view({id,symbol,viewingKey}){const h=holder(id),a=assets[symbol];assert.ok(typeof viewingKey==='string'&&viewingKey.startsWith('penumbrafullviewingkey1'),'Full viewing key required');await indexer.call({op:'scan'});const v=await indexer.call({op:'view',viewingKey});h.viewingShared.add(symbol);await audit({action:'view',id,symbol});return {balance:v.balances[a.asset]??'0',notes:v.notes,canSpend:false};},
  async claimPrepare({id,claim,symbol='X'}){const h=holder(id);const a=assets[symbol];assert.ok(a?.legacyLot,'No legacy lots for this asset');const op=await operatorFor(symbol);const row=a.legacyRows.find(r=>r.claim===claim&&r.tokenAddress===h.tokenAddress);assert.ok(row,'Unknown legacy lot for this account');
   const body={profile:PROFILE,manifest:op.registry.id,kind:'MIGRATE',claim:row.claim,amount:row.amount,owner:h.tokenAddress};return {body,messageHash:legacyMessageHash(body),P:row.P,txPublicKey:row.R,outputIndex:row.index,amount:row.amount};},
  async claimSubmit({id,body,legacySignature,symbol='X'}){const h=holder(id);assert.ok(assets[symbol]?.legacyLot,'No legacy lots for this asset');const op=await operatorFor(symbol);assert.equal(body.owner,h.tokenAddress,'Claim owner must be this account');const c=await withDecoyRetry(()=>op.creditClaim({body,legacySignature},h.tokenAddress,h.ownerKey));await audit({action:'claim',id,symbol,claim:body.claim,credit:c.txid});return {txid:c.txid,status:c.status,amount:body.amount,symbol,asset:assets[symbol].asset,note:'Migration credit (PUBLIC note to your owner key): exactly the legacy lot, no deposit fee, no bridge tax; the credit carrier’s XMR fee is paid by the issuer (lab), not by the holder.'};},
 };
 const server=createServer(async(req,res)=>{const origin=req.headers.origin||'';const cors={'access-control-allow-origin':origin,'access-control-allow-headers':'content-type','access-control-allow-methods':'POST, GET, OPTIONS','vary':'origin'};try{
  if(req.headers.host!==`127.0.0.1:${httpPort}`)throw Error('Loopback host only');
  if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))throw Error('Origin not allowed');
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  if(req.method==='GET'&&req.url==='/params'){res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify({config,provingKeys:pkInfo,confirmations:CONFIRMATIONS,rpcUrl:`http://127.0.0.1:${rpcPort}`,paramsSet,label:manifest.label,note:'Informational only: the holder authenticates parameters against the manifest shipped in its own build.'}));}
  if(req.method==='GET'&&/^\/params\/(spend_pk\.bin|output_pk\.bin|parameters\.json)$/.test(req.url)){return serveParameterFile(req.url.slice(8),res,cors);}
  if(req.method==='POST'&&req.url.startsWith('/action/')){const name=req.url.slice(8);if(!actions[name])throw Error('Unknown action');let body='';for await(const c of req){body+=c;if(body.length>16384)throw Error('Too large');}const args=JSON.parse(body||'{}');
   // Secret-disclosure guard: the extension must never send seeds or secret keys here. (viewingKey is accepted only by the explicit `view` action.)
   for(const k of Object.keys(args))if(/seed|secret|private|unlock|password|spend|image|carrier|blob|ring|wire/i.test(k))throw Error('Refused: secret-looking or carrier field '+k);
   if(name!=='view'&&Object.values(args).some(v=>typeof v==='string'&&v.startsWith('penumbrafullviewingkey')))throw Error('Refused: viewing key outside the explicit share action');
   const result=await actions[name](args);res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify(result));}
  res.writeHead(404,cors);res.end();}
  catch(e){log(e.message);res.writeHead(400,{'content-type':'application/json',...cors});res.end(JSON.stringify({error:e.message}));}});
 // Parameter file transport, with TEST-ONLY fault injection (faults[name] for 'normal' | 'boundary' | 'parameters'):
 //   missing -> 404; truncate -> first 90% with a matching content-length; abort-midway -> full content-length, socket destroyed at 40%;
 //   corrupt-query -> one byte flipped half-way through the file (inside a proving-key query vector, verifying key untouched);
 //   foreign -> the same file from params/test-other (another setup/ledger); swap -> the other proving key under this name.
 async function serveParameterFile(name,res,cors){const key=name==='parameters.json'?'parameters':name.replace('_pk.bin','');const fault=faults[key]||null;
  let file=paramsDir+'/'+name;if(fault==='foreign')file=path.join(PARAMS_ROOT,'test-other',name);if(fault==='swap')file=paramsDir+'/'+(key==='spend'?'output':'spend')+'_pk.bin';
  await audit({action:'serve-parameter',name,fault});
  if(fault==='missing'){res.writeHead(404,cors);return res.end();}
  const size=(await stat(file)).size;
  if(fault==='corrupt-query'){const b=await readFile(file);b[Math.floor(b.length/2)]^=0x01;res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(b.length),...cors});return res.end(b);}
  if(fault==='truncate'){const n=Math.floor(size*0.9);res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(n),...cors});return createReadStream(file,{start:0,end:n-1}).pipe(res);}
  if(fault==='abort-midway'){res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(size),...cors});const n=Math.floor(size*0.4);const s=createReadStream(file,{start:0,end:n-1});s.on('end',()=>res.destroy());return s.pipe(res,{end:false});}
  res.writeHead(200,{'content-type':name.endsWith('.json')?'application/json':'application/octet-stream','content-length':String(size),...cors});return createReadStream(file).pipe(res);}
 await new Promise(r=>server.listen(httpPort,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${httpPort}/`,rpcUrl:`http://127.0.0.1:${rpcPort}`,run,config,manifest,paramsDir,paramsSet,faults,roleManifests,pkInfo,state,actions,holders,aliases,assets,indexer,issuer,bin,async close(){server.close();for(const s of [indexer,issuer])await s.close().catch(()=>{});daemon.kill();await sleep(500);}};
 })();}catch(e){daemon.kill('SIGKILL');throw e;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const b=await startBackend({log:console.error});await writeFile(b.run+'/pid',String(process.pid));console.log(JSON.stringify({ready:true,url:b.url,rpcUrl:b.rpcUrl,run:b.run,pid:process.pid,note:'Synthetic private-holder test backend. Stop with: kill '+process.pid}));}
