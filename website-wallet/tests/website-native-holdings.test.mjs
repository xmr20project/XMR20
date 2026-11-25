// Display-only Monero tab records; synthetic public values and an in-memory storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {saveNativeDisplay,nativeDisplay,recordNativeBridge,pendingNativeBridges} from '../src/website-native-holdings.js';

const configuration={manifestId:'11'.repeat(32),chainGenesis:'22'.repeat(32),manifest:{cap:1000000000000000n},backing:{mint:'Mint1111111111111111111111111111111111111'},
 display:{mint:'Mint1111111111111111111111111111111111111',name:'Monero Extremist',symbol:'EXTREMIST'}};
const address='4'+'A'.repeat(94),other='4'+'B'.repeat(94);
const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),map:m};};
const checkpoint={ready:true,height:'3790000',checkpoint:'33'.repeat(32)};
const row=(n,quantity,held=false)=>({source:{txid:String(n).repeat(64).slice(0,64),vout:0},quantity,held});

test('a synced inventory is saved per wallet and read back as the Monero balance',()=>{
 const storage=memory();
 const saved=saveNativeDisplay({address,inventory:[row(1,'100000000000'),row(2,'5000000')],checkpoint,configuration,storage,now:1000});
 assert.equal(saved.amountRaw,'100005000000');
 assert.equal(nativeDisplay(address,{configuration,storage,now:2000}).amountRaw,'100005000000');
 assert.equal(nativeDisplay(other,{configuration,storage,now:2000}),null,'another wallet never sees it');
 assert.throws(()=>saveNativeDisplay({address,inventory:[],checkpoint:{...checkpoint,ready:false},configuration,storage}),/Synced native inventory/);
});
test('a bridge is pending from approval through confirmations and never moves backwards',()=>{
 const storage=memory(),opts=now=>({configuration,storage,now});
 assert.ok(recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'100000000000',stage:'solana'},opts(1000)));
 assert.ok(recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'100000000000',stage:'sending',txid:'ab'.repeat(32)},opts(2000)));
 assert.ok(recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'100000000000',stage:'confirming',txid:'ab'.repeat(32),confirmations:4,required:10},opts(3000)));
 recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'100000000000',stage:'building'},opts(4000));
 const [e]=pendingNativeBridges(address,opts(5000));
 assert.deepEqual([e.stage,e.confirmations,e.required,e.txid,e.startedAt],['confirming',4,10,'ab'.repeat(32),1000]);
 assert.equal(recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'1',stage:'confirmed'},opts(6000)),false,'amount cannot change');
 assert.equal(recordNativeBridge(address,{preparationId:'<bad>',amountRaw:'1',stage:'solana'},opts(6000)),false);
 assert.equal(pendingNativeBridges(other,opts(5000)).length,0);
});
test('an arrived bridge stays visible until a newer balance includes it, and old entries expire',()=>{
 const storage=memory(),opts=now=>({configuration,storage,now});
 recordNativeBridge(address,{preparationId:'prep-1',amountRaw:'100000000000',stage:'confirmed',txid:'ab'.repeat(32)},opts(10000));
 assert.equal(pendingNativeBridges(address,opts(11000))[0].stage,'confirmed');
 saveNativeDisplay({address,inventory:[row(1,'100000000000')],checkpoint,configuration,storage,now:12000});
 assert.equal(pendingNativeBridges(address,opts(13000)).length,0,'included in the saved balance');
 recordNativeBridge(address,{preparationId:'prep-2',amountRaw:'5',stage:'solana'},opts(20000));
 assert.equal(pendingNativeBridges(address,opts(20000+3*86400000)).length,0,'expired after three days');
});
test('a bridge to Solana keeps its direction through status updates and only uses Monero-side stages',()=>{
 const storage=memory(),opts=now=>({configuration,storage,now}),id='solana:'+'cd'.repeat(32);
 assert.ok(recordNativeBridge(address,{preparationId:id,amountRaw:'250000000000',stage:'sending',txid:'cd'.repeat(32),to:'solana'},opts(1000)));
 // The Monero tab's status poll does not repeat the direction; it must stay a bridge to Solana.
 assert.ok(recordNativeBridge(address,{preparationId:id,amountRaw:'250000000000',stage:'confirming',txid:'cd'.repeat(32),confirmations:6,required:10},opts(2000)));
 const [e]=pendingNativeBridges(address,opts(3000));
 assert.deepEqual([e.to,e.stage,e.confirmations,e.startedAt],['solana','confirming',6,1000]);
 assert.equal(recordNativeBridge(address,{preparationId:'solana:x',amountRaw:'1',stage:'solana',to:'solana'},opts(3000)),false,'no Solana-side stage for a bridge out');
 assert.equal(recordNativeBridge(address,{preparationId:'solana:y',amountRaw:'1',stage:'sending',to:'ethereum'},opts(3000)),true,'an unknown direction is not stored');
 assert.equal(pendingNativeBridges(address,opts(3000)).find(x=>x.preparationId==='solana:y').to,undefined);
 recordNativeBridge(address,{preparationId:id,amountRaw:'250000000000',stage:'confirmed',txid:'cd'.repeat(32)},opts(4000));
 saveNativeDisplay({address,inventory:[row(1,'100000000000')],checkpoint,configuration,storage,now:5000});
 assert.equal(pendingNativeBridges(address,opts(6000)).some(x=>x.preparationId===id),false,'hidden once a newer balance check exists');
});
test('a token send to another Monero address is recorded the same way, with its own direction',()=>{
 const storage=memory(),opts=now=>({configuration,storage,now}),id='send:'+'ef'.repeat(32);
 assert.ok(recordNativeBridge(address,{preparationId:id,amountRaw:'1500000000',stage:'sending',txid:'ef'.repeat(32),to:'address'},opts(1000)));
 assert.ok(recordNativeBridge(address,{preparationId:id,amountRaw:'1500000000',stage:'confirmed',txid:'ef'.repeat(32)},opts(2000)));
 assert.deepEqual(pendingNativeBridges(address,opts(3000)).map(e=>[e.to,e.stage]),[['address','confirmed']]);
 assert.equal(recordNativeBridge(address,{preparationId:'send:x',amountRaw:'1',stage:'building',to:'address'},opts(3000)),false,'no bridge-only stage for a send');
});
