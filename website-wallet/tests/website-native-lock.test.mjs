import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeWalletLockName,nativeWalletHeldElsewhere} from '../src/website-native-lock.js';
const genesis='418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3',address='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
test('the page computes the same exclusive lock name as the private engine',async()=>{
 const expected='xmr20-native-wallet:'+createHash('sha256').update(JSON.stringify(['xmr20-native-wallet-v1',genesis,address])).digest('hex');
 assert.equal(await nativeWalletLockName({genesis,address}),expected);
 await assert.rejects(nativeWalletLockName({genesis:'bad',address}),/Canonical wallet identity/);
});
test('a lock held by another window is reported; a lock released during the grace period is not',async()=>{
 const name=await nativeWalletLockName({genesis,address});let polls=0;
 const locks=held=>({query:async()=>{polls++;return {held:held()?[{name,mode:'exclusive'}]:[]};}});
 assert.equal(await nativeWalletHeldElsewhere(name,{locks:locks(()=>true),attempts:3,wait:async()=>{}}),true);assert.equal(polls,3);
 polls=0;let n=0;assert.equal(await nativeWalletHeldElsewhere(name,{locks:locks(()=>++n<2),attempts:3,wait:async()=>{}}),false);assert.equal(polls,2);
 assert.equal(await nativeWalletHeldElsewhere(name,{locks:{query:async()=>({held:[{name:'other'}]})},attempts:1}),false);
 assert.equal(await nativeWalletHeldElsewhere(name,{locks:undefined}),false);
});
