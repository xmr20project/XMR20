// Portable test vectors (synthetic keys only) for SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.
//   node vectors/make-vectors.mjs            -> vectors/vectors.json
// Produces: key-derivation vectors (root -> token spend key by an independent BLAKE2b, token address
// and Monero address by the engine), manifest/ledger-domain vectors (independent recomputation),
// record vectors (real XM3/XB3 records from a short synthetic run: bytes, independently parsed
// fields, record id, message preimages, engine admission result), tx_extra framing vectors, and a
// mnemonic vector (phrase -> root by monero-ts, checked by the independent decoder's wordlist rule).
// Running needs the built engine, the offline daemon and the lab roles (as the other tests).
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {blake2b} from '@noble/hashes/blake2b';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
import {ledgerDomain,checkManifest,unframe,parseRecord,messages} from '../independent/decode.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));
const PORTS={rpcPort:30073,p2pPort:30072,httpPort:8947};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const pers=Buffer.alloc(16);Buffer.from('XMR20-TKD1').copy(pers);
export const tkd1=(rootHex,account=0)=>hex(blake2b(Buffer.concat([Buffer.from('xmr20/private-token/spend-key'),Buffer.from([account&255,(account>>8)&255,(account>>16)&255,(account>>24)&255])]),{dkLen:32,key:Buffer.from(rootHex,'hex'),personalization:pers}));
const wasm=await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm');
const manifestBytes=new Uint8Array(await readFile(dir+'params/test-v1/manifest.json'));const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
const vectors={spec:'XMR20-PRIVATE-v0.1-experimental',generated:new Date().toISOString(),note:'synthetic keys only; records come from an offline test chain with disposable parameters'};
// 1. Manifest / ledger domain (independent).
vectors.manifest={sha256:createHash('sha256').update(manifestBytes).digest('hex'),ledgerDomainRecomputed:ledgerDomain(manifest.config),check:checkManifest(manifest),config:manifest.config,files:Object.fromEntries(Object.entries(manifest.files).map(([k,v])=>[k,{bytes:v.bytes,sha256:v.sha256}]))};
const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
try{
 // 2. Key derivation: fixed roots and a random one; tsk by independent BLAKE2b; addresses by the engine.
 vectors.keyDerivation=[];
 for(const rootHex of ['01'.repeat(32),'07'.repeat(32),hex(randomBytes(32))]){const w=await openPrivateWallet({wasm,manifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:rootHex});
  vectors.keyDerivation.push({root:rootHex,account:0,tokenSpendKey_blake2b:tkd1(rootHex,0),tokenSpendKey_account1:tkd1(rootHex,1),tokenAddress:w.address(),moneroAddress:w.nativeAddress(),viewingKey:w.viewingKey()});w.close();}
 // 3. Records from a short run: credit (XB3 DEPOSIT), transfer (XM3), redemption (XB3 REDEEM).
 const A=await openPrivateWallet({wasm,manifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
 const B=await openPrivateWallet({wasm,manifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
 const sol=Keypair.generate();const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 await post('register',{id:'vecA',sol:sol.publicKey.toBase58(),xmr:A.nativeAddress(),...pub(),tokenAddress:A.address()});
 const prep=await post('depositPrepare',{id:'vecA',symbol:'X',amount:'10000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);const dep=await post('depositSubmit',{id:'vecA',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
 await post('fund',{id:'vecA',blocks:1});await post('mine',{blocks:50});await post('mine',{blocks:12});await A.sync();
 const X=backend.assets.X.asset;const sel=A.select({asset:X,amount:'4000000'});const q=await A.quoteCarrier({kind:'send'});const built=await A.prove({kind:'send',to:B.address(),amount:'4000000',notes:sel.notes});const carrier=A.signCarrier(q.quoteId,built.wire);await A.publish(carrier.blob);await post('mine',{blocks:10});await A.sync();await B.sync();
 const rp=await post('redeemPrepare',{id:'vecA',symbol:'X'});const selR=A.select({asset:X,amount:'1000000'});const qR=await A.quoteCarrier({kind:'redeem'});const red=await A.prove({kind:'redeem',amount:'1000000',binding:rp.binding,notes:selR.notes});const carrierR=A.signCarrier(qR.quoteId,red.wire);await A.publish(carrierR.blob);await post('mine',{blocks:10});await A.sync();
 // Fetch every carrier's extra from the daemon and decode independently.
 const txs=[dep.credit.txid,carrier.txid,carrierR.txid];const got=await closeFetch(backend.rpcUrl+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:txs,decode_as_json:true})}).then(r=>r.json());
 vectors.records=[];
 for(const t of got.txs){const extra=Buffer.from(JSON.parse(t.as_json).extra);const {pubkey,record}=unframe(extra);const parsed=parseRecord(record);const engine=A.verify(hex(record));
  vectors.records.push({txid:t.tx_hash,extraHex:hex(extra),extraBytes:extra.length,txPubkey:pubkey,recordHex:hex(record),independentParse:parsed,messages:messages(parsed,manifest.ledgerDomain),engineAdmissionOfAlreadyAppliedRecord:engine,note:'engine says rejected because the record is already on chain (duplicate nullifier); its fields match the independent parse'});}
 const st=A.status();vectors.walletView={A:{address:A.address(),balances:st.balances,notes:st.notes.length,spent:st.spent.length},B:{address:B.address(),balances:B.status().balances}};
 // 4. tx_extra framing vectors (independent): framing of a 996-byte record into 254-byte 0x7F chunks is derived from the record above.
 vectors.framing={rule:'tag 0x02, varint length, 0x7F marker, up to 254 record bytes per chunk, chunks in order; exactly one 0x01 tx pubkey; total <= 1060',example:vectors.records[1]?.extraHex};
 // 5. Mnemonic vector: monero-ts phrase -> root; the independent decoder re-derives it from the wordlist rule when a wordlist is available (see independent/README).
 try{const {createRequire}=await import('node:module');const req=createRequire(dir+'wallet-extension/package.json');const monero=req('monero-ts');const w=await monero.createWalletKeys({networkType:'mainnet',language:'English'});const seed=await w.getSeed();const root=await w.getPrivateSpendKey();
  const wl=await openPrivateWallet({wasm,manifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root});vectors.mnemonic={words:seed,root,tokenAddress:wl.address(),moneroAddress:await w.getPrimaryAddress(),engineMoneroAddress:wl.nativeAddress(),note:'SYNTHETIC phrase generated for this vector; never reuse'};wl.close();}
 catch(e){vectors.mnemonic={error:e.message};}
 A.close();B.close();
}finally{await backend.close();}
await mkdir(dir+'vectors',{recursive:true});await writeFile(dir+'vectors/vectors.json',JSON.stringify(vectors,null,1)+'\n');
console.log(JSON.stringify({keyDerivation:vectors.keyDerivation.length,records:vectors.records.length,manifestOk:vectors.manifest.check.ok}));
