// The ordinary native worker's scan loop: bounded retry, node failover,
// checkpointed passes, pause, and cache-restored opens. Runs the real worker
// source against a fake wallet; no library, network or phrase is involved.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const worker=readFileSync(new URL('../extension/vendor/native.worker.js',import.meta.url),'utf8');
const SETH='https://node.sethforprivacy.com',CAKE='https://xmr-node.cakewallet.com:18081',OWN='https://api.xmr20.org/monero';
const address='4'+'1'.repeat(94),seed=Array(25).fill('abandon').join(' ');
function fixture({target=200,start=100,passes=[],healthFail=()=>false}={}){
 const messages=[],daemons=[],stops=[],requests=[],xhrs=[];let height=start,pass=0,cacheSerial=0,created=0,openedWithCache=null,primaryAddress=address;
 const wallet={
  getPrimaryAddress:async()=>primaryAddress,getHeight:async()=>height,getBalance:async()=>5n,getUnlockedBalance:async()=>5n,
  setDaemonConnection:async({uri})=>{daemons.push(uri);},
  isViewOnly:async()=>false,close:async()=>{},
  stopSyncing:async()=>{stops.push(height);},
  getData:async()=>[new Uint8Array([1,2,3]),new Uint8Array([9,9,++cacheSerial])],
  sync:async()=>{const step=passes[pass++]??{to:target};if(step.throw)throw Error(step.throw);height=Math.min(step.to,target);}
 };
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>healthFail(String(url))?{status:'Failed'}:{status:'OK',mainnet:true,nettype:'mainnet',height:target}};};
 const self={postMessage:(v,transfer)=>messages.push(v),fetch,XMLHttpRequest:class{open(method,url){this.destination=url;}send(body){xhrs.push({url:this.destination,body});}},importScripts(){},initOneTime:async()=>{},addListener:async()=>{},WORKER_OBJECTS:{},
  createWalletFull:async(name,config)=>{created++;self.WORKER_OBJECTS[name]={...wallet,restoreHeight:config.restoreHeight,password:config.password};},
  openWalletData:async(name,path,password,network,keys,cache,server)=>{openedWithCache={password,keys:Array.from(keys),cache:Array.from(cache)};self.WORKER_OBJECTS[name]={...wallet,getPrimaryAddress:async()=>openedWithCache.cache[0]===7?'4'+'2'.repeat(94):primaryAddress};}};
 const context=vm.createContext({self,console:{},importScripts(){},URL,AbortSignal,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,BigInt,Number,Error,Map,Set,Array,JSON,Object,Promise,Math,Date,String,setTimeout:(fn)=>{fn();return 0;},clearTimeout(){}});
 vm.runInContext(worker,context);
 return {context,messages,daemons,stops,requests,xhrs,get height(){return height;},get created(){return created;},get openedWithCache(){return openedWithCache;},
  useWallet(){vm.runInContext('wallet=fakeWallet;',Object.assign(context,{fakeWallet:wallet}));},
  async call(action,extra={}){await context.self.onmessage({data:{id:'request',action,node:SETH,...extra}});return messages.filter(m=>m.id==='request').at(-1);}};
}
test('a transient node failure is retried on the other configured node and the scan completes',async()=>{
 const f=fixture({passes:[{throw:'Exception in thread pool'},{to:200}]});f.useWallet();
 const r=await f.call('sync',{persist:true});
 assert.equal(r.error,undefined,r.error);assert.equal(r.result.height,200);assert.equal(r.result.retries,1);assert.equal(r.result.passes,2);assert.equal(r.result.node,CAKE);
 assert.deepEqual(f.daemons,[SETH,CAKE]);
 const retrying=f.messages.find(m=>m.progress?.phase==='retrying');assert.equal(retrying.progress.node,CAKE);assert.equal(retrying.progress.retry,1);
 const checkpoints=f.messages.filter(m=>m.checkpoint);assert.ok(checkpoints.length>=2);assert.equal(checkpoints.at(-1).checkpoint.height,200);assert.equal(checkpoints.at(-1).checkpoint.address,address);
});
test('progress is measured from the restore height, not the fresh wallet height of 1',async()=>{
 const f=fixture({start:1,target:200,passes:[{to:200}]});f.useWallet();f.context.fakeWallet.getRestoreHeight=async()=>150;
 const r=await f.call('sync');assert.equal(r.error,undefined,r.error);assert.equal(r.result.start,150);
 assert.equal(f.messages.find(m=>m.progress?.phase==='syncing'&&m.progress.start).progress.start,150);
});
test('a long scan of many checkpoint passes never exhausts the retry bound',async()=>{
 const passes=[];for(let i=1;i<=60;i++)passes.push({to:100+i});passes.push({to:200});
 const f=fixture({passes});f.useWallet();vm.runInContext('stopRequested=true;',f.context);
 const r=await f.call('sync');assert.equal(r.error,undefined,r.error);assert.equal(r.result.passes,61);assert.equal(r.result.retries,0);assert.deepEqual(f.daemons,[SETH]);
});
test('failover is disabled when the caller asks for one node only',async()=>{
 const f=fixture({passes:[{throw:'reset'},{to:200}]});f.useWallet();
 const r=await f.call('sync',{failover:false});assert.equal(r.result.node,SETH);assert.deepEqual(f.daemons,[SETH,SETH]);
});
test('a scan that never advances stops after a bounded number of attempts with safe details',async()=>{
 const f=fixture({passes:Array(50).fill({throw:'SECRET_NODE_DETAIL boom'})});f.useWallet();
 const r=await f.call('sync');
 assert.match(r.error,/Monero sync could not finish/);assert.equal(r.sync.retries,4);assert.equal(r.sync.height,100);
 assert.ok(!JSON.stringify(f.messages).includes('SECRET_NODE_DETAIL'));assert.equal(f.daemons.length,4);
});
test('progress between failures resets the stall budget so long scans survive repeated interruptions',async()=>{
 const passes=[];for(let i=0;i<10;i++)passes.push({throw:'cut'},{throw:'cut'},{throw:'cut'},{to:110+i*9});passes.push({to:200});
 const f=fixture({passes});f.useWallet();
 const r=await f.call('sync');assert.equal(r.error,undefined,r.error);assert.equal(r.result.height,200);assert.equal(r.result.retries,30);
});
test('an interrupted checkpoint pass continues until the node tip is reached',async()=>{
 const f=fixture({passes:[{to:150},{to:200}]});f.useWallet();
 vm.runInContext('stopRequested=true;',f.context);
 const r=await f.call('sync');assert.equal(r.error,undefined,r.error);assert.equal(r.result.height,200);assert.equal(r.result.passes,2);assert.equal(r.result.retries,0);
 assert.equal(f.messages.filter(m=>m.progress?.phase==='retrying').length,0);
});
test('a pause request ends the scan after the current pass, saves a checkpoint and reports where it stopped',async()=>{
 const f=fixture({passes:[{to:150},{to:200}]});f.useWallet();
 const sync=f.call('sync');
 await f.context.self.onmessage({data:{id:'stop-1',action:'stop'}});
 const r=await sync;
 assert.equal(r.code,'sync-paused');assert.match(r.error,/Scan paused at block 100/);assert.equal(r.sync.height,100);
 assert.equal(f.messages.find(m=>m.id==='stop-1').result.stopping,true);
 assert.equal(f.messages.filter(m=>m.checkpoint).at(-1).checkpoint.reason,'pause');
 const again=await f.call('sync');assert.equal(again.error,undefined,again.error);assert.equal(again.result.height,200);
});
test('health failures on the preferred node fail over without touching the stall budget unfairly',async()=>{
 const f=fixture({passes:[{to:200}],healthFail:url=>url.startsWith(SETH)});f.useWallet();
 const r=await f.call('sync');assert.equal(r.error,undefined,r.error);assert.equal(r.result.node,CAKE);assert.deepEqual(f.daemons,[CAKE]);
});
test('opening with a saved checkpoint restores it; a checkpoint for another wallet is rejected and reported',async()=>{
 const f=fixture();
 const good=await f.call('open',{seed,address,restoreHeight:100,cache:new Uint8Array([9,9,1])});
 assert.equal(good.error,undefined,good.error);assert.equal(good.result.restored,true);assert.equal(good.result.cacheRejected,false);
 assert.equal(f.created,1);assert.deepEqual(f.openedWithCache.keys,[1,2,3]);assert.match(f.openedWithCache.password,/^[0-9a-f]{64}$/);
 await f.call('close');
 const bad=await f.call('open',{seed,address,restoreHeight:100,cache:new Uint8Array([7,7,7])});
 assert.equal(bad.error,undefined,bad.error);assert.equal(bad.result.restored,false);assert.equal(bad.result.cacheRejected,true);
 await f.call('close');
 const fresh=await f.call('open',{seed,address,restoreHeight:100,cache:null});
 assert.equal(fresh.result.restored,false);assert.equal(fresh.result.cacheRejected,false);
 assert.ok(!JSON.stringify(f.messages).includes('abandon'));
});
test('the cache password is derived from the phrase alone and never equals or contains it',async()=>{
 const f=fixture();const one=await vm.runInContext('cachePassword("'+seed+'")',f.context),two=await vm.runInContext('cachePassword("  '+seed.replace(/ /g,'   ')+' ")',f.context);
 assert.equal(one,two);assert.equal(one.length,64);assert.ok(!one.includes('abandon'));
 assert.notEqual(one,await vm.runInContext('cachePassword("'+seed.replace('abandon','ability')+'")',f.context));
});
test('a relay saves a checkpoint so a reopened wallet remembers the spend',async()=>{
 const f=fixture();f.useWallet();
 const to='4'+'2'.repeat(94);
 const tx={getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>to,getAmount:()=>900n}]}),getOutgoingAmount:()=>900n,getIsRelayed:()=>false,getFee:()=>100n,getHash:()=>'ab'.repeat(32),getInputs:()=>[{getKeyImage:()=>({getHex:()=>'cd'.repeat(32)})}]};
 Object.assign(f.context.fakeWallet,{getOutputs:async()=>[],createTx:async()=>tx,relayTx:async()=>'ab'.repeat(32),freezeOutput:async()=>{},isOutputFrozen:async()=>true});
 vm.runInContext('self.XMR20CarrierGuard={classifyOwnedOutputs:()=>({unknown:[],protected:[]})};',f.context);
 vm.runInContext('(async()=>{const h=await wallet.getHeight();})()',f.context);
 Object.assign(f.context.fakeWallet,{getHeight:async()=>200});
 const review=await f.call('prepare',{to,amountRaw:'900'});assert.equal(review.error,undefined,review.error);
 const before=f.messages.filter(m=>m.checkpoint).length;
 const relay=await f.call('relay',{reviewId:review.result.id});assert.equal(relay.error,undefined,relay.error);
 assert.equal(f.messages.filter(m=>m.checkpoint).length,before+1);assert.equal(f.messages.filter(m=>m.checkpoint).at(-1).checkpoint.reason,'relay');
});
test('slow block downloads get a longer request limit than small reads',()=>{
 const f=fixture();assert.equal(vm.runInContext('requestTimeout("/getblocks.bin")',f.context),90000);assert.equal(vm.runInContext('requestTimeout("/get_info")',f.context),30000);
});

