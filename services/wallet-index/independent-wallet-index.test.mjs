import test from 'node:test';
import assert from 'node:assert/strict';
import {independentWalletIndex,publicIndexFetch} from './independent-wallet-index.mjs';
import {EventEmitter} from 'node:events';
const ADDRESS='47pzp5x7pmRZSB56hAfg7kA52dsuFVsBth3xHPab7PDE41yyUCYhCNXSxEsMxChDesXs5kFAj93NAFCdRJDmsSfnEHGenLv';
const ID='52f787ff-fe1d-4067-a492-0586d0d44010',DEPLOY='ab'.repeat(32),MINT='So11111111111111111111111111111111111111112',TIME=1791786719089;
const TOKEN={id:ID,moneroTxid:DEPLOY,mint:MINT,ticker:'XMR20',name:'XMR20',listed:true,proofVerified:true,solanaFinalized:true,moneroNetwork:'mainnet',confirmations:10};
const row=()=>({id:DEPLOY,deployment:DEPLOY,mint:MINT,stale:false,amountRaw:'2240000000000',checkedAt:TIME});
const envelope=(address=ADDRESS,network='monero')=>({schema:'xmr20-wallet-holdings-v1',address,network,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',complete:true,revision:TIME,checked:TIME,rows:[row()],nextCursor:null});
function fixture({data=envelope(),tokens=[TOKEN],now=()=>TIME}={}){
 const calls=[];let fail=false;
 const fetcher=async(url,options)=>{calls.push({url,options});if(fail)throw Error('offline');return {ok:true,json:async()=>structuredClone(url.includes('/api/xmr20/tokens')?{schema:'xmr20-launches-v1',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',tokens}:data)};};
 return {reader:independentWalletIndex({fetcher,now}),calls,offline(){fail=true;}};
}
test('confirmed incoming balance maps back to its original wallet launch ID with exact units',async()=>{
 const f=fixture();const data=await f.reader.read(ADDRESS);
 assert.equal(data.source,'independent-verified');assert.equal(data.complete,true);assert.equal(data.rows[0].id,ID);assert.equal(data.rows[0].deployment,DEPLOY);assert.equal(data.rows[0].amountRaw,'2240000000000');assert.equal(data.rows[0].listed,true);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.options.credentials==='omit'&&c.options.redirect==='error'&&c.options.cache==='no-store'));
 await f.reader.read(ADDRESS);assert.equal(f.calls.length,2);
});
test('source/mint/deployment mismatches and incomplete or expired snapshots fail closed',async()=>{
 for(const mutate of [d=>d.rows[0].mint='11111111111111111111111111111111',d=>d.rows[0].id='cd'.repeat(32),d=>d.rows[0].amountRaw='1e9',d=>d.complete='yes',d=>d.rows[0].stale='yes',d=>d.checked=TIME-86400001,d=>d.address='wrong']){
  const data=envelope();mutate(data);await assert.rejects(fixture({data}).reader.read(ADDRESS),/Verified wallet index unavailable/);
 }
 await assert.rejects(fixture({tokens:[TOKEN,TOKEN]}).reader.read(ADDRESS),/Verified wallet index unavailable/);
});
test('a delayed independent refresh still imports its latest verified transfer as last-known, never as fresh',async()=>{
 const data=envelope();data.complete=false;data.rows[0].stale=true;
 const result=await fixture({data}).reader.read(ADDRESS);assert.equal(result.rows[0].amountRaw,'2240000000000');assert.equal(result.rows[0].stale,true);assert.equal(result.complete,false);
});
test('empty complete recipient and native Solana query remain distinct',async()=>{
 const data=envelope();data.rows=[];const result=await fixture({data}).reader.read(ADDRESS);assert.deepEqual(result.rows,[]);assert.equal(result.complete,true);
 const address='11111111111111111111111111111111',f=fixture({data:envelope(address,'solana')});const sol=await f.reader.read(address,{network:'solana'});assert.equal(sol.network,'solana');assert.match(f.calls[1].url,/network=solana/);
 await assert.rejects(f.reader.read(address,{network:'other'}),/Invalid wallet lookup/);
});
test('after a fresh debit, an outage preserves that newer balance rather than resurrecting old funds',async()=>{
 let now=TIME;const f=fixture({now:()=>now});await f.reader.read(ADDRESS);now+=16000;f.offline();const result=await f.reader.read(ADDRESS);
 assert.equal(result.rows[0].amountRaw,'2240000000000');assert.equal(result.rows[0].stale,true);assert.equal(result.complete,false);
});
test('pagination retains wallet UUID ordering and rejects a changed revision',async()=>{
 const f=fixture();const data=await f.reader.read(ADDRESS);const end=await f.reader.read(ADDRESS,{after:ID,revision:data.revision});assert.deepEqual(end.rows,[]);assert.equal(end.nextCursor,null);
 await assert.rejects(f.reader.read(ADDRESS,{revision:data.revision+1}),e=>e.status===409);
 await assert.rejects(f.reader.read(ADDRESS,{after:DEPLOY}),/Invalid wallet lookup/);
});
test('unknown or unverified deployment cannot be used as a wallet balance',async()=>{
 await assert.rejects(fixture({tokens:[{...TOKEN,proofVerified:false}]}).reader.read(ADDRESS),/Verified wallet index unavailable/);
 const data=envelope();data.rows[0].receipt={url:'https://xmrchain.net/tx/'+'ef'.repeat(32),label:'Latest incoming transfer',confirmations:10};assert.equal((await fixture({data}).reader.read(ADDRESS)).rows[0].receipt.confirmations,10);
 data.rows[0].receipt.confirmations=9;await assert.rejects(fixture({data}).reader.read(ADDRESS),/Verified wallet index unavailable/);
});
test('concurrent identical wallet reads share a single public lookup',async()=>{
 const f=fixture();const values=await Promise.all([f.reader.read(ADDRESS),f.reader.read(ADDRESS)]);assert.deepEqual(values[0],values[1]);assert.equal(f.calls.length,2);
});
test('public transport pins index hosts, omits credentials, uses IPv4 and preserves TLS defaults',async()=>{
 let options;
 const stub=(url,opts,callback)=>{
  options=opts;assert.equal(url.hostname,'indexer2.xmr20.org');const req=new EventEmitter();
  req.end=()=>{const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',Buffer.from('{"complete":true}'));response.emit('end');};return req;
 };
 const response=await publicIndexFetch('https://indexer2.xmr20.org/health',{},stub);assert.deepEqual(await response.json(),{complete:true});assert.equal(options.family,4);assert.equal(options.rejectUnauthorized,undefined);assert.equal(options.headers.Authorization,undefined);
 for(const url of ['http://indexer2.xmr20.org/health','https://elsewhere.example/health','https://user:secret@indexer2.xmr20.org/health'])assert.throws(()=>publicIndexFetch(url,{},stub),/Verified wallet index unavailable/);
});
