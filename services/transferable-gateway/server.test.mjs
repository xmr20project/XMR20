import test from 'node:test';import assert from 'node:assert/strict';import {makeGateway,gatewayRoute} from './server.mjs';
const mint='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',base='/api/joint-transferable/'+mint;
async function fixture(fn){const calls=[],server=makeGateway({fetcher:async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({ok:true}),{status:200});}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const request=(path,options)=>fetch('http://127.0.0.1:'+server.address().port+path,options),send=(path,input={},extra={})=>request(path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://xmr20.org',...extra},body:JSON.stringify(input)});try{await fn(send,calls,request);}finally{await new Promise(r=>server.close(r));}}
test('only explicit bridge routes can reach the loopback operator',()=>{assert.equal(gatewayRoute('/api/joint-transferable/'+mint+'/sign'),null);assert.equal(gatewayRoute(base+'/snapshot?x=1'),null);assert.equal(gatewayRoute('/api/wallet'),null);});
test('untrusted origins and arbitrary Solana sends cannot reach operator',()=>fixture(async(send,calls)=>{assert.equal((await send(base+'/prepare',{}, {Origin:'https://evil.test'})).status,403);assert.equal((await send('/api/bridge-solana-read',{jsonrpc:'2.0',id:1,method:'sendTransaction',params:[]})).status,403);assert.equal(calls.length,0);}));
test('public read proxy and bridge recovery preserve exact payloads',()=>fixture(async(send,calls)=>{const body={jsonrpc:'2.0',id:7,method:'getBalance',params:[mint]};assert.equal((await send('/api/bridge-solana-read',body)).status,200);assert.equal(calls[0].url,'http://127.0.0.1:8934/api/solana-read');assert.deepEqual(JSON.parse(calls[0].o.body),body);assert.equal(calls[0].o.headers.Origin,'http://127.0.0.1:8934');assert.equal((await send(base+'/retry',{operationId:'saved'})).status,200);assert.deepEqual(JSON.parse(calls[1].o.body),{operationId:'saved'});}));
test('oversized inputs are rejected without upstream work',()=>fixture(async(send,calls)=>{assert.equal((await send(base+'/submit',{data:'x'.repeat(20001)})).status,413);assert.equal(calls.length,0);}));
const extension='chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla';
test('installed extension preflight allows only the pinned origin and JSON POST',()=>fixture(async(send,calls,request)=>{
 const headers={Origin:extension,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'};
 const ok=await request(base+'/snapshot',{method:'OPTIONS',headers});assert.equal(ok.status,204);assert.equal(ok.headers.get('access-control-allow-origin'),extension);assert.equal(ok.headers.get('vary'),'Origin');
 assert.equal((await request(base+'/snapshot',{method:'OPTIONS',headers:{...headers,Origin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}})).status,403);
 assert.equal((await request(base+'/snapshot',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'content-type, authorization'}})).status,403);
 assert.equal((await request(base+'/snapshot',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Method':'DELETE'}})).status,403);
 assert.equal(calls.length,0);
}));
test('extension reads and recovery use the same bounded gateway as the website',()=>fixture(async(send,calls)=>{
 const r=await send(base+'/progress',{operationId:'saved'},{Origin:extension});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),extension);assert.deepEqual(JSON.parse(calls[0].o.body),{operationId:'saved'});
 assert.equal((await send('/api/bridge-solana-read',{jsonrpc:'2.0',id:1,method:'sendTransaction',params:[]},{Origin:extension})).status,403);
 const web=await send(base+'/snapshot');assert.equal(web.status,200);assert.equal(web.headers.get('access-control-allow-origin'),'https://xmr20.org');
 const bad=await send(base+'/snapshot',{}, {Origin:'https://evil.test'});assert.equal(bad.status,403);assert.equal(bad.headers.get('access-control-allow-origin'),null);
}));
