import {createHash,randomUUID} from 'node:crypto';
import {request as httpsRequest,Agent} from 'node:https';
import {PublicKey} from '@solana/web3.js';

const PRIMARY='https://api.xmr20.org/api/xmr20/tokens';
const INDEPENDENT='https://indexer2.xmr20.org/api/wallet-holdings';
const INDEPENDENT_CATALOG='https://indexer2.xmr20.org/api/xmr20/tokens';
const UUID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/,SOL=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Match the independent reader's published, bounded snapshot-age policy.
const MAX_AGE=600000;
const DISPLAY_MAX_AGE=86400000;
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),TOKEN_2022=new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const fail=()=>{throw Error('Verified wallet index unavailable');};
const eligible=r=>r&&!r.hidden&&!r.halted&&!r.cancelledAt&&UUID.test(r.id)&&HASH.test(r.moneroTxid)&&SOL.test(r.mint)&&r.proofVerified===true&&r.solanaFinalized===true&&r.moneroNetwork==='mainnet'&&r.confirmations>=10;
// A launch is held on Solana once its mint is finalized. Monero proof and bridge
// readiness flags never hide a finalized Solana balance (the extension's rule).
const launched=r=>r&&!r.hidden&&!r.halted&&!r.cancelledAt&&UUID.test(r.id)&&HASH.test(r.moneroTxid)&&SOL.test(r.mint)&&r.solanaFinalized===true&&r.moneroNetwork==='mainnet'&&typeof r.ticker==='string'&&r.ticker.length>0&&r.ticker.length<=10&&typeof r.name==='string'&&r.name.length<=256;
const associated=(owner,mint,program)=>PublicKey.findProgramAddressSync([owner.toBuffer(),program.toBuffer(),mint.toBuffer()],ATA)[0];
function account(value){
 if(value===null)return null;
 if(!value||typeof value.owner!=='string'||!Array.isArray(value.data)||value.data[1]!=='base64'||typeof value.data[0]!=='string'||value.data[0].length>32768)fail();
 const data=Buffer.from(value.data[0],'base64');if(data.toString('base64')!==value.data[0])fail();
 return {owner:value.owner,data};
}
// Exact finalized SPL/Token-2022 layouts: initialized six-decimal mint, and the
// owner's associated account for that mint under the mint's own program.
function finalizedBalance([mintValue,classicValue,extendedValue],[mint],owner){
 const info=account(mintValue);if(!info)fail();
 const program=info.owner===TOKEN.toBase58()?TOKEN:info.owner===TOKEN_2022.toBase58()?TOKEN_2022:null;if(!program)fail();
 const m=info.data;if(m.length<82||m[44]!==6||m[45]!==1||m.length>82&&!(program===TOKEN_2022&&m.length>165&&m[165]===1))fail();
 const holding=account(program===TOKEN?classicValue:extendedValue);if(!holding)return 0n;
 const d=holding.data;
 if(holding.owner!==program.toBase58()||d.length<165||d.length>165&&!(program===TOKEN_2022&&d[165]===2)||d[108]===0)fail();
 if(!new PublicKey(d.subarray(0,32)).equals(mint)||!new PublicKey(d.subarray(32,64)).equals(owner))fail();
 const amount=d.readBigUInt64LE(64);if(amount>1000000000000000n)fail();
 return amount;
}
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
// solanaRpc is the wallet service's existing finalized Helius reader. With it,
// Solana reads also cover launches the independent reader does not track.
export function independentWalletIndex({fetcher=publicIndexFetch,now=Date.now,timeoutMs=4500,listed=tokens=>new Set(tokens.filter(t=>t.listed===true).map(t=>t.id)),solanaRpc=null,directTimeoutMs=6000}={}){
 let catalog=null,catalogAt=0,catalogFlight=null,tracked=null,trackedAt=0,genesisAt=0;
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
   // Direct-read candidates; an ambiguous mint or record is skipped, not guessed.
   const candidates=data.tokens.filter(launched),count=key=>{const n=new Map();for(const r of candidates)n.set(r[key],(n.get(r[key])||0)+1);return n;};
   const byMint=count('mint'),byId=count('id'),byDeployment=count('moneroTxid');
   const direct=candidates.filter(r=>byMint.get(r.mint)===1&&byId.get(r.id)===1&&byDeployment.get(r.moneroTxid)===1).map(r=>({...r,listed:listedIds.has(r.id)}));
   catalog={map,direct};catalogAt=now();return catalog;
  })();
  try{return await catalogFlight;}finally{catalogFlight=null;}
 }
 // Deployments whose holders the independent reader publishes.
 async function independentDeployments(signal){
  if(tracked&&now()-trackedAt<30000)return tracked;
  const data=await get(INDEPENDENT_CATALOG,signal);
  if(data?.schema!=='xmr20-launches-v1'||data.moneroNetwork!=='mainnet'||data.solanaNetwork!=='mainnet-beta'||!Array.isArray(data.tokens)||data.tokens.length>10000)fail();
  tracked=new Set(data.tokens.filter(t=>t?.state==='discovered'&&t.bridgeReady===true&&HASH.test(t.moneroTxid)).map(t=>t.moneroTxid));trackedAt=now();return tracked;
 }
 async function rpc(method,params){
  const id=randomUUID(),value=await solanaRpc({jsonrpc:'2.0',id,method,params});
  if(value?.jsonrpc!=='2.0'||value.id!==id||value.error||!Object.hasOwn(value,'result'))fail();return value.result;
 }
 // Untracked launches are read directly at finalized commitment. Any failure
 // leaves the result incomplete instead of hiding the independent rows.
 async function untracked(address,tokens,signal){
  const owner=new PublicKey(address),rows=[];let complete=true;
  if(!tokens.length)return {rows,complete};
  if(now()-genesisAt>=600000){if(await rpc('getGenesisHash',[])!==GENESIS)fail();genesisAt=now();}
  for(let start=0;start<tokens.length;start+=30){
   signal.throwIfAborted();
   const batch=tokens.slice(start,start+30),keys=batch.flatMap(t=>{const mint=new PublicKey(t.mint);return [mint,associated(owner,mint,TOKEN),associated(owner,mint,TOKEN_2022)];});
   let reply;try{reply=await rpc('getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'finalized'}]);}catch{complete=false;continue;}
   if(!Number.isSafeInteger(reply?.context?.slot)||!Array.isArray(reply.value)||reply.value.length!==keys.length){complete=false;continue;}
   batch.forEach((token,i)=>{
    try{const amount=finalizedBalance(reply.value.slice(3*i,3*i+3),keys.slice(3*i,3*i+3),owner);if(amount>0n)rows.push({token,amountRaw:String(amount),checkedAt:now()});}
    catch{complete=false;}
   });
  }
  return {rows,complete};
 }
 async function load(address,network){
  const signal=AbortSignal.timeout(timeoutMs),{map,direct:candidates}=await bindings(signal),rows=[];
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
    let direct=true;
    if(network==='solana'&&solanaRpc){
     try{
      const known=await independentDeployments(signal),seen=new Set(rows.map(r=>r.mint));
      let timer;const result=await Promise.race([untracked(address,candidates.filter(t=>!known.has(t.moneroTxid)&&!seen.has(t.mint)),signal),
       new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Direct Solana read timed out')),directTimeoutMs);})]).finally(()=>clearTimeout(timer));
      direct=result.complete;
      for(const {token,amountRaw,checkedAt} of result.rows)rows.push({id:token.id,mint:token.mint,ticker:token.ticker,name:token.name,deployment:token.moneroTxid,listed:token.listed,amountRaw,checkedAt,stale:false,receipt:null});
     }catch{direct=false;}
    }
    rows.sort((a,b)=>a.id.localeCompare(b.id));if(new Set(rows.map(r=>r.id)).size!==rows.length)fail();
    const binding=[revision,...rows.map(r=>[r.id,r.mint,r.deployment,r.amountRaw])];
    const version=parseInt(createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0,12),16);
    return {schema:'xmr20-wallet-holdings-v1',address,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',revision:version,checked,checkedAt:checked,complete:data.complete&&direct&&now()-checked<=MAX_AGE&&!rows.some(r=>r.stale),source:'independent-verified',maxSnapshotAgeMs:MAX_AGE,rows};
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
