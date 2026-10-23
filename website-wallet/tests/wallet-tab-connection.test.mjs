import test from 'node:test';
import assert from 'node:assert/strict';
import {connectForThisTab} from '../src/wallet-tab-connection.js';
test('restoration in other tabs never calls the wallet extension',async()=>{
 let calls=0;
 const provider={isConnected:false,connect:async()=>{calls++;throw Error('must not prompt');}};
 assert.equal(await connectForThisTab(provider,{wallet:'a'}),null);
 assert.equal(calls,0);
});
test('restores an already connected matching wallet without prompting',async()=>{
 const provider={isConnected:true,publicKey:{toBase58:()=> 'a'},connect:()=>{throw Error('must not prompt');}};
 assert.equal(await connectForThisTab(provider,{wallet:'a'}),'a');
 assert.equal(await connectForThisTab(provider,{wallet:'b'}),null);
});
test('explicit click connects only its own provider',async()=>{
 let first=0,other=0;
 const p={connect:async()=>{first++;},publicKey:{toBase58:()=> 'a'}};
 const second={connect:async()=>{other++;},isConnected:false};
 assert.equal(await connectForThisTab(p),'a');
 await connectForThisTab(second,{wallet:'a'});
 assert.equal(first,1);assert.equal(other,0);
});