test('checkpoint timers cannot keep a non-advancing scan alive indefinitely',async()=>{
 const f=fixture({passes:Array(50).fill({to:100})});f.useWallet();
 const r=await f.call('sync');assert.match(r.error,/could not finish/);
 assert.equal(r.sync.retries,4);assert.deepEqual(f.daemons,[SETH,CAKE,OWN,SETH]);
});
test('open fails over before wallet creation when the preferred node is down',async()=>{
 const f=fixture({healthFail:url=>url.startsWith(SETH)});
 const r=await f.call('open',{seed,address,restoreHeight:100});
 assert.equal(r.error,undefined,r.error);assert.equal(r.result.node,CAKE);assert.equal(f.created,1);
});
test('an explicit single-node open fails closed without creating a wallet',async()=>{
 const f=fixture({healthFail:url=>url.startsWith(SETH)});
 const r=await f.call('open',{seed,address,restoreHeight:100,failover:false});
 assert.ok(r.error);assert.equal(f.created,0);
});
test('pause cannot interrupt a payment operation',async()=>{
 const f=fixture();f.useWallet();vm.runInContext("busy=true;currentAction='relay';",f.context);
 const r=await f.call('stop');assert.equal(r.result.stopping,false);assert.equal(f.stops.length,0);
});

test('a restored open keeps its connection for the following sync and checkpoints the working node',async()=>{
 const f=fixture();const opened=await f.call('open',{seed,address,restoreHeight:100,cache:new Uint8Array([9,9,1])});
 assert.equal(opened.error,undefined);
 const synced=await f.call('sync');assert.equal(synced.error,undefined);
 assert.deepEqual(f.daemons,[]);
 assert.equal(f.messages.filter(m=>m.checkpoint).at(-1).checkpoint.node,SETH);
});

