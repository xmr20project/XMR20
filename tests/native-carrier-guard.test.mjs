import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {framePayload,extractPayload} from '../services/native-market/xn1/carrier.mjs';
import {encodeRecord} from '../services/native-market/xn1/records.mjs';

const source=readFileSync(new URL('../extension/vendor/native-carrier-guard.js',import.meta.url),'utf8');
const context=vm.createContext({self:{},Uint8Array,BigInt,Number,Error,Map,Set,Array,JSON,Object});
vm.runInContext(source,context);
const {classifyOwnedOutputs,extractNativePayload,nativeAllocationVouts,extraFromDaemonJson}=context.self.XMR20CarrierGuard;
const u8=value=>{const out=new context.Uint8Array(value.length);out.set(value);return out;};

const h=(n,byte)=>byte.repeat(n),hex32=b=>h(32,b),bytes=s=>u8(Buffer.from(s,'hex'));
const pubkey=()=>[1,...Array(32).fill(0xaa)];
const join=(...parts)=>u8(Buffer.concat(parts.map(p=>Buffer.from(p))));
const manifest=hex32('11');
const claim=(vin,ringPos)=>({vin,ringPos,source:{txid:hex32('22'),vout:0},c:hex32('33'),s:hex32('44')});
const allocation=(vout,amount)=>({vout,amount:BigInt(amount),image:hex32('55'),c:hex32('66'),s:hex32('77')});
const move=vouts=>encodeRecord({op:'MOVE',manifest,claims:[claim(1,3)],allocations:vouts.map((v,i)=>allocation(v,100+i))});
const credit=vout=>encodeRecord({op:'CREDIT',manifest,issuance:hex32('88'),lock:hex32('99'),epoch:0,vout,amount:500n,image:hex32('55'),c:hex32('66'),s:hex32('77'),signatures:[{signer:0,signature:h(64,'ab')}]});
const burn=vouts=>encodeRecord({op:'BURN',manifest,claims:[claim(0,0)],amount:7n,redemption:hex32('aa'),recipient:hex32('bb'),allocations:vouts.map(v=>allocation(v,1))});
const extraWith=record=>join(pubkey(),framePayload(record));
const output=(txHash,vout,extra,ki)=>({keyImage:ki??hex32((vout+1).toString(16).padStart(2,'0')),txHash,vout,extra});

test('framing and record decoding agree with the shared XN1 codec',()=>{
 for(const record of [move([0]),move([0,2,5]),credit(1),burn([]),burn([3])]){
  const extra=extraWith(record);
  const mine=extractNativePayload(extra),theirs=extractPayload(Buffer.from(extra)).payload;
  assert.deepEqual(Buffer.from(mine),Buffer.from(theirs));
  assert.deepEqual(Buffer.from(mine),Buffer.from(record));
 }
 assert.deepEqual([...nativeAllocationVouts(u8(move([0,2,5]))).vouts],[0,2,5]);
 assert.deepEqual([...nativeAllocationVouts(u8(credit(1))).vouts],[1]);
 assert.deepEqual([...nativeAllocationVouts(u8(burn([]))).vouts],[]);
 assert.equal(nativeAllocationVouts(u8(burn([3]))).op,'BURN');
});

test('ordinary transactions without XN1 fragments are not protected',()=>{
 const extra=join(pubkey(),[2,9,1,2,3,4,5,6,7,8,9]);
 const tx='a'.repeat(64),r=classifyOwnedOutputs([output(tx,0,extra),output(tx,1,extra)]);
 assert.deepEqual([...r.protected],[]);assert.deepEqual([...r.unknown],[]);assert.equal(r.details.get(tx),'ordinary');
});

test('by default every owned output of a native token transaction is protected',()=>{
 const extra=extraWith(move([1])),tx='b'.repeat(64);
 const r=classifyOwnedOutputs([output(tx,0,extra),output(tx,1,extra),output(tx,2,extra)]);
 assert.deepEqual([...r.protected].sort(),[hex32('01'),hex32('02'),hex32('03')]);assert.equal(r.details.get(tx),'native-MOVE-all');
});

