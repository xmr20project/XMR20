#!/usr/bin/env node
// Minimal SECOND WALLET application for XMR20 private tokens (EXPERIMENTAL, stage 4). A command-line
// wallet built only on wallet-lib/private-wallet.mjs and the documented SPEC; it shares no code with
// the extension's popup UI or the bridge operator. It talks to a Monero daemon (scanning, decoys,
// fee rate, publication) and to a parameter server (parameters.json and proving keys, authenticated
// against the shipped manifest). The test backend's only role here is the optional `fund`/`mine`
// TEST SERVICE commands and bridge registration, which a real holder would not need to transfer.
//
// SYNTHETIC USE ONLY: the state file stores the 32-byte root in clear (mode 0600) and the pending
// operation journal in clear. Never use a real phrase with this program.
//
// Usage: node xmr20-private-cli.mjs <command> [--state FILE] [--daemon URL] [--params URL] [--wasm PATH] [--manifest PATH]
//   init --root HEX32 | --seed "25 words" | --viewing-key penumbrafullviewingkey1…
//   address | native-address | viewing-key | sync | balance | notes | native | version
//   send --to ADDR --amount ATOMIC [--asset HEX] [--yes]      (quotes the fee, asks for confirmation unless --yes)
//   quote [--kind send|redeem] · publish-pending · verify --wire HEX
//   register --backend URL --sol PUBKEY      (test backend only: lets `fund`/`mine` work)
//   fund --backend URL [--blocks N] · mine --backend URL [--blocks N]
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);const cmd=args[0];const opt=(k,d=null)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};const flag=k=>args.includes('--'+k);
const STATE=opt('state',path.join(here,'state.json'));const DAEMON=opt('daemon','http://127.0.0.1:30041');const PARAMS=opt('params','http://127.0.0.1:8940');
const WASM=opt('wasm',path.join(here,'../holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));const MANIFEST=opt('manifest',path.join(here,'../params/test-v1/manifest.json'));
const out=o=>process.stdout.write(JSON.stringify(o,null,1)+'\n');
const fail=(m)=>{process.stderr.write('error: '+m+'\n');process.exit(2);};
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
async function loadState(){try{return JSON.parse(await readFile(STATE,'utf8'));}catch{return null;}}
async function saveState(s){await mkdir(path.dirname(STATE),{recursive:true});await writeFile(STATE,JSON.stringify(s,null,1),{mode:0o600});}
async function seedToRoot(seed){// Monero mnemonic -> private spend key through the established monero-ts library (same pinned version the extension ships). Resolved from the research workspace first, else from this file's own node_modules chain (install monero-ts@0.11.16 for --seed).
 const {createRequire,existsSync}=await import('node:module').then(async m=>({...m,existsSync:(await import('node:fs')).existsSync}));const base=path.resolve(here,'../wallet-extension/package.json');const req=createRequire(existsSync(base)?base:import.meta.url);let monero;try{monero=req('monero-ts');}catch{fail('monero-ts 0.11.16 is required for --seed (npm i monero-ts@0.11.16); --root and --viewing-key need no extra dependency');}
 const w=await monero.createWalletKeys({networkType:'mainnet',seed:seed.trim().toLowerCase().replace(/\s+/g,' ')});const root=await w.getPrivateSpendKey();const address=await w.getPrimaryAddress();return {root,address};}
async function open(state){const manifestBytes=new Uint8Array(await readFile(MANIFEST));const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
 const wasm=await readFile(WASM);const cache=diskCache(path.join(path.dirname(STATE),'param-cache'));
 return openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:DAEMON,parameterServer:PARAMS,cache,fetch:closeFetch,onProgress:p=>{if(p.text&&flag('verbose'))process.stderr.write(p.text+'\n');},...(state.root?{root:state.root}:{viewingKey:state.viewingKey})});}