test('a new sync retries its selected primary rather than silently retaining a cached fallback',async()=>{
 const f=fixture({passes:[{throw:'connection lost'},{to:200},{to:200}]});f.useWallet();
 assert.equal((await f.call('sync',{node:OWN})).result.node,CAKE);
 assert.equal((await f.call('sync',{node:OWN})).result.node,OWN);
 assert.deepEqual(f.daemons,[OWN,CAKE,OWN]);
});
test('the read-only owned gateway is the primary with Cake and Seth as bounded failovers',async()=>{
 const f=fixture({healthFail:url=>url.startsWith(OWN)||url.startsWith(CAKE)});f.useWallet();
 const r=await f.call('sync',{node:OWN});assert.equal(r.error,undefined);assert.equal(r.result.node,SETH);
 assert.deepEqual(f.daemons,[SETH]);assert.deepEqual(f.requests.slice(0,3).map(r=>r.url),[OWN+'/get_info',CAKE+'/get_info',SETH+'/get_info']);
});
test('node request guard allows only exact owned gateway paths and fixed public origins',async()=>{
 const f=fixture();
 for(const suffix of ['/get_info','/getblocks.bin','/gethashes.bin','/get_o_indexes.bin'])assert.equal(vm.runInContext('readRequest('+JSON.stringify(OWN+suffix)+')',f.context),suffix);
 for(const url of [OWN+'-evil/get_info',OWN+'/../get_info',OWN+'/get_info?x=1',OWN+'/get_info#x','https://api.xmr20.org/other/get_info','https://evil.example/monero/get_info',OWN+'/%2fget_info'])assert.throws(()=>vm.runInContext('readRequest('+JSON.stringify(url)+')',f.context),/blocked/);
 assert.throws(()=>vm.runInContext('readRequest('+JSON.stringify(OWN+'/send_raw_transaction')+')',f.context),/approval/);
 assert.throws(()=>vm.runInContext('readRequest('+JSON.stringify(OWN+'/json_rpc')+',JSON.stringify({method:"transfer"}))',f.context),/blocked/);
});
test('wallet2 root RPC aliases reach only the fixed owned gateway with both transports',async()=>{
 const f=fixture(),body=JSON.stringify({method:'get_version',params:{}});f.context.readBody=body;
 await vm.runInContext('self.fetch("https://api.xmr20.org/json_rpc",{method:"POST",body:readBody})',f.context);
 assert.equal(f.requests.at(-1).url,OWN+'/json_rpc');assert.equal(f.requests.at(-1).options.body,body);
 await vm.runInContext('self.fetch("https://api.xmr20.org:443/json_rpc",{method:"POST",body:readBody})',f.context);
 assert.equal(f.requests.at(-1).url,OWN+'/json_rpc');
 vm.runInContext('const aliasXhr=new self.XMLHttpRequest();aliasXhr.open("POST","https://api.xmr20.org/getblocks.bin");aliasXhr.send(readBody);',f.context);
 assert.deepEqual(f.xhrs.at(-1),{url:OWN+'/getblocks.bin',body});
 assert.throws(()=>vm.runInContext('readRequest("https://api.xmr20.org/json_rpc",JSON.stringify({method:"transfer"}))',f.context),/blocked/);
 await assert.rejects(vm.runInContext('self.fetch("https://api.xmr20.org/send_raw_transaction",{method:"POST",body:readBody})',f.context),/blocked/);
 vm.runInContext('canRelay=true;',f.context);
 await vm.runInContext('self.fetch("https://api.xmr20.org/send_raw_transaction",{method:"POST",body:readBody})',f.context);
 assert.equal(f.requests.at(-1).url,CAKE+'/send_raw_transaction');assert.equal(f.requests.at(-1).options.body,body);
});
test('approved gateway relays route exact bytes once through public fetch and XHR, never the read-only gateway',async()=>{
 const f=fixture(),body=JSON.stringify({tx_as_hex:'00',do_not_relay:false});f.context.relayBody=body;
 await assert.rejects(vm.runInContext('self.fetch('+JSON.stringify(OWN+'/send_raw_transaction')+',{method:"POST",body:relayBody})',f.context),/blocked/);
 assert.equal(f.requests.length,0);vm.runInContext('canRelay=true;',f.context);
 await vm.runInContext('self.fetch('+JSON.stringify(OWN+'/send_raw_transaction')+',{method:"POST",body:relayBody})',f.context);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,CAKE+'/send_raw_transaction');assert.equal(f.requests[0].options.body,body);
 vm.runInContext('const xhr=new self.XMLHttpRequest();xhr.open("POST",'+JSON.stringify(OWN+'/sendrawtransaction')+');xhr.send(relayBody);',f.context);
 assert.deepEqual(f.xhrs,[{url:CAKE+'/sendrawtransaction',body}]);
 vm.runInContext('canRelay=false;',f.context);assert.throws(()=>vm.runInContext('xhr.send(relayBody)',f.context),/approval/);
});
