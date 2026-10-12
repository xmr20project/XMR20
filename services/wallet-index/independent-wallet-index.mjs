import {createHash} from 'node:crypto';
import {request as httpsRequest,Agent} from 'node:https';

const PRIMARY='https://api.xmr20.org/api/xmr20/tokens';
const INDEPENDENT='https://indexer2.xmr20.org/api/wallet-holdings';
const UUID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/,SOL=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Match the independent reader's published, bounded snapshot-age policy.
const MAX_AGE=600000;
const DISPLAY_MAX_AGE=86400000;
const fail=()=>{throw Error('Verified wallet index unavailable');};
const eligible=r=>r&&!r.hidden&&!r.halted&&!r.cancelledAt&&UUID.test(r.id)&&HASH.test(r.moneroTxid)&&SOL.test(r.mint)&&r.proofVerified===true&&r.solanaFinalized===true&&r.moneroNetwork==='mainnet'&&r.confirmations>=10;
const agent=new Agent({keepAlive:true,maxSockets:12,maxFreeSockets:4});
// Dedicated public reads use IPv4 to avoid waiting on an unavailable IPv6 route.
// TLS verification and the fixed pair of index hosts remain mandatory.
export function publicIndexFetch(url,{signal}={},requestImpl=httpsRequest){
 const target=new URL(url);
 if(target.protocol!=='https:'||!['api.xmr20.org','indexer2.xmr20.org'].includes(target.hostname)||target.username||target.password||target.port||target.hash)fail();
 return new Promise((resolve,reject)=>{
  const request=requestImpl(target,{method:'GET',family:4,agent,signal,headers:{Accept:'application/json','Cache-Control':'no-cache'}},response=>{
   const body=new Promise((done,error)=>{
    const chunks=[];let size=0;
    response.on('data',chunk=>{size+=chunk.length;if(size>5000000){response.destroy(Error('Public index response too large'));return;}chunks.push(chunk);});
    response.on('end',()=>done(Buffer.concat(chunks).toString('utf8')));response.on('error',error);
   });
   // Observe failures even when a non-success status is rejected before json().
   body.catch(()=>{});
   resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>JSON.parse(await body)});
  });
  request.on('error',reject);request.end();
 });
}

