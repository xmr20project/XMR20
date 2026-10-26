// REVIEW ONLY. No external requests, daemon, wallet profile or real keys.
// Assertions record the candidate's current unsafe behavior, not successful defenses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createParameterLoader} from '../../wallet-extension/src/holder-params.js';
import {openTokenWallet} from '../../wallet-lib/token-wallet.mjs';

const candidate=new URL('../../',import.meta.url);
const manifestBytes=await readFile(new URL('params/test-v2/manifest.json',candidate));
const manifest=JSON.parse(manifestBytes);
const parameters=await readFile(new URL('params/test-v2/parameters.json',candidate));
const pin=createHash('sha256').update(manifestBytes).digest('hex');

test('REPRO: parameter server is read beyond the pinned length before rejection',async()=>{
 let chunksRead=0,cancelled=false;
 const expected=manifest.parametersJson.bytes;
 // Bounded demonstration: 64 KiB only. A hostile server can keep streaming for
 // the ten-minute timeout; we deliberately do not exercise an actual OOM.
 const chunks=Array.from({length:16},()=>new Uint8Array(4096));
 const fetch=async()=>({ok:true,headers:{get:()=>String(expected)},body:{getReader:()=>({
  async read(){return chunksRead<chunks.length?{done:false,value:chunks[chunksRead++]}:{done:true};},
  async cancel(){cancelled=true;},
 })}});
 const loader=createParameterLoader({manifest,engine:{},fetch,baseUrl:'https://synthetic.invalid'});
 await assert.rejects(loader.loadServedConfig(),/65536 bytes/);
 assert.equal(chunksRead,16,'All 64 KiB accepted before length authentication, despite a 2425-byte pin');
 assert.equal(cancelled,false);
 console.log(JSON.stringify({case:'download-before-length-check',pinned:expected,received:chunksRead*4096,cancelled}));
});

test('REPRO: SDK authenticates manifestBytes but runs a different manifest object',async()=>{
 const changed=structuredClone(manifest);
 changed.network.startHeight=1_000_000_000;
 changed.label='UNAUTHENTICATED-MANIFEST-OBJECT';
 const requests=[];
 const fetch=async(url,opts={})=>{
  requests.push(url);
  if(url==='https://synthetic.invalid/params/parameters.json')return new Response(parameters);
  assert.equal(url,'https://daemon.invalid/json_rpc');
  const q=JSON.parse(opts.body);
  if(q.method==='get_info')return Response.json({result:{nettype:'fakechain',offline:true,height:101}});
  if(q.method==='get_block'){assert.equal(q.params.height,0);return Response.json({result:{block_header:{hash:manifest.network.genesis}}});}
  assert.fail('Unexpected daemon request '+q.method);
 };
 const wasm=await readFile(new URL('holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm',candidate));
 const wallet=await openTokenWallet({wasm,manifest:changed,manifestBytes,pinnedManifestSha256:pin,
  daemonRpc:'https://daemon.invalid',parameterServer:'https://synthetic.invalid',fetch,
  root:'01'.repeat(32)});
 try{
  const result=await wallet.sync();
  assert.equal(wallet.manifestLabel,changed.label);
  assert.equal(result.startHeight,1_000_000_000);
  assert.equal(result.waitingForStart,true);
  assert.equal(result.applied,0);
  console.log(JSON.stringify({case:'separate-manifest-object-used',authenticatedPin:pin,originalStartHeight:manifest.network.startHeight??0,actualStartHeight:result.startHeight,actualLabel:wallet.manifestLabel,requests:requests.length}));
 }finally{wallet.close();}
});
