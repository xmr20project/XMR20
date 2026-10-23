import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3.js';
import * as website from '../src/wallet-holdings.js';
import * as extension from '../../src/holdings.js';
// Checksum-valid synthetic public address, unrelated to any real account.
const body=Uint8Array.from([18,...Array(64).fill(2)]),bytes=Uint8Array.from([...body,...keccak_256(body).slice(0,4)]),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let ADDRESS='';for(let i=0;i<bytes.length;i+=8){const block=bytes.slice(i,i+8);let n=0n;for(const v of block)n=(n<<8n)+BigInt(v);let s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}ADDRESS+=s.padStart(block.length===8?11:7,'1');}
const fixture=()=>({schema:'xmr20-wallet-holdings-v1',address:ADDRESS,network:'monero',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',source:'independent-verified',maxSnapshotAgeMs:600000,complete:true,checked:Date.now()-240000,revision:1,nextCursor:null,rows:[{id:'11111111-1111-1111-1111-111111111111',mint:'So11111111111111111111111111111111111111112',ticker:'TEST',name:'Test token',deployment:'ab'.repeat(32),listed:true,stale:false,amountRaw:'2240000000000',checkedAt:Date.now()-240000}]});
for(const [name,client] of [['website',website],['extension',extension]]){
 test(name+' accepts only the independent reader’s bounded freshness window',()=>{
  const data=fixture(),result=client.validateWalletHoldings(data,ADDRESS);assert.equal(result.complete,true);assert.equal(result.rows[0].stale,false);assert.equal(result.maxSnapshotAgeMs,600000);
  delete data.source;delete data.maxSnapshotAgeMs;assert.equal(client.validateWalletHoldings(data,ADDRESS).complete,false);
  for(const change of [{source:'other',maxSnapshotAgeMs:600000},{source:'independent-verified',maxSnapshotAgeMs:Infinity},{source:'independent-verified',maxSnapshotAgeMs:600001}])assert.throws(()=>client.validateWalletHoldings({...fixture(),...change},ADDRESS),/freshness/);
 });
 test(name+' retains explicit stale/error status and expiration',()=>{
  const data=fixture();data.rows[0].stale=true;assert.equal(client.validateWalletHoldings(data,ADDRESS).complete,false);
  data.rows[0].stale=false;data.rows[0].checkedAt=Date.now()-600001;assert.equal(client.validateWalletHoldings(data,ADDRESS).complete,false);
  data.rows[0].checkedAt=Date.now();data.complete=false;assert.equal(client.validateWalletHoldings(data,ADDRESS).complete,false);
 });
 test(name+' preserves source policy through loading and saved display cache',async()=>{
  const data=fixture();const loaded=await client.loadWalletHoldings(ADDRESS,{fetcher:async()=>({ok:true,json:async()=>data})});assert.equal(loaded.complete,true);assert.equal(loaded.rows[0].amountRaw,'2240000000000');assert.equal(loaded.source,'independent-verified');
  const values=new Map(),storage={setItem:(key,value)=>values.set(key,value),getItem:key=>values.get(key)};
  client.cacheWalletHoldings(ADDRESS,loaded,{storage});const cached=client.cachedWalletHoldings(ADDRESS,{storage});assert.equal(cached.source,'independent-verified');assert.equal(cached.rows[0].amountRaw,'2240000000000');assert.equal(cached.rows[0].stale,true);assert.equal(cached.complete,false);
 });
}
