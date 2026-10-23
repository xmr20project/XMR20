// Private-holder TEST backend for the isolated extension build. SYNTHETIC ONLY.
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
import {createBridge,net as netOf,tax} from '../../privacy-integration-20261022/solana.mjs';
import {Registry,PROFILE,legacyMessageHash} from '../../privacy-integration-20261022/migration.mjs';
import {Operator,bindingFor,CONFIRMATIONS,EXPOSURE} from '../../privacy-integration-20261022/operator.mjs';
import {ORDER} from '../../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../../website/services/native-market/xn1/bytes.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url)),lab=path.resolve(dir,'../../privacy-integration-20261022'),root=path.resolve(dir,'../../..');
const bin=lab+'/target/release/xmr20-integration-lab';
const G=ed25519.ExtendedPoint.BASE,point=hex=>ed25519.ExtendedPoint.fromHex(hex,false),Hs=b=>le(keccak_256(b))%ORDER;
const varint=n=>{const out=[];let x=BigInt(n);while(x>=0x80n){out.push(Number(x&0x7fn)|0x80);x>>=7n;}out.push(Number(x));return Buffer.from(out);};
const randomScalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
const hex32=b=>Buffer.from(b).toString('hex');
export const EXTENSION_ORIGIN='chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla';
// Public half of Monero's one-time output derivation: P = Hs(8 r A || i) G + B.
export function legacyOutputFor({A,B},r,index){const D=point(A).multiply(8n).multiply(r).toRawBytes();const h=Hs(Buffer.concat([Buffer.from(D),varint(index)]));return {P:hex32(G.multiply(h).add(point(B)).toRawBytes()),R:hex32(G.multiply(r).toRawBytes()),index};}
// Two registered holders x 492,500,000 = 985,000,000 = the net legacy position migrated to reserve (1,000,000,000 gross, one fee). Register both test accounts before the first X operation.
const LEGACY_LOT='492500000';
export const PARAMS_ROOT=path.resolve(dir,'../params');
export async function startBackend({rpcPort=30041,p2pPort=30040,httpPort=8940,log=()=>{},origins=[EXTENSION_ORIGIN],paramsSet='test-v1',faults={}}={}){
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const run=await mkdtemp((await mkdir(dir+'../runs',{recursive:true}),dir+'../runs/backend-'));await mkdir(run+'/chain');await writeFile(run+'/chain/config','');
 const audit=async(line)=>appendFile(run+'/requests.log',JSON.stringify({at:new Date().toISOString(),...line})+'\n');
 const rpc=async(method,params={})=>{const r=await fetch(`http://127.0.0.1:${rpcPort}/json_rpc`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'b',method,params}),signal:AbortSignal.timeout(20000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 const daemon=spawn(root+'/operations/native-market-20261016/local-chain/bin/monerod',['--regtest','--keep-fakechain','--offline','--fixed-difficulty','1','--no-igd','--hide-my-port','--no-zmq','--disable-dns-checkpoints','--check-updates','disabled','--non-interactive','--data-dir',run+'/chain/data','--config-file',run+'/chain/config','--log-file',run+'/chain/daemon.log','--rpc-bind-ip','127.0.0.1','--rpc-bind-port',String(rpcPort),'--p2p-bind-ip','127.0.0.1','--p2p-bind-port',String(p2pPort),'--max-concurrency','2',...(origins.length?['--rpc-access-control-origins',origins.join(',')]:[])],{stdio:'ignore'});
 let ready=false;for(let i=0;i<150;i++){try{const info=await rpc('get_info');assert.equal(info.nettype,'fakechain');assert.equal(info.offline,true);ready=true;break;}catch{await sleep(200);}}assert(ready,'daemon');
 const env={XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(rpcPort)};
 // Fixed parameter set: small files copied, proving keys linked read-only into the run folder for the lab roles.
 const paramsDir=path.join(PARAMS_ROOT,paramsSet);await mkdir(run+'/parameters');
 for(const f of ['parameters.json','issuer.secret.json','manifest.json'])await copyFile(path.join(paramsDir,f),run+'/parameters/'+f);
 for(const f of ['normal.public-pk','boundary.public-pk'])await symlink(path.join(paramsDir,f),run+'/parameters/'+f);
 const config=JSON.parse(await readFile(run+'/parameters/parameters.json','utf8'));const manifest=JSON.parse(await readFile(run+'/parameters/manifest.json','utf8'));
 assert.equal((await rpc('get_block',{height:0})).block_header.hash,config.chain,'daemon genesis must match the fixed parameter set');
 const pkInfo={};for(const name of ['normal','boundary']){const file=paramsDir+'/'+name+'.public-pk';pkInfo[name]={bytes:(await stat(file)).size,sha256:createHash('sha256').update(await readFile(file)).digest('hex')};}
 const issuer=await service(bin,['issuer',run+'/parameters'],{env}),indexer=await service(bin,['indexer',run+'/parameters'],{env});const issuerNative=issuer.ready.issuerNativeAddress;
 const mineTo=async(address,n)=>{for(let left=n;left>0;left-=50)await rpc('generateblocks',{wallet_address:address,amount_of_blocks:Math.min(50,left)});};
 await mineTo(issuerNative,250);
 // Gamma decoy sampling on a short fakechain occasionally finds no usable ring members ("hit decoy selection round limit"); the failing calls build nothing durable, so they are simply retried.
 const withDecoyRetry=async(fn)=>{for(let i=0;;i++){try{return await fn();}catch(e){if(i>=5||!/decoy selection/.test(e.message))throw e;await sleep(100);}}};
 // Two assets: X = real XMR20 mint layout with a synthetic legacy position; S = new synthetic token, private by default, no legacy.
 const assets={};
 for(const [symbol,layout,legacyGross] of [['X','xmr20',1_000_000_000n],['S','synthetic',0n]]){
  const bridge=createBridge({legacyGross,layout});const asset=(await indexer.call({op:'asset',denom:'uxmr20private'+bridge.mint.toLowerCase().replace(/[^a-z0-9]/g,'')})).asset;
  assets[symbol]={symbol,layout,bridge,asset,legacyRows:[],registry:null,operator:null,name:symbol==='X'?'XMR20 (private test)':'XCAT private (test)'};
 }
 const snapshotOf=()=>({profile:PROFILE,kind:'synthetic-extension-test-snapshot',checkpoint:{height:'registration'},rows:assets.X.legacyRows.map(r=>({claim:r.claim,amount:r.amount,legacyOwner:r.P}))});
 const operatorFor=async(symbol)=>{const a=assets[symbol];if(a.operator)return a.operator;const registry=symbol==='X'?(a.registry??=new Registry(snapshotOf())):new Registry({rows:[]});
  a.operator=await Operator.open({file:run+'/operator-'+symbol+'.json',bridge:a.bridge,node:issuer,registry,asset:a.asset});if(symbol==='X'){const m=a.bridge.migrateLegacy();assert.ok(m.ok,'legacy migration to reserve');}return a.operator;};
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
  const out={tip:s.public.tip,confirmations:CONFIRMATIONS,exposure:EXPOSURE,rpcUrl:`http://127.0.0.1:${rpcPort}`,registered,tokenAddress:h?.tokenAddress??null,relay:null,carrierFunding:'holder',assets:[]};
  for(const a of Object.values(assets)){const op=a.operator;if(op)await op.reconcile(s);
   const row={symbol:a.symbol,name:a.name,asset:a.asset,mint:a.bridge.mint,layout:a.layout,liabilities:op?op.liabilities(s):null,payouts:[]};
   if(h){row.payouts=op?Object.entries(op.state.payouts).filter(([,p])=>op.state.requests[p.binding]?.destination===h.sol).map(([txid,p])=>({txid,amount:p.amount,status:p.status,confirmations:p.confirmations})):[];row.solanaBalance=a.bridge.tokenBalance(h.ata[a.symbol]);row.viewingKeyShared=h.viewingShared.has(a.symbol);
    if(a.symbol==='X'){row.legacy=a.legacyRows.filter(r=>r.tokenAddress===h.tokenAddress).map(r=>({claim:r.claim,amount:r.amount,P:r.P,txPublicKey:r.R,outputIndex:r.index,claimed:Boolean(a.operator?.state.credits[r.claim])}));}}
   out.assets.push(row);}
  return out;}
 const actions={
  async register({id,sol,xmr,A,B,tokenAddress}){assert.match(id,/^[A-Za-z0-9_-]{1,64}$/);assert.match(A,/^[0-9a-f]{64}$/);assert.match(B,/^[0-9a-f]{64}$/);assert.ok(typeof sol==='string'&&sol.length>=32&&sol.length<=44);assert.ok(typeof tokenAddress==='string'&&tokenAddress.startsWith('penumbra1')&&tokenAddress.length<200,'Private token address required');
   if(holders.has(tokenAddress)){const h=holders.get(tokenAddress);assert.equal(h.sol,sol,'This private address is registered with another Solana account');aliases.set(id,tokenAddress);await audit({action:'register',id,tokenAddress,existing:true});return {registered:true,tokenAddress,existing:true,note:'Known holder (same private address): bridge-side facts reattached; no private state exists on this service.'};}
   const ata={};for(const a of Object.values(assets))ata[a.symbol]=fundExternal(a.bridge,sol,1_000_000_000n);
   const r=randomScalar(),index=holders.size;const lot=legacyOutputFor({A,B},r,index);const late=Boolean(assets.X.registry);if(!late)assets.X.legacyRows.push({tokenAddress,claim:createHash('sha256').update('synthetic legacy lot '+tokenAddress).digest('hex'),amount:LEGACY_LOT,...lot});
   holders.set(tokenAddress,{tokenAddress,sol,xmr,A,B,ata,viewingShared:new Set(),ids:new Set([id])});aliases.set(id,tokenAddress);await audit({action:'register',id,tokenAddress});
   return {registered:true,tokenAddress,legacyLot:late?'0':LEGACY_LOT,lateRegistration:late,note:'Holder registered by public token address. This service holds no holder keys.'};},
  async state({id}){return state(id);},
  async depositPrepare({id,symbol,amount}){const h=holder(id),a=assets[symbol];assert.ok(a,'asset');const gross=BigInt(amount);assert.ok(gross>0n);assert.ok(netOf(gross)>0n,'Bridge fee consumes the amount');await operatorFor(symbol);
   const nonce=randomBytes(32).toString('hex');const c={...a.bridge.config,owner:h.sol};const ix=bridgeInstruction(c,a.bridge.options,{kind:'deposit',amount:String(gross),fee:tax(gross).toString(),nonce,binding:createHash('sha256').update('deposit binding '+nonce).digest('hex')});
   const tx=new Transaction({recentBlockhash:a.bridge.vm.latestBlockhash(),feePayer:new PublicKey(h.sol)}).add(ix.instruction);
   pendingDeposits.set(nonce,{tokenAddress:h.tokenAddress,symbol,receipt:ix.receipt,gross});
   return {nonce,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),review:{gross:String(gross),fee:tax(gross).toString(),net:netOf(gross).toString(),mint:a.bridge.mint,program:ix.instruction.programId.toBase58(),owner:h.sol,creditTo:h.tokenAddress}};},
  async depositSubmit({id,nonce,transaction}){const p=pendingDeposits.get(nonce);const h=holder(id);assert.ok(p&&p.tokenAddress===h.tokenAddress,'Unknown deposit');pendingDeposits.delete(nonce);const a=assets[p.symbol];
   const tx=Transaction.from(Buffer.from(transaction,'base64'));assert.ok(tx.signatures.some(s=>s.publicKey.toBase58()===h.sol&&s.signature),'Transaction not signed by the account');
   const x=execute(a.bridge.vm,tx);assert.ok(x.ok,'Solana deposit rejected: '+x.logs.join(' | '));const receipt=decodeBridgeReceipt(a.bridge.vm.getAccount(p.receipt.toBase58()).data);a.bridge.receipts.push(receipt);
   const op=await operatorFor(p.symbol);const c=await withDecoyRetry(()=>op.creditDeposit(receipt,h.tokenAddress));await audit({action:'deposit',id,symbol:p.symbol,gross:String(p.gross),credit:c.txid});
   return {receipt:{nonce:receipt.nonce,net:String(receipt.net)},credit:{txid:c.txid,status:c.status,binding:receipt.nonce},note:'Credit published on the test chain; your wallet sees it after '+CONFIRMATIONS+' confirmations.'};},
  // TEST SERVICE: mine `blocks` coinbase rewards to this holder's public Monero address (carrier-fee funding for the test). Coinbase matures after 60 blocks.
  async fund({id,blocks}){const h=holder(id);const n=Math.min(10,Math.max(1,Number(blocks)||1));assert.match(h.xmr,/^4[1-9A-HJ-NP-Za-km-z]{94}$/,'Registered Monero address required');await mineTo(h.xmr,n);await audit({action:'fund',id,blocks:n});return {funded:n,address:h.xmr,maturesAfter:60,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: '+n+' coinbase output(s) mined to this account. Mainnet XMR is bought or received, never mined by a service.'};},
  async redeemPrepare({id,symbol}){const h=holder(id),a=assets[symbol];assert.ok(a,'asset');const op=await operatorFor(symbol);const request=randomBytes(32).toString('hex'),destination=h.sol,binding=bindingFor(destination,request);op.registerRedemption(binding,destination,request);await op.persist();await audit({action:'redeemPrepare',id,symbol,binding});return {binding,destination,request,confirmations:CONFIRMATIONS};},
  async payout({symbol,txid}){const op=await operatorFor(symbol);const s=await indexer.call({op:'scan'});await op.reconcile(s);const p=await op.payout(txid);return {status:p.status,net:p.receipt?netOf(BigInt(p.amount)).toString():null,repeated:Boolean(p.repeated)};},
  async mine({blocks}){await mine(Math.min(50,Number(blocks)||CONFIRMATIONS));return {tip:(await rpc('get_info')).height-1};},
  // TEST SERVICE: controlled rollback (monerod /pop_blocks, then flush the pool so popped carriers do not return by themselves). Stage-3 recovery tests only.
  async pop({blocks}){const n=Math.min(50,Math.max(1,Number(blocks)||1));const before=(await rpc('get_info')).height-1;const r=await fetch(`http://127.0.0.1:${rpcPort}/pop_blocks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();assert.equal(v.status,'OK','pop_blocks');await rpc('flush_txpool',{txids:[]});await audit({action:'pop',blocks:n});return {popped:n,from:before,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: chain rolled back; pool flushed.'};},
  // TEST SERVICE: controlled rollback (monerod /pop_blocks, then flush the pool so popped carriers do not return by themselves). Stage-3 recovery tests only.
  async pop({blocks}){const n=Math.min(50,Math.max(1,Number(blocks)||1));const before=(await rpc('get_info')).height-1;const r=await fetch(`http://127.0.0.1:${rpcPort}/pop_blocks`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();assert.equal(v.status,'OK','pop_blocks');await rpc('flush_txpool',{txids:[]});await audit({action:'pop',blocks:n});return {popped:n,from:before,tip:(await rpc('get_info')).height-1,note:'TEST SERVICE: chain rolled back; pool flushed.'};},
  // Explicit viewing-key sharing: the key arrives ONLY in this request, is handed to the indexer process and is not stored by this service.
  async view({id,symbol,viewingKey}){const h=holder(id),a=assets[symbol];assert.ok(typeof viewingKey==='string'&&viewingKey.startsWith('penumbrafullviewingkey1'),'Full viewing key required');await indexer.call({op:'scan'});const v=await indexer.call({op:'view',viewingKey});h.viewingShared.add(symbol);await audit({action:'view',id,symbol});return {balance:v.balances[a.asset]??'0',notes:v.notes,canSpend:false};},
  async claimPrepare({id,claim}){const h=holder(id);const op=await operatorFor('X');const row=assets.X.legacyRows.find(r=>r.claim===claim&&r.tokenAddress===h.tokenAddress);assert.ok(row,'Unknown legacy lot for this account');
   const body={profile:PROFILE,manifest:op.registry.id,kind:'MIGRATE',claim:row.claim,amount:row.amount,owner:h.tokenAddress};return {body,messageHash:legacyMessageHash(body),P:row.P,txPublicKey:row.R,outputIndex:row.index,amount:row.amount};},
  async claimSubmit({id,body,legacySignature}){const h=holder(id);const op=await operatorFor('X');assert.equal(body.owner,h.tokenAddress,'Claim owner must be this account');const c=await withDecoyRetry(()=>op.creditClaim({body,legacySignature},h.tokenAddress));await audit({action:'claim',id,claim:body.claim,credit:c.txid});return {txid:c.txid,status:c.status,amount:body.amount};},
 };
 const server=createServer(async(req,res)=>{const origin=req.headers.origin||'';const cors={'access-control-allow-origin':origin,'access-control-allow-headers':'content-type','access-control-allow-methods':'POST, GET, OPTIONS','vary':'origin'};try{
  if(req.headers.host!==`127.0.0.1:${httpPort}`)throw Error('Loopback host only');
  if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))throw Error('Origin not allowed');
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  if(req.method==='GET'&&req.url==='/params'){res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify({config,provingKeys:pkInfo,confirmations:CONFIRMATIONS,rpcUrl:`http://127.0.0.1:${rpcPort}`,paramsSet,label:manifest.label,note:'Informational only: the holder authenticates parameters against the manifest shipped in its own build.'}));}
  if(req.method==='GET'&&/^\/params\/(normal\.public-pk|boundary\.public-pk|parameters\.json)$/.test(req.url)){return serveParameterFile(req.url.slice(8),res,cors);}
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
 async function serveParameterFile(name,res,cors){const key=name==='parameters.json'?'parameters':name.replace('.public-pk','');const fault=faults[key]||null;
  let file=paramsDir+'/'+name;if(fault==='foreign')file=path.join(PARAMS_ROOT,'test-other',name);if(fault==='swap')file=paramsDir+'/'+(key==='normal'?'boundary':'normal')+'.public-pk';
  await audit({action:'serve-parameter',name,fault});
  if(fault==='missing'){res.writeHead(404,cors);return res.end();}
  const size=(await stat(file)).size;
  if(fault==='corrupt-query'){const b=await readFile(file);b[Math.floor(b.length/2)]^=0x01;res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(b.length),...cors});return res.end(b);}
  if(fault==='truncate'){const n=Math.floor(size*0.9);res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(n),...cors});return createReadStream(file,{start:0,end:n-1}).pipe(res);}
  if(fault==='abort-midway'){res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(size),...cors});const n=Math.floor(size*0.4);const s=createReadStream(file,{start:0,end:n-1});s.on('end',()=>res.destroy());return s.pipe(res,{end:false});}
  res.writeHead(200,{'content-type':name.endsWith('.json')?'application/json':'application/octet-stream','content-length':String(size),...cors});return createReadStream(file).pipe(res);}
 await new Promise(r=>server.listen(httpPort,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${httpPort}/`,rpcUrl:`http://127.0.0.1:${rpcPort}`,run,config,manifest,paramsDir,paramsSet,faults,pkInfo,state,actions,holders,aliases,assets,indexer,async close(){server.close();for(const s of [indexer,issuer])await s.close().catch(()=>{});daemon.kill();await sleep(500);}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const b=await startBackend({log:console.error});await writeFile(b.run+'/pid',String(process.pid));console.log(JSON.stringify({ready:true,url:b.url,rpcUrl:b.rpcUrl,run:b.run,pid:process.pid,note:'Synthetic private-holder test backend. Stop with: kill '+process.pid}));}
