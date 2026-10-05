import test from 'node:test';import assert from 'node:assert/strict';
import {walletRequest} from '../review/core.mjs';
test('wallet calls allow the service deadline and never retry uncertain writes',async()=>{
 const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;let count=0,timeout;
 AbortSignal.timeout=ms=>{timeout=ms;return new AbortController().signal;};
 try{
  globalThis.fetch=async()=>{count++;return {ok:true,json:async()=>({ok:true})};};
  await walletRequest('test-session','moneroTransferQuote');assert.equal(timeout,120000);assert.equal(count,1);
  globalThis.fetch=async()=>{count++;throw new DOMException('Timed out','TimeoutError');};
  await assert.rejects(walletRequest('test-session','authorizeMoneroTransfer'),/Check Activity before trying again/);assert.equal(count,2);
  await assert.rejects(walletRequest('test-session','moneroTransferQuote'),/funds have not moved/);assert.equal(count,3);
 }finally{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
});
