import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../services/native-market/frontend/native-market-worker.js',import.meta.url),'utf8')
 .replace("await import('./runtime.js')",'fakeModule');
function fixture(failure){
 const messages=[];let progress,closed=false;
 const context=vm.createContext({self:{postMessage:value=>messages.push(value)},fakeModule:{createInstalledMarketRuntime:async options=>{
  progress=options.onProgress;return {execute:async()=>{progress('Syncing Monero history · block 100 of 200');if(failure)throw Error(failure);return {ready:true};},close:()=>{closed=true;},canResumeSync:()=>true};
 }}});
 vm.runInContext(source,context);
 return {messages,get closed(){return closed;},call:action=>context.self.onmessage({data:{id:'public-request',action,args:{}}})};
}
test('verified worker progress carries the pending request ID and never completes it early',async()=>{
 const f=fixture();await f.call('sync');
 assert.equal(f.messages[0].id,'public-request');assert.match(f.messages[0].progress,/block 100 of 200/);
 assert.equal(f.messages[0].result,undefined);assert.equal(f.messages[1].result.ready,true);
});
test('missing XMR has a useful fixed explanation; arbitrary private errors stay hidden',async()=>{
 const f=fixture('Add spendable XMR for the Monero network fee before bridging');await f.call('prepareOperatorCredit');
 assert.match(f.messages.at(-1).error,/treasury does not pay/);assert.equal(f.closed,true);
 const g=fixture('PRIVATE_ERROR_INPUT_DO_NOT_ECHO');await g.call('prepareOperatorCredit');
 assert.ok(!JSON.stringify(g.messages).includes('PRIVATE_ERROR_INPUT'));assert.equal(g.closed,true);
});
