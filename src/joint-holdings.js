// Public portfolio reads only. This module has no holder signer or submission API.
import {Connection} from '@solana/web3.js';
import {jointService} from './joint-service.js';
import {discoveredAssets,savedJointAssets} from './joint-bridge-assets.js';
import {transferableManifest} from '../bridge/core-transferable/mainnet-config.mjs';
import {PRIVATE_TEST_POLICY,WALLET_TEST_POLICY} from '../bridge/core-transferable/private-test.mjs';
import {canonical,digest,commitment} from '../bridge/core-transferable/records.mjs';
import {addresses,decodePosition} from '../bridge/core-transferable/sdk.mjs';
import {createRuntimeHttpClient} from '../bridge/core-transferable/runtime-api.mjs';
import {createSolanaAdapter} from '../bridge/core-transferable/solana-adapter.mjs';
const need=(v,m)=>{if(!v)throw Error(m);},raw=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&BigInt(v)<=1000000000000000n;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const privateBuild=typeof __XMR20_JOINT_PRIVATE_TEST__!=='undefined'&&__XMR20_JOINT_PRIVATE_TEST__;
const walletTestBuild=typeof __XMR20_JOINT_WALLET_TEST__!=='undefined'&&__XMR20_JOINT_WALLET_TEST__;
export const isJointHolding=row=>row?.bridge==='joint-v3';
export function replaceHoldingSource(rows,incoming,{network,bridge}={}){return [...rows.filter(r=>bridge?!(isJointHolding(r)&&r.mint===bridge):r.network!==network||isJointHolding(r)),...incoming];}
export function jointHoldingRow(report,account,asset,{privateTest=false,walletTest=false,now=Date.now()}={}){
 const manifest=transferableManifest(asset.mint),policy=walletTest?WALLET_TEST_POLICY:privateTest?PRIVATE_TEST_POLICY:null;
 need(report?.schema==='joint-index-v3'&&report.complete===true&&canonical(report.manifest)===canonical(manifest)&&canonical(report.privateTestPolicy??null)===canonical(policy)&&Array.isArray(report.positions)&&Array.isArray(report.accepted),'Complete verified bridge history required.');
 if(privateTest&&!walletTest)need(account.sol===policy.owner&&account.xmr===policy.moneroOwner&&asset.mint===policy.mint,'Wrong private test account.');
 const config={...manifest,owner:account.sol,binding:digest(account.xmr)},position=addresses(config).position.toBase58(),matches=report.positions.filter(p=>p.position===position||p.moneroOwner===account.xmr);
 need(matches.length<=1,'Duplicate bridge position.');const p=matches[0];if(!p)return null;
 need(p.position===position&&p.solanaOwner===account.sol&&p.moneroOwner===account.xmr&&['abi','network','program','mint','verifier','owner','binding'].every(k=>p.config?.[k]===config[k])&&hash(p.linkTxid),'Bridge balance belongs to another linked wallet.');
 need([p.available,p.balance,p.chainBalance].every(raw)&&p.available===(BigInt(p.balance)<=BigInt(p.chainBalance)?p.balance:'0'),'Unreconciled bridge balance.');
 const link=report.accepted.find(e=>e.txid===p.linkTxid&&e.envelope?.record?.op==='link'&&e.envelope.record.owner===account.xmr&&e.envelope.record.to===account.sol&&e.envelope.record.program===manifest.program&&e.envelope.record.mint===asset.mint);
 need(link,'Confirmed Monero link missing.');if(p.available==='0')return null;
 const latest=report.accepted.filter(e=>hash(e.txid)&&e.envelope?.record?.mint===asset.mint&&e.envelope.record.program===manifest.program&&(e.envelope.record.op==='credit'&&e.envelope.record.owner===account.xmr||e.envelope.record.op==='transfer'&&e.envelope.record.to===account.xmr)).at(-1);
 need(latest,'Confirmed Monero credit missing.');
 return {id:'joint-v3:'+asset.mint+':'+position,bridge:'joint-v3',network:'monero',mint:asset.mint,name:asset.name,ticker:asset.symbol,program:manifest.program,position,moneroOwner:account.xmr,solanaOwner:account.sol,amountRaw:p.available,chainBalance:p.chainBalance,linkTxid:p.linkTxid,receipt:{url:'https://xmrchain.net/tx/'+latest.txid,label:'View Monero record'},checkedAt:now,stale:false};
}
export function createJointHoldings({privateTest=privateBuild,walletTest=walletTestBuild,fetcher=fetch,storage=globalThis.localStorage,now=Date.now,adapters,ttl=60000}={}){
 privateTest=privateTest||walletTest;
 const {endpoint,rpcEndpoint}=jointService({privateTest,walletTest}),entries=new Map();
 const key=(a,mint)=>'xmr20-joint-holdings-v3:'+transferableManifest(mint).program+':'+mint+':'+a.sol+':'+digest(a.xmr);
 function assets(a,rows){if(!a?.sol||!a?.xmr||privateTest&&!walletTest&&(a.sol!==PRIVATE_TEST_POLICY.owner||a.xmr!==PRIVATE_TEST_POLICY.moneroOwner))return [];const known=[...rows,...savedJointAssets(storage)],mints=new Set([PRIVATE_TEST_POLICY.mint,...known.map(r=>r.mint)]);return discoveredAssets(known).filter(v=>v.key!=='previous-xcat'&&mints.has(v.mint)&&(!privateTest||walletTest||v.mint===PRIVATE_TEST_POLICY.mint));}
 function cached(a,asset){try{const v=JSON.parse(storage?.getItem(key(a,asset.mint))??'null');if(!v||v.savedAt>now()||now()-v.savedAt>86400000||v.sol!==a.sol||v.xmr!==a.xmr||v.mint!==asset.mint)return null;const row=jointHoldingRow(v.report,a,asset,{privateTest,walletTest,now:v.savedAt});return row?{...row,stale:true}:null;}catch{return null;}}
 async function read(a,asset,signal){
  const manifest=transferableManifest(asset.mint),policy=walletTest?WALLET_TEST_POLICY:privateTest?PRIVATE_TEST_POLICY:undefined;
  const runtime=adapters?.runtime?.(asset,{signal})??createRuntimeHttpClient({endpoint:'/api/joint-transferable/'+asset.mint,fetcher:(p,o)=>fetcher(endpoint+p,o),signal});
  const chain=adapters?.chain?.(asset,{signal})??createSolanaAdapter({connection:new Connection(rpcEndpoint,{commitment:'finalized',fetch:(url,o)=>fetcher(url,{...o,signal})}),manifest,privateTestPolicy:policy});
  // A finalized empty custody account cannot contain a spendable bridge balance.
  // Avoid a full native-history scan for every Solana token the wallet owns.
  const position=addresses({...manifest,owner:a.sol,binding:digest(a.xmr)}).position.toBase58();
  const [,custody]=await Promise.all([chain.verifyProgram(),chain.readAccount(position)]);need(!signal.aborted,'Balance refresh cancelled.');
  if(custody){
   need(custody.finalized===true&&custody.owner===manifest.program&&!custody.executable,'Finalized bridge custody unavailable.');
   const p=decodePosition(custody.data);need(p.owner===a.sol&&p.verifier===manifest.verifier&&p.mint===asset.mint&&p.binding===digest(a.xmr),'Bridge custody belongs to another linked wallet.');
  }
  if(custody===null||decodePosition(custody.data).balance==='0'){
   try{storage?.setItem(key(a,asset.mint),JSON.stringify({sol:a.sol,xmr:a.xmr,mint:asset.mint,savedAt:now(),empty:true}));}catch{}
   return null;
  }
  const report=await runtime.snapshot();need(!signal.aborted,'Balance refresh cancelled.');
  const row=jointHoldingRow(report,a,asset,{privateTest,walletTest,now:now()});
  if(row){const value=await chain.readAccount(row.position);need(value?.finalized===true&&value.owner===manifest.program&&!value.executable,'Finalized bridge custody unavailable.');const p=decodePosition(value.data);need(p.owner===a.sol&&p.verifier===manifest.verifier&&p.mint===asset.mint&&p.binding===digest(a.xmr)&&p.balance===row.chainBalance&&p.linkProof===commitment(report.accepted.find(e=>e.txid===row.linkTxid).envelope),'Bridge custody changed; refresh again.');}
  need(!signal.aborted,'Balance refresh cancelled.');try{storage?.setItem(key(a,asset.mint),JSON.stringify({sol:a.sol,xmr:a.xmr,mint:asset.mint,savedAt:now(),report}));}catch{/* Display cache is optional and never authorizes spending. */}
  return row;
 }
 return {
  cached(account,rows=[]){return assets(account,rows).map(asset=>cached(account,asset)).filter(Boolean);},
  async load(account,rows=[],{force=false,onResult=()=>{}}={}){
   const a={sol:account.sol,xmr:account.xmr},results=[];
   const queue=assets(a,rows);
   await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(queue.length){const asset=queue.shift();
    const id=key(a,asset.mint);let e=entries.get(id);
    if(!e){e={attempt:-Infinity,value:null};entries.set(id,e);}
    if(!e.pending&&now()-e.attempt>=(force?5000:ttl)){
     e.attempt=now();e.abort=new AbortController();const signal=e.abort.signal;
     e.pending=read(a,asset,signal).then(row=>e.value={mint:asset.mint,rows:row?[row]:[],complete:true}).catch(()=>e.value={mint:asset.mint,rows:[cached(a,asset)].filter(Boolean),complete:false}).finally(()=>{e.attempt=now();e.pending=null;});
    }
    if(e.pending)await e.pending;
    const result=e.value??{mint:asset.mint,rows:[],complete:false};results.push(result);onResult(result);
   }}));
   return {rows:results.flatMap(r=>r.rows),complete:results.every(r=>r.complete)};
  },
  clear(){for(const e of entries.values())e.abort?.abort();entries.clear();}
 };
}
