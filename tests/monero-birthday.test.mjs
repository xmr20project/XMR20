import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolveWalletRestoreHeight} from '../src/monero-birthday.js';
import {MONERO_NODES} from '../src/monero-node.js';
import {encryptVault,decryptVault} from '../review/core.mjs';

const time=1792579000000,genesis='418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3',tip='ab'.repeat(32);
const info=()=>({status:'OK',mainnet:true,nettype:'mainnet',synchronized:true,offline:false,untrusted:false,height:3788900,target_height:0,top_block_hash:tip});
function reader({changeInfo=x=>x,changeHeader=x=>x,fail=()=>false}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});if(fail(url))throw TypeError('public fixture unavailable');
  if(url.endsWith('/get_info'))return Response.json(changeInfo(info(),url));
  const q=JSON.parse(options.body);assert.equal(q.method,'get_block_header_by_height');
  return Response.json({result:{status:'OK',untrusted:false,block_header:changeHeader({height:q.params.height,orphan_status:false,hash:q.params.height===0?genesis:tip,timestamp:time/1000},url)}});
 };
 return {fetchImpl,calls};
}
const lookup=options=>resolveWalletRestoreHeight({mode:'create',now:()=>time,...options});
test('new wallet uses own node first and saves a thirty-block birthday margin',async()=>{
 const r=reader();assert.equal(await lookup(r),3788870);assert.equal(r.calls.length,3);
 assert.ok(r.calls.every(c=>c.url.startsWith(MONERO_NODES[0].url+'/')));
 for(const c of r.calls){assert.equal(c.options.credentials,'omit');assert.equal(c.options.redirect,'error');assert.equal(c.options.cache,'no-store');}
});
test('unavailable own node falls back only to the next allowlisted node',async()=>{
 const r=reader({fail:url=>url.startsWith(MONERO_NODES[0].url)});assert.equal(await lookup(r),3788870);
 assert.equal(r.calls[0].url,MONERO_NODES[0].url+'/get_info');assert.ok(r.calls.slice(1).every(c=>c.url.startsWith(MONERO_NODES[1].url)));
});
test('invalid/deceptive heights and unhealthy or wrong networks cannot become birthdays',async()=>{
 for(const patch of [{height:0},{height:30},{height:'3788900'},{height:8000000},{height:Infinity},{height:1.5},{height:Number.MAX_SAFE_INTEGER+1},{mainnet:false},{nettype:'stagenet'},{synchronized:false},{offline:true},{untrusted:true},{status:'BUSY'},{target_height:3900000},{top_block_hash:'not-a-hash'}]){
  const r=reader({changeInfo:x=>({...x,...patch})});await assert.rejects(lookup(r),/Try again/);assert.equal(r.calls.length,3);
 }
});
test('genesis, tip identity, canonicality and timestamp are checked',async()=>{
 for(const changeHeader of [h=>({...h,hash:'cd'.repeat(32)}),h=>({...h,height:h.height+1}),h=>({...h,orphan_status:true}),h=>({...h,timestamp:time/1000+7201}),h=>({...h,timestamp:time/1000-7201})]){
  await assert.rejects(lookup(reader({changeHeader})),/Try again/);
 }
});
test('one bad node identity falls back rather than creating at height zero',async()=>{
 const r=reader({changeHeader:(h,url)=>url.startsWith(MONERO_NODES[0].url)?{...h,hash:'cd'.repeat(32)}:h});
 assert.equal(await lookup(r),3788870);assert.ok(r.calls.some(c=>c.url.startsWith(MONERO_NODES[1].url)));
});
test('complete outage and hung requests fail bounded and retryably',async()=>{
 await assert.rejects(lookup(reader({fail:()=>true})),/Try again to create your wallet/);
 let attempts=0;await assert.rejects(lookup({fetchImpl:()=>{attempts++;return new Promise(()=>{});},timeoutMs:5}),/Try again/);assert.equal(attempts,3);
});
test('oversized public node responses are rejected',async()=>{
 await assert.rejects(lookup({fetchImpl:async()=>new Response(' '.repeat(65537))}),/Try again/);
});
test('cancellation and stale context stop without trying another node',async()=>{
 const controller=new AbortController();let calls=0;
 const promise=lookup({signal:controller.signal,fetchImpl:()=>{calls++;return new Promise(()=>{});}});controller.abort(Error('cancel fixture'));
 await assert.rejects(promise,/cancel fixture/);assert.equal(calls,1);
 let current=true;const r=reader(),f=r.fetchImpl;
 await assert.rejects(lookup({...r,fetchImpl:async(...args)=>{const value=await f(...args);current=false;return value;},assertCurrent:()=>{if(!current)throw Error('stale fixture');}}),/stale fixture/);assert.equal(r.calls.length,1);
});
test('imported zero and supplied restore heights do not query or advance',async()=>{
 for(const height of [0,3500000,3788870])assert.equal(await resolveWalletRestoreHeight({mode:'import',restoreHeight:height,fetchImpl:()=>{throw Error('Import must not fetch');}}),height);
 for(const height of [-1,1.5,'0',NaN])await assert.rejects(resolveWalletRestoreHeight({mode:'import',restoreHeight:height}),/valid restore height/);
});

