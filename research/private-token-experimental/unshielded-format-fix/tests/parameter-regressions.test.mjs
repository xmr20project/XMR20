// M1 + L1 REGRESSIONS against the fixed wallet library and parameter loader. Same shape as the review's reproductions
// (review-original/bridge-params/parameter-security-repro.test.mjs) with the assertions stating the corrected behaviour.
// Real candidate wasm and public parameter files; synthetic root; in-memory RPC responses. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {openTokenWallet} from '../wallet-lib/token-wallet.mjs';
const candidate=new URL('../',import.meta.url);
const manifestBytes=await readFile(new URL('params/test-v2/manifest.json',candidate));
const manifest=JSON.parse(manifestBytes);
const parameters=await readFile(new URL('params/test-v2/parameters.json',candidate));
const pin=createHash('sha256').update(manifestBytes).digest('hex');
const streamFetch=(chunks,{contentLength=null}={})=>{const st={read:0,cancelled:false};const f=async()=>({ok:true,status:200,headers:{get:k=>k==='content-length'&&contentLength!==null?String(contentLength):null},body:{getReader:()=>({async read(){return st.read<chunks.length?{done:false,value:chunks[st.read++]}:{done:true};},async cancel(){st.cancelled=true;}}),cancel:async()=>{st.cancelled=true;}}});return {f,st};};

test('L1: an oversized parameter stream is cancelled at the first excess byte; nothing beyond the pinned length is read',async()=>{
 const expected=manifest.parametersJson.bytes;
 const chunks=Array.from({length:16},()=>new Uint8Array(4096));
 const {f,st}=streamFetch(chunks,{contentLength:expected});// the server LIES about the length and streams 64 KiB
 const loader=createParameterLoader({manifest,engine:{},fetch:f,baseUrl:'https://synthetic.invalid'});
 await assert.rejects(loader.loadServedConfig(),e=>e.reason==='oversized'&&e.expected===expected);
 assert.equal(st.read,1,'only the first chunk was consumed');assert.equal(st.cancelled,true,'the stream was cancelled');
});
test('L1: a content-length that differs from the pin is rejected before any byte is read',async()=>{
 const {f,st}=streamFetch([new Uint8Array(10)],{contentLength:99999});
 const loader=createParameterLoader({manifest,engine:{},fetch:f,baseUrl:'https://synthetic.invalid'});
 await assert.rejects(loader.loadServedConfig(),e=>e.reason==='length'&&e.received===99999);
 assert.equal(st.read,0);
});
test('L1: a truncated stream is rejected; an exact stream passes length and hash and is parsed',async()=>{
 const short=streamFetch([parameters.subarray(0,100)]);
 await assert.rejects(createParameterLoader({manifest,engine:{},fetch:short.f,baseUrl:'https://synthetic.invalid'}).loadServedConfig(),e=>e.reason==='length'&&e.received===100);
 const exact=streamFetch([parameters.subarray(0,1000),parameters.subarray(1000)]);
 const cfg=await createParameterLoader({manifest,engine:{},fetch:exact.f,baseUrl:'https://synthetic.invalid'}).loadServedConfig();
 assert.equal(cfg.domain,manifest.ledgerDomain);
 // same bytes, one flipped: hash rejection AFTER the complete bounded read, before parsing
 const bad=Buffer.from(parameters);bad[5]^=1;const tampered=streamFetch([bad]);
 await assert.rejects(createParameterLoader({manifest,engine:{},fetch:tampered.f,baseUrl:'https://synthetic.invalid'}).loadServedConfig(),e=>e.reason==='sha256');
});

const rpcFetch=(requests=[],height=1)=>async(url,opts={})=>{requests.push(url);
 if(url==='https://synthetic.invalid/params/parameters.json')return new Response(parameters);
 assert.equal(url,'https://daemon.invalid/json_rpc');const q=JSON.parse(opts.body);
 if(q.method==='get_info')return Response.json({result:{nettype:'fakechain',offline:true,height}});
 if(q.method==='get_block'){assert.equal(q.params.height,0);return Response.json({result:{block_header:{hash:manifest.network.genesis}}});}
 assert.fail('Unexpected daemon request '+q.method);};
const wasm=await readFile(new URL('holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm',candidate));
const common={wasm,daemonRpc:'https://daemon.invalid',parameterServer:'https://synthetic.invalid',root:'01'.repeat(32)};

test('M1: a manifest object that differs from the authenticated bytes is refused before anything opens',async()=>{
 const changed=structuredClone(manifest);changed.network.startHeight=1_000_000_000;changed.label='UNAUTHENTICATED-MANIFEST-OBJECT';
 const requests=[];
 await assert.rejects(openTokenWallet({...common,manifest:changed,manifestBytes,pinnedManifestSha256:pin,fetch:rpcFetch(requests)}),/differs from the authenticated manifestBytes/);
 assert.equal(requests.length,0,'no parameter or daemon request was made');
});
test('M1: a pin without bytes is refused; bytes alone define the configuration; a later caller mutation has no effect',async()=>{
 await assert.rejects(openTokenWallet({...common,manifest,pinnedManifestSha256:pin,fetch:rpcFetch()}),/requires manifestBytes/);
 const mine=structuredClone(manifest);
 const wallet=await openTokenWallet({...common,manifest:mine,manifestBytes,pinnedManifestSha256:pin,fetch:rpcFetch()});
 try{
  assert.equal(wallet.manifestAuthenticated,true);assert.equal(wallet.manifestSha256,pin);assert.equal(wallet.startHeight,manifest.network.startHeight||0);
  mine.network.startHeight=1_000_000_000;mine.label='mutated-after-open';// the caller's object is not what the wallet runs on
  assert.throws(()=>{wallet.manifest.network.startHeight=5;},TypeError,'operational configuration is frozen');
  // the wallet's own (frozen) configuration is the authenticated one, whatever the caller does to its object afterwards
  assert.equal(wallet.startHeight,manifest.network.startHeight||0);assert.equal(wallet.manifest.network.startHeight||0,manifest.network.startHeight||0);assert.equal(wallet.manifestLabel,manifest.label);assert.equal(Object.isFrozen(wallet.manifest.network),true);
 }finally{wallet.close();}
 // bytes only (no object) also work, and a wrong pin is refused
 const w2=await openTokenWallet({...common,manifestBytes,pinnedManifestSha256:pin,fetch:rpcFetch()});w2.close();
 await assert.rejects(openTokenWallet({...common,manifestBytes,pinnedManifestSha256:'00'.repeat(32),fetch:rpcFetch()}),/does not match the hash/);
});
