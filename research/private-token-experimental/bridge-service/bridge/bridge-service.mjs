// BRIDGE SERVICE for the unshielded-by-default format: the operator as a long-running process.
// Components it owns: the issuer role (format roles binary; holds the lab issuer key and its XMR wallet for credit carriers),
// one Operator per asset (operator.mjs; durable journal + audit log), the custody adapter (LiteSVM for the test chain, RPC
// for devnet/mainnet-beta), the deposit watcher and payout loops, a loopback HTTP API for wallets and an admin API.
// Holder API (same action names as the test backend so the wallet popup works unchanged): state, register, depositPrepare,
// depositSubmit, redeemPrepare, payout, claimPrepare, claimSubmit, view (forwarded to the indexer). Test services (mine, fund,
// pop) exist ONLY when config.testServices is true AND the network is the offline fakechain.
// Safety: mainnet is refused unless config.network === 'mainnet' AND the process is started with XMR20_BRIDGE_MAINNET=I-UNDERSTAND
// (this candidate ships no mainnet manifest, so it cannot happen here); secrets are never read by this file (the issuer role reads
// its own secret file; the RPC custody loads the operator keypair); every operator decision is appended to the audit log.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Transaction,PublicKey} from '@solana/web3.js';
import {service} from '../../privacy-integration-20261022/rpc.mjs';
import {parseTokenAddress} from '../../token-format-unshielded-20261025/backend/address.mjs';
import {Registry,PROFILE,legacyMessageHash} from '../../token-format-unshielded-20261025/backend/migration-registry.mjs';
import {createIndexerClient} from './indexer-service.mjs';
import {Operator,DEFAULT_CONFIRMATIONS,DEFAULT_EXPOSURE,redeemBindingFor,depositBindingFor} from './operator.mjs';
import {createLiteSvmCustody} from './custody-litesvm.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const SUPPORTED_NETWORKS=['offline-fakechain','stagenet'];
export async function startBridgeService(cfg){
 // ---- configuration and guards
 const {network,daemonRpc,indexerUrl,indexerToken=null,httpPort=8975,listen='127.0.0.1',adminToken=null,rolesBin,paramsDir,trustedManifest,journalDir,confirmations=DEFAULT_CONFIRMATIONS,exposure=DEFAULT_EXPOSURE,observers=[],requireObservers=false,assets,custody:custodyCfg,registrySnapshot=null,testServices=false,pollMs=10000,origins=null,log=()=>{}}=cfg;
 if(network==='mainnet'){assert.equal(process.env.XMR20_BRIDGE_MAINNET,'I-UNDERSTAND','REFUSED: mainnet requires XMR20_BRIDGE_MAINNET=I-UNDERSTAND and a mainnet manifest; neither exists in this candidate');throw Error('REFUSED: no mainnet manifest exists in this candidate');}
 assert.ok(SUPPORTED_NETWORKS.includes(network),'network must be offline-fakechain or stagenet');
 if(listen!=='127.0.0.1')assert.ok(adminToken,'adminToken required beyond loopback');
 const manifest=JSON.parse(await readFile(trustedManifest,'utf8'));assert.equal(manifest.network.kind,network,'trusted manifest network differs from the configuration');
 const info=await (await fetch(daemonRpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'b',method:'get_info'}),signal:AbortSignal.timeout(20000)})).json();
 assert.ok(info.result&&info.result.nettype!=='mainnet'&&info.result.mainnet!==true,'REFUSED: mainnet daemon');
 if(network==='offline-fakechain')assert.ok(info.result.nettype==='fakechain'&&info.result.offline===true,'offline fakechain required');else assert.ok(info.result.nettype==='stagenet','stagenet daemon required');
 await mkdir(journalDir,{recursive:true});const run=journalDir;const auditFile=path.join(run,'audit.log');
 const audit=line=>appendFile(auditFile,JSON.stringify({at:new Date().toISOString(),...line})+'\n').catch(()=>{});
 const rpc=async(method,params={})=>{const r=await fetch(daemonRpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'b',method,params}),signal:AbortSignal.timeout(60000)});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 // ---- indexer client, issuer role
 const indexer=createIndexerClient(indexerUrl,{token:indexerToken});const ih=await indexer.health();assert.equal(ih.domain,manifest.ledgerDomain,'indexer serves another ledger');
 const port=new URL(daemonRpc).port||'18081';const issuer=await service(rolesBin,['issuer',path.resolve(paramsDir),'--trusted-manifest',trustedManifest],{env:{XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_URL:daemonRpc,XMR20_INTEGRATION_RPC_PORT:String(port)}});
 await issuer.call({op:'scan'});const issuerNative=issuer.ready.issuerNativeAddress;
 // ---- custody + operators per asset
 const custodies={},ops={},assetIds={};
 for(const a of assets){const c=custodyCfg.kind==='litesvm'?(custodyCfg.instances?.[a.symbol]??(custodyCfg.instances?(custodyCfg.instances[a.symbol]=createLiteSvmCustody({mintAddress:a.mint,decimals:a.decimals??6,legacyGross:BigInt(a.legacyGross||0),layout:a.layout||'synthetic',mintData:a.mintData||null})):createLiteSvmCustody({mintAddress:a.mint,decimals:a.decimals??6,legacyGross:BigInt(a.legacyGross||0),layout:a.layout||'synthetic',mintData:a.mintData||null}))):(await import('./custody-rpc.mjs')).createRpcCustody({...custodyCfg,...a.custody,network:custodyCfg.network});
  const id=(await issuer.call({op:'asset',mint:c.mint})).asset;assetIds[a.symbol]=id;custodies[a.symbol]=c;
  if(c.kind==='litesvm'&&BigInt(a.legacyGross||0)>0n){const m=await c.migrateLegacy();await audit({event:'legacy-position-migrated',symbol:a.symbol,...m});}
  const registry=registrySnapshot&&a.symbol===registrySnapshot.asset?new Registry(registrySnapshot):null;
  ops[a.symbol]=await Operator.open({file:path.join(run,'operator-'+a.symbol+'.json'),auditFile,custody:c,issuer,indexer,registry,asset:id,confirmations,exposure,observers,requireObservers});ops[a.symbol].primaryRpc=daemonRpc;}
 const holders=new Map(),aliases=new Map();const stateFile=path.join(run,'holders.json');try{const s=JSON.parse(await readFile(stateFile,'utf8'));for(const [k,v] of Object.entries(s.holders))holders.set(k,{...v,viewingShared:new Set(v.viewingShared||[])});for(const [k,v] of Object.entries(s.aliases))aliases.set(k,v);}catch{}
 const persistHolders=()=>writeFile(stateFile,JSON.stringify({holders:Object.fromEntries([...holders].map(([k,v])=>[k,{...v,viewingShared:[...v.viewingShared]}])),aliases:Object.fromEntries(aliases)},null,1));
 const holder=id=>{const h=holders.get(aliases.get(id));assert.ok(h,'Account not registered with the bridge');return h;};
 const pendingDeposits=new Map();// nonce -> {symbol, ownerKey}
 // ---- loops: deposits (finalized receipts -> credits), credits recovery, payouts
 let current=null,loopStats={runs:0,lastAt:null,lastError:null,credits:0,payouts:0};
 // One tick at a time; a caller that arrives while a tick runs waits for that tick instead of returning early.
 const tick=()=>current??(current=runTick().finally(()=>{current=null;}));
 async function runTick(){try{const summary=await indexer.summary();
  for(const [symbol,op] of Object.entries(ops)){const c=custodies[symbol];
   // recovery of credits journaled but not indexed
   for(const [binding,cr] of Object.entries(op.state.credits))if(['built','published'].includes(cr.status)&&cr.publishedAt&&Date.now()-Date.parse(cr.publishedAt)>60000){await op.retryCredit(binding,summary).catch(e=>audit({event:'credit-retry-failed',binding,error:e.message.slice(0,200)}));}
   // deposits: every finalized receipt bound to a known owner, not yet credited
   if(!op.state.halted)for(const r of await c.receipts()){if(op.state.credits[r.nonce])continue;if(!op.ownerForBinding(r.binding,r.nonce))continue;try{await op.creditDeposit(r);loopStats.credits++;}catch(e){await audit({event:'credit-failed',nonce:r.nonce,error:e.message.slice(0,200)});}}
   const rec=await op.reconcile(summary);
   for(const txid of rec.eligible){try{const p=await op.payout(txid);if(p.status==='paid'&&!p.repeated)loopStats.payouts++;}catch(e){await audit({event:'payout-deferred',txid,error:e.message.slice(0,800)});}}}
  loopStats.runs++;loopStats.lastAt=new Date().toISOString();loopStats.lastError=null;}
  catch(e){loopStats.lastError={at:new Date().toISOString(),message:e.message.slice(0,300)};await audit({event:'tick-error',error:e.message.slice(0,300)});}}
 const timer=setInterval(()=>{tick().catch(()=>{});},pollMs);
 // ---- holder actions
 const assetRows=async(h)=>{const summary=await indexer.summary();const rows=[];for(const a of assets){const op=ops[a.symbol],c=custodies[a.symbol];const row={symbol:a.symbol,ticker:a.symbol,name:a.name||a.symbol,asset:assetIds[a.symbol],mint:c.mint,decimals:c.decimals,feeBps:c.feeBps,layout:c.kind,liabilities:await op.liabilities(summary).catch(e=>({error:e.message.slice(0,120)})),payouts:[],legacy:[],operator:{halted:op.state.halted,paused:op.state.paused,confirmations:op.confirmations,incidents:op.state.incidents.length}};
   if(h){row.payouts=Object.entries(op.state.payouts).filter(([,p])=>op.state.requests[p.binding]?.destination===h.sol||p.owner===h.ownerKey).map(([txid,p])=>({txid,amount:p.amount,status:p.status,confirmations:p.confirmations,requested:Boolean(op.state.requests[p.binding])}));row.solanaBalance=c.kind==='litesvm'&&h.ata?.[a.symbol]?await c.tokenBalance(h.ata[a.symbol]):null;row.viewingKeyShared=h.viewingShared.has(a.symbol);
    if(op.registry){const consumed=new Set(op.registry.consumedIds());row.legacy=op.registry.rows.filter(r=>h.legacyKeys.includes(r.legacyOwner)).map(r=>({claim:r.claim,amount:r.amount,legacyOwner:r.legacyOwner,txPublicKey:r.txPublicKey||null,outputIndex:r.outputIndex??null,consumed:consumed.has(r.claim),credit:op.state.credits[r.claim]?{txid:op.state.credits[r.claim].txid,status:op.state.credits[r.claim].status}:null}));}}
   rows.push(row);}return {summary,rows};};
 const actions={
  async state({id}){const registered=aliases.has(id);const h=registered?holder(id):null;const {summary,rows}=await assetRows(h);const i=await rpc('get_info');
   return {tip:summary.tip,daemonTip:i.height-1,network,confirmations,exposure,rpcUrl:daemonRpc,indexer:indexerUrl,registered,tokenAddress:h?.tokenAddress??null,ownerKey:h?.ownerKey??null,relay:null,carrierFunding:'holder',format:'XMR20-UNSHIELDED-v0.2-experimental',defaultMode:'public',pool:summary.state,features:{mine:testServices&&network==='offline-fakechain',fund:testServices&&network==='offline-fakechain',bridge:true,credit:false,faucet:false,view:true},assets:rows,explorer:network==='stagenet'?'https://stagenet.xmrchain.net/tx/':null};},
  async register({id,sol,xmr,tokenAddress,legacyKeys=[]}){assert.match(id,/^[A-Za-z0-9_-]{1,64}$/);assert.ok(Array.isArray(legacyKeys)&&legacyKeys.length<=64&&legacyKeys.every(k=>/^[0-9a-f]{64}$/.test(k)),'legacyKeys: public one-time output keys (hex) only');assert.ok(typeof tokenAddress==='string'&&tokenAddress.startsWith('xmr20t1')&&tokenAddress.length<300,'Unified token address (xmr20t1…) required');const ownerKey=parseTokenAddress(tokenAddress).ownerKey;new PublicKey(sol);
   if(holders.has(tokenAddress)){const h=holders.get(tokenAddress);assert.equal(h.sol,sol,'This token address is registered with another Solana account');for(const k of legacyKeys)if(!h.legacyKeys.includes(k))h.legacyKeys.push(k);aliases.set(id,tokenAddress);await persistHolders();return {registered:true,tokenAddress,ownerKey,existing:true};}
   const ata={};if(custodyCfg.kind==='litesvm')for(const a of assets)ata[a.symbol]=custodies[a.symbol].fundHolder(sol,BigInt(a.testHolding||'1000000000')).toBase58();
   holders.set(tokenAddress,{tokenAddress,ownerKey,sol,xmr,ata,legacyKeys:[...legacyKeys],viewingShared:new Set(),ids:[id]});aliases.set(id,tokenAddress);for(const op of Object.values(ops))await op.registerOwner({ownerKey,solana:sol,tokenAddress});await persistHolders();await audit({event:'register',tokenAddress,ownerKey,sol});
   return {registered:true,tokenAddress,ownerKey,note:'Registered by public token address. This service holds no holder keys. Deposits are credited to your owner key once their receipt is finalized.'};},
  async depositPrepare({id,symbol,amount}){const h=holder(id),c=custodies[symbol];assert.ok(c,'asset');const gross=BigInt(amount);assert.ok(gross>0n&&c.net(gross)>0n,'amount');const nonce=randomBytes(32).toString('hex');const binding=depositBindingFor(h.ownerKey,nonce);
   const prep=c.depositPrepare(h.sol,gross,nonce,binding);pendingDeposits.set(nonce,{symbol,ownerKey:h.ownerKey});await audit({event:'deposit-prepared',symbol,nonce,ownerKey:h.ownerKey,gross:String(gross)});
   return {nonce,binding,transaction:prep.transactionBase64||null,instruction:prep.instruction?{programId:prep.instruction.programId.toBase58(),keys:prep.instruction.keys.map(k=>({pubkey:k.pubkey.toBase58(),isSigner:k.isSigner,isWritable:k.isWritable})),data:Buffer.from(prep.instruction.data).toString('base64')}:null,review:{gross:String(gross),fee:prep.fee,feeBps:c.feeBps,net:prep.net,mint:c.mint,program:prep.program,owner:h.sol,creditTo:h.tokenAddress,ownerKey:h.ownerKey}};},
  async depositSubmit({id,nonce,transaction}){const h=holder(id);const p=pendingDeposits.get(nonce);assert.ok(p&&p.ownerKey===h.ownerKey,'Unknown deposit');const c=custodies[p.symbol];
   if(c.kind==='litesvm'){const tx=Transaction.from(Buffer.from(transaction,'base64'));assert.ok(tx.signatures.some(s=>s.publicKey.toBase58()===h.sol&&s.signature),'Transaction not signed by the account');}
   const receipt=await c.depositSubmit(transaction,nonce);pendingDeposits.delete(nonce);await audit({event:'deposit-submitted',symbol:p.symbol,nonce});
   // credit immediately when the receipt is already final (LiteSVM); the loop handles the rest
   let credit=null;if(receipt?.kind===10){try{credit=await ops[p.symbol].creditDeposit(receipt);}catch(e){await audit({event:'credit-failed',nonce,error:e.message.slice(0,200)});}}
   return {receipt:receipt?{nonce:receipt.nonce,net:String(receipt.net)}:{nonce,signature:receipt?.signature},credit:credit?{txid:credit.txid,status:credit.status,binding:nonce,kind:'public'}:null,note:credit?'PUBLIC credit published to your owner key; visible after '+confirmations+' confirmations.':'Deposit sent; the credit follows once the receipt is finalized.'};},
  async redeemPrepare({id,symbol,amount=null}){const h=holder(id);const op=ops[symbol];assert.ok(op,'asset');if(amount!==null){assert.ok(/^\d+$/.test(String(amount)),'amount');assert.ok(BigInt(amount)<=BigInt(op.exposure.maxSinglePayout),`Exposure: single payout above limit (max ${op.exposure.maxSinglePayout} atomic units); nothing was burned`);}
   const request=randomBytes(32).toString('hex'),destination=h.sol,binding=redeemBindingFor(destination,request);await op.registerRedemption(binding,destination,request);await audit({event:'redeem-prepared',symbol,binding,destination});return {binding,destination,request,confirmations,maxSinglePayout:op.exposure.maxSinglePayout};},
  async payout({symbol,txid}){const op=ops[symbol];assert.ok(op,'asset');const summary=await indexer.summary();await op.reconcile(summary);const p=await op.payout(txid);return {status:p.status,net:p.receipt?custodies[symbol].net(BigInt(p.amount)).toString():null,feeBps:custodies[symbol].feeBps,repeated:Boolean(p.repeated)};},
  async claimPrepare({id,claim,symbol}){const h=holder(id);const op=ops[symbol];assert.ok(op?.registry,'No migration registry for this asset');const row=op.registry.rows.find(r=>r.claim===claim);assert.ok(row,'Unknown legacy lot');
   const body={profile:PROFILE,manifest:op.registry.id,kind:'MIGRATE',claim:row.claim,amount:row.amount,owner:h.tokenAddress};return {body,messageHash:legacyMessageHash(body),P:row.legacyOwner,txPublicKey:row.txPublicKey||null,outputIndex:row.outputIndex??null,amount:row.amount};},
  async claimSubmit({id,body,legacySignature,symbol}){const h=holder(id);const op=ops[symbol];assert.ok(op?.registry,'No migration registry for this asset');assert.equal(body.owner,h.tokenAddress,'Claim owner must be this account');const c=await op.creditClaim({body,legacySignature},h.tokenAddress,h.ownerKey);return {txid:c.txid,status:c.status,amount:body.amount,symbol,asset:assetIds[symbol],note:'Migration credit (PUBLIC note to your owner key): exactly the legacy lot; the credit carrier fee is paid by the issuer.'};},
  async view({id,symbol,viewingKey}){const h=holder(id);assert.ok(typeof viewingKey==='string'&&viewingKey.startsWith('penumbrafullviewingkey1'),'Full viewing key required');const v=await indexer.view(viewingKey);h.viewingShared.add(symbol);await persistHolders();return {balance:v.balances[assetIds[symbol]]??'0',notes:v.notes,canSpend:false};},
  // TEST SERVICES (offline fakechain only)
  async mine({blocks}){assert.ok(testServices&&network==='offline-fakechain','test service disabled');const n=Math.min(50,Number(blocks)||confirmations);await rpc('generateblocks',{wallet_address:issuerNative,amount_of_blocks:n});await indexer.sync();return {tip:(await rpc('get_info')).height-1};},
  async fund({id,blocks}){assert.ok(testServices&&network==='offline-fakechain','test service disabled');const h=holder(id);const n=Math.min(10,Math.max(1,Number(blocks)||1));await rpc('generateblocks',{wallet_address:h.xmr,amount_of_blocks:n});return {funded:n,address:h.xmr,maturesAfter:60,tip:(await rpc('get_info')).height-1};},
  async pop({blocks}){assert.ok(testServices&&network==='offline-fakechain','test service disabled');const n=Math.min(50,Math.max(1,Number(blocks)||1));const r=await fetch(daemonRpc+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();assert.equal(v.status,'OK');await rpc('flush_txpool',{txids:[]});await indexer.sync();return {popped:n,tip:(await rpc('get_info')).height-1};},
 };
 const admin={
  async status(){const out={network,assets:{},loop:loopStats,indexer:await indexer.health().catch(e=>({error:e.message}))};for(const [s,op] of Object.entries(ops))out.assets[s]={halted:op.state.halted,paused:op.state.paused,incidents:op.state.incidents.slice(-5),credits:Object.keys(op.state.credits).length,payouts:Object.values(op.state.payouts).reduce((m,p)=>{m[p.status]=(m[p.status]||0)+1;return m;},{}),confirmations:op.confirmations,exposure:op.exposure};return out;},
  async incidents(){return Object.fromEntries(Object.entries(ops).map(([s,op])=>[s,op.state.incidents]));},
  async liabilities(){const summary=await indexer.summary();return Object.fromEntries(await Promise.all(Object.entries(ops).map(async([s,op])=>[s,await op.liabilities(summary)])));},
  async pause({symbol,note}){return ops[symbol].pause(note);},
  async resume({symbol,note}){return ops[symbol].resume(note);},
  async tick(){await tick();return loopStats;},
 };
 const server=createServer(async(req,res)=>{const origin=req.headers.origin||'';const cors={'access-control-allow-origin':origin,'access-control-allow-headers':'content-type, authorization','access-control-allow-methods':'POST, GET, OPTIONS','vary':'origin'};try{
  if(req.headers.host!==`${listen}:${httpPort}`&&listen==='127.0.0.1')throw Error('Loopback host only');
  if(origin&&!(origins?origins.includes(origin):/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))throw Error('Origin not allowed');
  if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
  if(req.method==='GET'&&req.url==='/health'){const st=await admin.status();const ok=!loopStats.lastError&&Object.values(ops).every(o=>!o.state.halted)&&st.indexer?.ok!==false;res.writeHead(ok?200:503,{'content-type':'application/json',...cors});return res.end(JSON.stringify({ok,...st}));}
  if(req.method==='GET'&&req.url==='/params'){res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify({config:JSON.parse(await readFile(path.join(paramsDir,'parameters.json'),'utf8')),confirmations,rpcUrl:daemonRpc,label:manifest.label,note:'Transport only: holders authenticate parameters against the manifest shipped in their build.'}));}
  if(req.method==='GET'&&/^\/params\/(spend_pk\.bin|output_pk\.bin|parameters\.json)$/.test(req.url)){const name=req.url.slice(8);const file=path.join(paramsDir,name);const size=(await stat(file)).size;res.writeHead(200,{'content-type':name.endsWith('.json')?'application/json':'application/octet-stream','content-length':String(size),...cors});return createReadStream(file).pipe(res);}
  if(req.method==='POST'&&(req.url.startsWith('/action/')||req.url.startsWith('/admin/'))){const isAdmin=req.url.startsWith('/admin/');const name=req.url.split('/')[2];const table=isAdmin?admin:actions;if(!table[name])throw Error('Unknown action');
   if(isAdmin&&adminToken&&req.headers.authorization!==`Bearer ${adminToken}`)throw Error('admin token required');
   let body='';for await(const c of req){body+=c;if(body.length>16384)throw Error('Too large');}const args=JSON.parse(body||'{}');
   for(const k of Object.keys(args))if(/seed|secret|private|unlock|password|spend|image|carrier|blob|ring|wire/i.test(k))throw Error('Refused: secret-looking or carrier field '+k);
   if(name!=='view'&&Object.values(args).some(v=>typeof v==='string'&&v.startsWith('penumbrafullviewingkey')))throw Error('Refused: viewing key outside the explicit share action');
   const result=await table[name](args);res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify(result));}
  res.writeHead(404,cors);res.end();}
  catch(e){log(e.message);res.writeHead(400,{'content-type':'application/json',...cors});res.end(JSON.stringify({error:String(e.message).slice(0,400)}));}});
 await new Promise(r=>server.listen(httpPort,listen,r));
 await audit({event:'started',network,httpPort,assets:assets.map(a=>a.symbol),confirmations,observers:observers.length});
 return {url:`http://${listen}:${httpPort}/`,run,actions,admin,ops,custodies,assetIds,issuer,issuerNative,indexer,tick,async close(){clearInterval(timer);server.closeAllConnections?.();await new Promise(r=>server.close(r));await issuer.close().catch(()=>{});await issuer.kill().catch(()=>{});}};
}
export async function loadConfig(file){const cfg=JSON.parse(await readFile(file,'utf8'));const base=path.dirname(path.resolve(file));for(const k of ['rolesBin','paramsDir','trustedManifest','journalDir'])if(cfg[k]&&!path.isAbsolute(cfg[k]))cfg[k]=path.resolve(base,cfg[k]);if(cfg.custody?.operatorKeypairPath&&!path.isAbsolute(cfg.custody.operatorKeypairPath))cfg.custody.operatorKeypairPath=path.resolve(base,cfg.custody.operatorKeypairPath);return cfg;}
if(process.argv[1]===fileURLToPath(import.meta.url)){const file=process.argv[2];if(!file){console.error('usage: node bridge-service.mjs <config.json>');process.exit(2);}
 const cfg=await loadConfig(file);const b=await startBridgeService({...cfg,log:m=>console.error('[bridge] '+m)});console.log(JSON.stringify({ready:true,url:b.url,network:cfg.network,assets:Object.keys(b.assetIds),issuerNative:b.issuerNative,journal:b.run,pid:process.pid}));
 const stop=async()=>{await b.close().catch(()=>{});process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);}