// Read-only adapter: keep the wallet's launch UUIDs while binding the independent
// reader's chain-discovered deployment IDs to the same mint and Monero record.
export function independentWalletIndex({fetcher=publicIndexFetch,now=Date.now,timeoutMs=4500,listed=tokens=>new Set(tokens.filter(t=>t.listed===true).map(t=>t.id))}={}){
 let catalog=null,catalogAt=0,catalogFlight=null;
 const cache=new Map(),flights=new Map();
 async function get(url,signal){
  const response=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal});
  if(!response.ok)fail();return response.json();
 }
 async function bindings(signal){
  if(catalog&&now()-catalogAt<30000)return catalog;
  if(catalogFlight)return catalogFlight;
  catalogFlight=(async()=>{
   const data=await get(PRIMARY,signal);
   if(data?.schema!=='xmr20-launches-v1'||data.moneroNetwork!=='mainnet'||data.solanaNetwork!=='mainnet-beta'||!Array.isArray(data.tokens)||data.tokens.length>10000)fail();
   const map=new Map(),ids=new Set(),listedIds=listed(data.tokens);
   for(const row of data.tokens.filter(eligible)){
    if(map.has(row.moneroTxid)||ids.has(row.id))fail();
    map.set(row.moneroTxid,{...row,listed:listedIds.has(row.id)});ids.add(row.id);
   }
   catalog=map;catalogAt=now();return map;
  })();
  try{return await catalogFlight;}finally{catalogFlight=null;}
 }
 async function load(address,network){
  const signal=AbortSignal.timeout(timeoutMs),map=await bindings(signal),rows=[];
  let after='',revision=null,checked=null;
  for(let page=0;page<100;page++){
   const query=new URLSearchParams({address,network});
   if(after){query.set('after',after);query.set('revision',String(revision));}
   const data=await get(INDEPENDENT+'?'+query,signal);
   if(data?.schema!=='xmr20-wallet-holdings-v1'||data.address!==address||data.network!==network||data.moneroNetwork!=='mainnet'||data.solanaNetwork!=='mainnet-beta'||typeof data.complete!=='boolean'||!Number.isSafeInteger(data.revision)||!Number.isSafeInteger(data.checked)||!Array.isArray(data.rows)||data.rows.length>100||now()-data.checked>DISPLAY_MAX_AGE||data.checked>now()+60000)fail();
   if(revision!==null&&(revision!==data.revision||checked!==data.checked))fail();
   revision=data.revision;checked=data.checked;
   for(const row of data.rows){
    const token=map.get(row.deployment);
    if(!HASH.test(row.id)||row.id!==row.deployment||!token||token.mint!==row.mint||typeof row.stale!=='boolean'||!Number.isSafeInteger(row.checkedAt)||row.checkedAt!==checked||typeof row.amountRaw!=='string'||!/^\d{1,16}$/.test(row.amountRaw)||BigInt(row.amountRaw)<1n||BigInt(row.amountRaw)>1000000000000000n||typeof token.ticker!=='string'||token.ticker.length>10||typeof token.name!=='string'||token.name.length>256)fail();
    let receipt=null;
    if(row.receipt){
     const r=row.receipt;
     if(network!=='monero'||!/^https:\/\/xmrchain\.net\/tx\/[a-f0-9]{64}$/.test(r.url)||!['Latest bridge credit','Latest incoming transfer'].includes(r.label)||!Number.isSafeInteger(r.confirmations)||r.confirmations<10)fail();
     receipt={url:r.url,label:r.label,confirmations:r.confirmations};
    }
    rows.push({id:token.id,mint:token.mint,ticker:token.ticker,name:token.name,deployment:token.moneroTxid,listed:token.listed,amountRaw:row.amountRaw,checkedAt:row.checkedAt,stale:row.stale||!data.complete||now()-row.checkedAt>MAX_AGE,receipt});
   }
   if(data.nextCursor===null){
    rows.sort((a,b)=>a.id.localeCompare(b.id));if(new Set(rows.map(r=>r.id)).size!==rows.length)fail();
    const binding=[revision,...rows.map(r=>[r.id,r.mint,r.deployment,r.amountRaw])];
    const version=parseInt(createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0,12),16);
    return {schema:'xmr20-wallet-holdings-v1',address,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',revision:version,checked,checkedAt:checked,complete:data.complete&&now()-checked<=MAX_AGE&&!rows.some(r=>r.stale),source:'independent-verified',maxSnapshotAgeMs:MAX_AGE,rows};
   }
   if(!HASH.test(data.nextCursor)||!data.rows.length||data.nextCursor!==data.rows.at(-1).id||data.nextCursor<=after)fail();
   after=data.nextCursor;
  }
  fail();
 }
 return {async read(address,{network='monero',after='',revision=null,limit=100}={}){
  if(!['monero','solana'].includes(network)||typeof address!=='string'||!(network==='solana'?SOL:/^[1-9A-HJ-NP-Za-km-z]{95}$/).test(address)||after&&!UUID.test(after)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid wallet lookup');
  const key=network+':'+address;
  let entry=cache.get(key);
  if(!entry||now()-entry.savedAt>15000||now()-entry.data.checked>MAX_AGE){
   let task=flights.get(key);
   if(!task){task=load(address,network);flights.set(key,task);}
   try{const data=await task;entry={data,savedAt:now()};cache.set(key,entry);
    if(cache.size>1000)cache.delete(cache.keys().next().value);
   }catch(error){
    if(!entry)throw error;
    // A temporary outage must not resurrect older balances from the other reader.
    entry={...entry,data:{...entry.data,complete:false,rows:entry.data.rows.map(row=>({...row,stale:true}))}};
   }finally{if(flights.get(key)===task)flights.delete(key);}
  }
  const data=entry.data;
  if(revision!==null&&String(revision)!==String(data.revision)){const error=Error('Index updated; restart pagination');error.status=409;throw error;}
  const rows=data.rows.filter(row=>row.id>after);
  return {...data,rows:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
 }};
}