const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
// Exercise the actual setup controller with disposable DOM/key adapters, so
// late responses cannot silently generate keys after closure or account change.
function setupFixture({fetchImpl,existing=null}={}){
 let nodes={},handlers={},reads=0,solKeys=0,moneroKeys=0,saved=null,selected=existing?.accounts[0]?.id;
 const modal={open:false,addEventListener(){},removeEventListener(){},close(){this.open=false;for(const n of Object.values(nodes))n.isConnected=false;}};
 Object.defineProperty(modal,'innerHTML',{set(){for(const n of Object.values(nodes))n.isConnected=false;}});
 const context={epoch:0,setupRead:null,lastLockSignal:null,vault:existing,password:'synthetic-password',activeId:selected,cache:{},modal,AbortController,Error,
  crypto:{randomUUID:()=> 'public-fixture-account'},account:()=>context.vault?.accounts.find(a=>a.id===selected),
  $:id=>nodes[id],esc:String,paintBalances(){},render(){},refresh(){},establishSession:async()=>{},
  show(title){modal.innerHTML='';modal.open=true;nodes=Object.fromEntries(['#name','#password','#password-confirm','#continue','#close','#progress','#height','#xmr-seed','#sol-secret','#backed-up','#finish'].map(id=>[id,{isConnected:true,disabled:false,onclick:null,value:id.includes('password')?'synthetic-password':id==='#name'?'Fixture':id==='#height'?'0':'',checked:true}]));},
  on(id,fn){handlers[id]=fn;},run:fn=>fn(context.epoch),
  resolveWalletRestoreHeight:options=>{reads++;return resolveWalletRestoreHeight({...options,fetchImpl,timeoutMs:20,now:()=>time});},
  Keypair:{generate(){solKeys++;return {publicKey:{toBase58:()=> 'public-sol-fixture'},secretKey:new Uint8Array(64)};}},bs58:{encode:()=> 'synthetic-key'},
  oneShot:async()=>{moneroKeys++;return {address:'public-monero-fixture',seed:'synthetic recovery fixture'};},
  persist:async()=>{saved=structuredClone(context.vault);},
 };
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function creationHeight('),source.indexOf('\nfunction receive()')),context);
 return {context,start:()=>{context.setup('create');return handlers.continue();},finish:()=>handlers.finish(),close:()=>nodes['#close'].onclick(),switchAccount:()=>{selected='other';context.epoch++;context.setupRead?.abort(Error('Wallet changed.'));},counts:()=>({reads,solKeys,moneroKeys}),saved:()=>saved};
}
test('actual setup creates neither key when every birthday source fails',async()=>{
 const f=setupFixture({fetchImpl:reader({fail:()=>true}).fetchImpl});await assert.rejects(f.start(),/Try again/);assert.deepEqual(f.counts(),{reads:1,solKeys:0,moneroKeys:0});
});
test('actual setup cancels or switches accounts while awaiting height without generating keys',async()=>{
 for(const stop of ['close','switchAccount']){
  const f=setupFixture({fetchImpl:()=>new Promise(()=>{})});const task=f.start();f[stop]();await task;
  assert.deepEqual(f.counts(),{reads:1,solKeys:0,moneroKeys:0});
 }
});
test('actual setup persists a birthday per account; encrypted backup keeps existing zero unchanged',async()=>{
 const existing={accounts:[{id:'old-unknown',height:0,name:'Existing'},{id:'old-known',height:3500000}],receipts:[]};
 const f=setupFixture({fetchImpl:reader().fetchImpl,existing:structuredClone(existing)});await f.start();await f.finish();
 assert.deepEqual(f.counts(),{reads:1,solKeys:1,moneroKeys:1});const saved=f.saved();
 assert.equal(saved.accounts[0].height,0);assert.equal(saved.accounts[1].height,3500000);assert.equal(saved.accounts[2].height,3788870);
 const box=await encryptVault(saved,'synthetic-backup-password');const restored=await decryptVault(JSON.parse(JSON.stringify(box)),'synthetic-backup-password');
 assert.deepEqual(restored.accounts.map(a=>a.height),[0,3500000,3788870]);
});