test('with verified output indices a decodable record protects exactly the allocated outputs',()=>{
 const extra=extraWith(move([1])),tx='b'.repeat(64);
 const r=classifyOwnedOutputs([output(tx,0,extra),output(tx,1,extra),output(tx,2,extra)],{trustVout:true});
 assert.deepEqual([...r.protected],[hex32('02')]);assert.equal(r.details.get(tx),'native-MOVE');
 const c=classifyOwnedOutputs([output('c'.repeat(64),1,extraWith(credit(1)),hex32('0c')),output('c'.repeat(64),0,extraWith(credit(1)),hex32('0d'))],{trustVout:true});
 assert.deepEqual([...c.protected],[hex32('0c')]);
 const unknownIndex=classifyOwnedOutputs([output('1'.repeat(64),undefined,extra,hex32('ee'))],{trustVout:true});
 assert.equal(unknownIndex.protected.length,1);assert.equal(unknownIndex.details.get('1'.repeat(64)),'native-MOVE-vout-unknown');
});

test('a malformed or undecodable XN1 payload protects every owned output of that transaction',()=>{
 const record=move([0]);
 const corrupt=Buffer.from(record);corrupt[4]=9; // unsupported op
 const extra=extraWith(corrupt),tx='d'.repeat(64);
 const r=classifyOwnedOutputs([output(tx,0,extra),output(tx,1,extra)],{trustVout:true});
 assert.deepEqual([...r.protected].sort(),[hex32('01'),hex32('02')]);assert.equal(r.details.get(tx),'native-undecodable');
 const badFragment=join(pubkey(),[2,7,0x7f,0x58,0x4e,0x31,0,2,0x01]);
 const m=classifyOwnedOutputs([output('f'.repeat(64),0,badFragment),output('f'.repeat(64),1,badFragment)]);
 assert.equal(m.protected.length,2);assert.equal(m.details.get('f'.repeat(64)),'extra-malformed');
 const inconsistent=[output('9'.repeat(64),0,join(pubkey()),hex32('a1')),output('9'.repeat(64),1,join(pubkey(),[0]),hex32('a2'))];
 assert.equal(classifyOwnedOutputs(inconsistent).details.get('9'.repeat(64)),'extra-inconsistent');
});

test('outputs whose extra is unavailable are reported as unknown rather than silently allowed',()=>{
 const tx='2'.repeat(64),r=classifyOwnedOutputs([output(tx,0,null),output(tx,1,extraWith(move([0])))]);
 assert.deepEqual([...r.unknown],[tx]);assert.deepEqual([...r.protected],[]);assert.equal(r.details.get(tx),'extra-unavailable');
 assert.throws(()=>classifyOwnedOutputs([{keyImage:'zz',txHash:tx,vout:0,extra:null}]),/Canonical output identity/);
});

test('daemon as_json extra arrays convert to bytes and reject non-byte content',()=>{
 assert.deepEqual([...extraFromDaemonJson('{"extra":[1,2,255]}')],[1,2,255]);
 assert.throws(()=>extraFromDaemonJson('{"extra":[1,256]}'),/Daemon extra unavailable/);
 assert.throws(()=>extraFromDaemonJson('{}'),/Daemon extra unavailable/);
});

test('oversized or raw XN1 framing is rejected as malformed',()=>{
 assert.throws(()=>extractNativePayload(new context.Uint8Array(1061)),/relay limit/);
 assert.throws(()=>extractNativePayload(join(pubkey(),[2,4,0x58,0x4e,0x31,0])),/Raw XN1/);
 assert.equal(extractNativePayload(bytes('00000000')),null);
});

test('truncated markers and unsupported native token versions protect all owned outputs',()=>{
 for(const nonce of [[0x7f],[0x7f,0x58],[0x58],[0x58,0x4e,0x32],[0x7f,0x58,0x4e,0x32],[1,0x58,0x4e,0x32]]){
  const extra=join(pubkey(),[2,nonce.length,...nonce]),tx='e'.repeat(64);
  assert.deepEqual([...classifyOwnedOutputs([output(tx,0,extra),output(tx,1,extra)]).protected],[hex32('01'),hex32('02')]);
 }
});
