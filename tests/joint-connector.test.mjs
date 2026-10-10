import test from 'node:test';import assert from 'node:assert/strict';import {request} from 'node:http';
import {makeExtensionConnector,extensionOrigin,connectorOptions} from '../local-joint-connector.mjs';
import {Keypair} from '@solana/web3.js';
import {PRIVATE_TEST_POLICY} from '../bridge/core-transferable/private-test.mjs';
test('CLI requires an explicit local replacement opt-in and rejects arbitrary routes or destinations',()=>{
 assert.deepEqual(connectorOptions([]),{});
 assert.deepEqual(connectorOptions(['--transferable-review']),{transferableOrigin:'http://127.0.0.1:8931'});
 for(const args of [['--url=https://example.invalid'],['--transferable-review','extra'],['--enable-all']])assert.throws(()=>connectorOptions(args));
});
async function fixture(options={}){const forwarded=[],server=makeExtensionConnector({...options,fetcher:async(url,requestOptions)=>{forwarded.push({url,options:requestOptions});return options.fetcher?options.fetcher(url,requestOptions):new Response(JSON.stringify({ok:true}),{status:200});}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;return {forwarded,server,send(method,path,body={},headers={}){return new Promise((resolve,reject)=>{const r=request({hostname:'127.0.0.1',port,method,path,headers:{Host:'127.0.0.1:'+(options.connectorPort??8928),Origin:extensionOrigin,'Content-Type':'application/json',Connection:'close',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});r.on('error',reject);r.end(method==='OPTIONS'?undefined:JSON.stringify(body));});}};}
test('local connector accepts only its pinned extension origin and explicit POST routes',async()=>{const f=await fixture();try{const valid=await f.send('POST','/api/joint-mainnet/readiness');assert.equal(valid.status,200);assert.equal(valid.headers['access-control-allow-origin'],extensionOrigin);assert.equal(f.forwarded[0].url,'http://127.0.0.1:8925/api/joint-mainnet/readiness');for(const h of [{Origin:'https://xmr20.org'},{Origin:'null'},{Origin:'chrome-extension://another'},{Host:'localhost:8928'}])assert.equal((await f.send('POST','/api/joint-mainnet/readiness',{},h)).status,503);assert.equal((await f.send('POST','/api/private-sign')).status,503);assert.equal((await f.send('GET','/api/joint-mainnet/readiness')).status,503);assert.equal(f.forwarded.length,1);}finally{await new Promise(resolve=>f.server.close(resolve));}});
test('protocol token routes remain exact, local and method bounded',async()=>{const f=await fixture(),path='/api/joint-protocol/'+Keypair.generate().publicKey.toBase58();try{assert.equal((await f.send('POST',path+'/readiness')).status,200);assert.equal((await f.send('POST','/api/joint-protocol/catalog')).status,200);for(const p of [path+'/query_key',path+'/signTransaction',path+'/readiness?url=private','/api/joint-protocol/not-a-mint/readiness'])assert.equal((await f.send('POST',p)).status,503);assert.equal(f.forwarded.length,2);}finally{await new Promise(resolve=>f.server.close(resolve));}});
test('preflight is exact and the read endpoint cannot submit transactions or carry keys',async()=>{const f=await fixture();try{const pre=await f.send('OPTIONS','/api/solana-read',{}, {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'});assert.equal(pre.status,204);assert.equal(pre.headers['access-control-allow-headers'],'Content-Type');for(const method of ['sendTransaction','requestAirdrop','signTransaction'])assert.equal((await f.send('POST','/api/solana-read',{id:1,jsonrpc:'2.0',params:[],method})).status,503);assert.equal((await f.send('POST','/api/solana-read',{id:1,jsonrpc:'2.0',params:[],method:'getBalance',privateKey:'test-only-invalid-field'})).status,503);assert.equal(f.forwarded.length,0);assert.equal((await f.send('POST','/api/solana-read',{id:1,jsonrpc:'2.0',params:[],method:'getGenesisHash'})).status,200);}finally{await new Promise(resolve=>f.server.close(resolve));}});
test('replacement routes never fall back to an old bridge service',async()=>{const path='/api/joint-transferable/'+Keypair.generate().publicKey.toBase58(),f=await fixture();try{assert.equal((await f.send('POST',path+'/readiness')).status,503);assert.equal(f.forwarded.length,0);}finally{await new Promise(r=>f.server.close(r));}});
test('explicit replacement service remains separate and method bounded',async()=>{const path='/api/joint-transferable/'+Keypair.generate().publicKey.toBase58(),f=await fixture({transferableOrigin:'http://127.0.0.1:8931'});try{assert.equal((await f.send('POST',path+'/readiness')).status,200);assert.equal(f.forwarded[0].url,'http://127.0.0.1:8931'+path+'/readiness');for(const suffix of ['/sign','/submit?url=private','/private-key'])assert.equal((await f.send('POST',path+suffix)).status,503);assert.equal((await f.send('POST','/api/joint-mainnet/readiness')).status,200);assert.ok(f.forwarded.at(-1).url.startsWith('http://127.0.0.1:8925/'));}finally{await new Promise(r=>f.server.close(r));}});
test('private connector serves only the named mint and read-only RPC through its own operator; old UI is never consulted',async()=>{
 const options=connectorOptions(['--private-one-xmr20']),f=await fixture(options),path='/api/joint-transferable/'+PRIVATE_TEST_POLICY.mint;
 try{
  assert.equal((await f.send('POST',path+'/readiness')).status,200);
  assert.equal((await f.send('POST',path+'/authorize-registration',{envelope:{record:{op:'link'}}})).status,200);
  assert.equal((await f.send('POST',path+'/authorize-release')).status,503);
  assert.equal((await f.send('POST','/api/solana-read',{id:1,jsonrpc:'2.0',method:'getGenesisHash',params:[]})).status,200);
  assert.ok(f.forwarded.every(v=>v.url.startsWith('http://127.0.0.1:8934/')));
  for(const bad of ['/api/joint-mainnet/readiness','/api/joint-protocol/catalog','/api/joint-transferable/'+Keypair.generate().publicKey.toBase58()+'/readiness'])assert.equal((await f.send('POST',bad)).status,503);
  assert.equal((await f.send('POST',path+'/readiness',{}, {Host:'127.0.0.1:8928'})).status,503);
  assert.equal(f.forwarded.length,3);
 }finally{await new Promise(r=>f.server.close(r));}
 assert.throws(()=>makeExtensionConnector({...options,solanaReadOrigin:'http://127.0.0.1:8925'}));
});

test('overlapping home and Bridge snapshots share one fresh read, without caching its result',async()=>{
 let finish;const wait=new Promise(r=>finish=r),path='/api/joint-transferable/'+PRIVATE_TEST_POLICY.mint+'/snapshot';
 const f=await fixture({...connectorOptions(['--private-one-xmr20']),fetcher:async()=>{await wait;return new Response(JSON.stringify({complete:true}));}});
 try{
  const requests=[f.send('POST',path),f.send('POST',path),f.send('POST',path)];
  await forwardedCount(f,1);await new Promise(r=>setTimeout(r,25));assert.equal(f.forwarded.length,1);finish();
  const results=await Promise.all(requests);assert.ok(results.every(r=>r.status===200&&JSON.parse(r.text).complete));
  await f.send('POST',path);assert.equal(f.forwarded.length,2,'A later read gets fresh verification.');
 }finally{finish();await new Promise(r=>f.server.close(r));}
});

async function forwardedCount(f,count){const end=Date.now()+2000;while(f.forwarded.length<count&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.equal(f.forwarded.length,count);}

test('a queued state change fences shared snapshots, and financial requests never coalesce',async()=>{
 let finish;const wait=new Promise(r=>finish=r),path='/api/joint-transferable/'+PRIVATE_TEST_POLICY.mint;
 const f=await fixture({...connectorOptions(['--private-one-xmr20']),fetcher:async()=>{await wait;return new Response('{}');}});
 try{
  const first=f.send('POST',path+'/snapshot');await forwardedCount(f,1);
  const financial=[f.send('POST',path+'/prepare',{operation:'release'}),f.send('POST',path+'/prepare',{operation:'release'})];await forwardedCount(f,3);
  const second=f.send('POST',path+'/snapshot');await forwardedCount(f,4);
  finish();await Promise.all([first,second,...financial]);
 }finally{finish();await new Promise(r=>f.server.close(r));}
});

test('failed shared reads are discarded and malformed snapshots cannot borrow a valid response',async()=>{
 let finish,fail=true;const wait=new Promise(r=>finish=r),path='/api/joint-transferable/'+PRIVATE_TEST_POLICY.mint+'/snapshot';
 const f=await fixture({...connectorOptions(['--private-one-xmr20']),fetcher:async()=>{await wait;return new Response(JSON.stringify({complete:!fail}),{status:fail?503:200});}});
 try{
  const a=f.send('POST',path),b=f.send('POST',path,{unexpected:true});await forwardedCount(f,2);finish();await Promise.all([a,b]);
  fail=false;assert.equal((await f.send('POST',path)).status,200);assert.equal(f.forwarded.length,3);
 }finally{finish();await new Promise(r=>f.server.close(r));}
});

test('wallet testing connector admits any mint but retains exact origins, transport and RPC restrictions',async()=>{
 const f=await fixture(connectorOptions(['--wallet-testing']));try{const path='/api/joint-transferable/'+Keypair.generate().publicKey.toBase58();assert.equal((await f.send('POST',path+'/readiness')).status,200);assert.equal((await f.send('POST',path+'/prepare',{operation:'transfer'})).status,200);assert.ok(f.forwarded.every(x=>x.url.startsWith('http://127.0.0.1:8934/')));assert.equal((await f.send('POST',path+'/readiness',{}, {Origin:'https://attacker.invalid'})).status,503);assert.equal((await f.send('POST','/api/solana-read',{id:1,jsonrpc:'2.0',method:'sendTransaction',params:[]})).status,503);}finally{await new Promise(r=>f.server.close(r));}
});
