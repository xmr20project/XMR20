import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../extension/vendor/native.worker.js',import.meta.url),'utf8'),to='4'+'2'.repeat(94),owner='4'+'1'.repeat(94);
function fixture({multiple=false,mismatch=false}={}){
 const messages=[];let relays=0,config;const tx={getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>mismatch?owner:to,getAmount:()=>900n}]}),getOutgoingAmount:()=>900n,getIsRelayed:()=>false,getFee:()=>100n,getHash:()=>'ab'.repeat(32)};
 const wallet={getPrimaryAddress:async()=>owner,getHeight:async()=>100,getBalance:async()=>1000n,getUnlockedBalance:async()=>1000n,sweepUnlocked:async c=>{config=c;return multiple?[tx,tx]:[tx];},relayTx:async()=>{relays++;return 'ab'.repeat(32);}};
 const context=vm.createContext({self:{postMessage:v=>messages.push(v),fetch:async()=>({ok:true,json:async()=>({status:'OK',mainnet:true,nettype:'mainnet',height:100})}),XMLHttpRequest:class{}},console:{},URL,AbortSignal,crypto:webcrypto,fakeWallet:wallet});
 vm.runInContext(source+'\nwallet=fakeWallet;',context);
 return {async call(action,extra={}){await context.self.onmessage({data:{id:'request',action,node:'https://node.sethforprivacy.com',...extra}});return messages.at(-1);},get relays(){return relays;},get config(){return config;}};
}
test('native XMR Max reserves the actual fee and cannot relay until the exact review is approved',async()=>{
 const f=fixture(),r=await f.call('prepareMax',{to});assert.equal(r.result.amountRaw,'900');assert.equal(r.result.feeRaw,'100');assert.equal(f.config.relay,false);assert.equal(f.relays,0);
 await f.call('relay',{reviewId:'wrong'});assert.equal(f.relays,0);
 await f.call('relay',{reviewId:r.result.id});assert.equal(f.relays,1);
});
test('native Max rejects changed destinations and multi-transaction sweeps without partial sends',async()=>{
 for(const options of [{multiple:true},{mismatch:true}]){const f=fixture(options),r=await f.call('prepareMax',{to});assert.ok(r.error);assert.equal(f.relays,0);await f.call('relay',{reviewId:'anything'});assert.equal(f.relays,0);}
});
