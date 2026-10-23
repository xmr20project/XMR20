import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction,SystemProgram} from '@solana/web3.js';
import {requestLifetime} from '../../src/request-lifetime.js';

test('closing a Solana send during wallet approval never stores or broadcasts the late approval',async t=>{
 const previous=new Map(['location','sessionStorage','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let writes=0,sends=0,reply;
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://wallet.invalid'}});
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{setItem(){writes++;}}});
 globalThis.fetch=async()=>{sends++;throw Error('Must not broadcast');};
 t.after(()=>{for(const [k,v] of previous)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});
 const {signAndSubmitSolanaTokenSend}=await import('../src/wallet-sol-send.js');
 const owner=Keypair.generate(),to=Keypair.generate().publicKey,tx=new Transaction({feePayer:owner.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()});
 tx.add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:to,lamports:1}));
 const lifetime=requestLifetime(),provider={publicKey:owner.publicKey,signTransaction:()=>new Promise(r=>reply=r)},args={prepared:{tx},provider,owner:owner.publicKey.toBase58(),row:{mint:to.toBase58()},to:to.toBase58(),amount:'1',assertCurrent:lifetime.assert};
 const pending=signAndSubmitSolanaTokenSend(args);lifetime.close();tx.sign(owner);reply(tx);
 await assert.rejects(pending,/cancelled/);assert.equal(writes,0);assert.equal(sends,0);
 owner.secretKey.fill(0);
});
