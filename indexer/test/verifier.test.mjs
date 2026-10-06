import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const require=createRequire(import.meta.url);
test('native verifier accepts a synthetic spend signature and rejects altered messages and signing requests',{timeout:60000},async()=>{
 const m=await require('../build/monero.cjs')({print:()=>{},printErr:()=>{}});
 const k=await new Promise((r,j)=>m.create_keys_wallet_random(JSON.stringify({networkType:0,language:'English',seedOffset:''}),v=>typeof v==='number'?r(v):j(Error('fixture'))));
 const p=await new Promise((r,j)=>m.create_full_wallet(JSON.stringify({networkType:0,seed:m.get_seed(k),seedOffset:'',path:'',password:'',restoreHeight:0}),'synthetic-test',v=>typeof v==='number'?r(v):j(Error('fixture'))));
 const address=m.get_address(p,0,0),data='synthetic verification test',signature=m.sign_message(p,data,0,0,0);
 await new Promise(r=>m.close(p,false,0,r));await new Promise(r=>m.close(k,false,0,r));
 const child=spawn(process.execPath,[new URL('../build/verifier.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 try{
  assert.equal(JSON.parse((await lines.next()).value).ready,true);
  async function request(method,params){child.stdin.write(JSON.stringify({method,params})+'\n');return JSON.parse((await lines.next()).value)}
  const good=(await request('verify',{data,address,signature})).result;
  assert.deepEqual(good,{good:true,old:false,version:2,signature_type:'spend'});
  assert.equal((await request('verify',{data:data+'!',address,signature})).result.good,false);
  assert.equal((await request('validate_address',{address})).result.valid,true);
  assert.ok((await request('sign',{data})).error);
 }finally{child.kill();}
});