function diskCache(dir){const file=k=>path.join(dir,k.replace(/[^A-Za-z0-9._-]/g,'_'));return {async get(k){try{return new Uint8Array(await readFile(file(k)));}catch{return null;}},async put(k,v){await mkdir(dir,{recursive:true});await writeFile(file(k),v);},async delete(k){const {rm}=await import('node:fs/promises');await rm(file(k),{force:true});}};}
async function confirm(q){if(flag('yes'))return true;const rl=createInterface({input:process.stdin,output:process.stderr});const a=await new Promise(r=>rl.question(q+' [y/N] ',r));rl.close();return /^y/i.test(a);}
async function post(backend,action,body){const r=await closeFetch(backend+'/action/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)fail(v.error);return v;}
const reservedKi=s=>Object.values(s.pending||{}).filter(p=>p.carrier?.keyImage&&['signed','published'].includes(p.status)).map(p=>p.carrier.keyImage);
const reservedNotes=s=>Object.values(s.pending||{}).flatMap(p=>['selected','built','signed','published'].includes(p.status)?p.reserved||[]:[]);
async function main(){
 if(!cmd||cmd==='help')return out({usage:'see header comment'});
 if(cmd==='init'){const existing=await loadState();if(existing&&!flag('force'))fail('state exists ('+STATE+'); use --force');
  let s;if(opt('root'))s={root:opt('root')};else if(opt('seed')){const k=await seedToRoot(opt('seed'));s={root:k.root,moneroAddress:k.address};}else if(opt('viewing-key'))s={viewingKey:opt('viewing-key')};else fail('init needs --root, --seed or --viewing-key');
  if(s.root&&!/^[0-9a-f]{64}$/.test(s.root))fail('root must be 32 bytes hex');s.pending={};s.history=[];s.created=new Date().toISOString();
  const w=await open(s);if(s.root){s.address=w.address();s.nativeAddress=w.nativeAddress();if(s.moneroAddress&&s.moneroAddress!==s.nativeAddress)fail('derived Monero address differs from the seed’s address');}else{s.address=w.address();}
  s.ledgerDomain=w.ledgerDomain;s.manifestLabel=w.manifestLabel;await saveState(s);return out({state:STATE,address:s.address,nativeAddress:s.nativeAddress||null,viewOnly:!s.root,manifestLabel:s.manifestLabel,ledgerDomain:s.ledgerDomain,warning:'SYNTHETIC USE ONLY: root stored in clear'});}
 const s=await loadState();if(!s)fail('no state; run init');
 const w=await open(s);
 const sync=async()=>{const r=await w.sync();if(s.root)w.reserveNative(reservedKi(s));await reconcile();return r;};
 async function reconcile(){const st=w.status();const spent=new Set((st.spent||[]).map(n=>n.commitment));
  for(const [id,p] of Object.entries(s.pending)){const rec=st.records[p.recordId];
   if(rec){p.status=rec.status==='accepted'?(rec.confirmations>=10?'confirmed':'mined'):'rejected';p.txid=rec.txid;p.confirmations=rec.confirmations;if(p.status==='confirmed'||p.status==='rejected'){s.history.unshift({...p,id});delete s.pending[id];}continue;}
   if(p.reserved?.some(c=>spent.has(c))){p.status='rejected';p.error='notes spent by another record/installation; carrier not sent, no fee';s.history.unshift({...p,id});delete s.pending[id];if(p.carrier)w.releaseNative([p.carrier.keyImage]);continue;}
   if(p.status==='signed'||p.status==='published'){const r=await w.publish(p.carrier.blob);p.status=r.ok?'published':(r.doubleSpend?'conflicted':'missing');p.attempts=(p.attempts||0)+1;p.lastReply=r;}}
  await saveState(s);}
 switch(cmd){
  case 'address':return out({address:w.address()});
  case 'native-address':return out({nativeAddress:w.nativeAddress()});
  case 'viewing-key':return out({viewingKey:w.viewingKey(),note:'token viewing key (not the Monero view key); can see and derive spent status, cannot spend'});
  case 'version':return out({protocol:w.protocol,engine:w.engineVersion(),manifestLabel:w.manifestLabel,ledgerDomain:w.ledgerDomain});
  case 'sync':{const r=await sync();const st=w.status();return out({...r,balances:st.balances,notes:st.notes.length,spent:st.spent.length,pending:Object.keys(s.pending).length});}
  case 'balance':{await sync();const st=w.status();return out({balances:st.balances,tip:st.tip,notes:st.notes.map(n=>({amount:n.amount,asset:n.asset})),pendingOperations:Object.values(s.pending).map(p=>({kind:p.kind,amount:p.amount,status:p.status,txid:p.carrier?.txid})),history:s.history.slice(0,5).map(p=>({kind:p.kind,amount:p.amount,status:p.status,error:p.error}))});}
  case 'notes':{await sync();return out(w.status().notes);}
  case 'native':{await sync();return out(w.native());}
  case 'verify':{await sync();return out(w.verify(opt('wire')));}// admission against the current public pool state
  case 'register':{const backend=opt('backend');const {ed25519}=await import('@noble/curves/ed25519');const h=b=>Buffer.from(b).toString('hex');const A=h(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())),B=h(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
   return out(await post(backend,'register',{id:opt('id','cli-'+Date.now()),sol:opt('sol'),xmr:w.nativeAddress(),A,B,tokenAddress:w.address()}));}
  case 'fund':return out(await post(opt('backend'),'fund',{id:opt('id'),blocks:Number(opt('blocks','1'))}));
  case 'mine':return out(await post(opt('backend'),'mine',{blocks:Number(opt('blocks','10'))}));
  case 'quote':{await sync();return out(await w.quoteCarrier({kind:opt('kind','send'),excludeKeyImages:reservedKi(s)}));}
  case 'publish-pending':{await sync();return out({pending:s.pending});}
  case 'send':{await sync();const to=opt('to'),amount=opt('amount');if(!to?.startsWith('penumbra1'))fail('--to must be a penumbra1 token address');if(!/^\d+$/.test(amount||''))fail('--amount in atomic units');
   const st=w.status();const asset=opt('asset')||Object.keys(st.balances)[0];if(!asset)fail('no balance');
   const sel=w.select({asset,amount,exclude:reservedNotes(s)});
   const q=await w.quoteCarrier({kind:'send',excludeKeyImages:reservedKi(s)});
   process.stderr.write(`Carrier fee ${q.fee} piconero (${q.weight} bytes x ${q.feePerWeight}) from XMR input ${q.inputAmount}; ${sel.notes.length} note(s), change ${sel.change}. Offline test chain rate; mainnet differs.\n`);
   if(!(await confirm('Approve the fee, prove and send?'))){w.cancelQuote(q.quoteId);return out({cancelled:true});}
   const id=String(Date.now());s.pending[id]={kind:'send',to,amount,asset,reserved:sel.notes,nativeInput:q.keyImage,status:'selected',created:Date.now()};await saveState(s);
   const built=await w.prove({kind:'send',to,amount,notes:sel.notes});s.pending[id]={...s.pending[id],status:'built',wire:built.wire,recordId:built.recordId,bytes:built.bytes,inputs:built.inputs,change:built.change,provingMs:built.provingMs};await saveState(s);
   const carrier=w.signCarrier(q.quoteId,built.wire);if(carrier.fee!==q.fee)fail('fee differs from quote');s.pending[id]={...s.pending[id],status:'signed',carrier};await saveState(s);
   const r=await w.publish(carrier.blob);s.pending[id].status=r.ok?'published':'missing';s.pending[id].lastReply=r;await saveState(s);
   return out({id,recordId:built.recordId,inputs:built.inputs,change:built.change,recordBytes:built.bytes,provingMs:built.provingMs,carrier:{txid:carrier.txid,fee:carrier.fee,nativeBytes:carrier.nativeBytes,extraBytes:carrier.extraBytes},published:r.ok});}
  default:fail('unknown command '+cmd);
 }
}
main().then(()=>process.exit(0),e=>fail(e.message));
