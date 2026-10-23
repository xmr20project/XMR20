import test from 'node:test';import assert from 'node:assert/strict';
import {websiteBridgeProvider,websiteMoneroSigner} from '../src/transferable-wallet-adapter.js';
import {websiteBridgeRoute} from '../src/bridge-route.js';
import {readFileSync} from 'node:fs';
import {Keypair,ComputeBudgetProgram} from '@solana/web3.js';
import {transaction,creditCommitment,approveExternal} from '../../bridge/core-transferable/sdk.mjs';
import {digest,message} from '../../bridge/core-transferable/records.mjs';
const owner='owner';
test('new Solana deposits use ABI3 while old Monero balances and saved receipts retain legacy recovery',()=>{assert.equal(websiteBridgeRoute({kind:'bridge',network:'solana'}),'transferable');assert.equal(websiteBridgeRoute({kind:'bridge',network:'monero'}),'legacy');assert.equal(websiteBridgeRoute({kind:'bridge',network:'solana',resumeId:'saved'}),'legacy');assert.equal(websiteBridgeRoute({kind:'bridge',network:'monero',bridgeProtocol:'transferable'}),'transferable');assert.equal(websiteBridgeRoute({kind:'send',network:'solana'}),'legacy');});
test('Phantom approval delegates the exact transaction and checks account after wallet response',async()=>{let selected=owner,called=0;const tx={message:'exact'},p={publicKey:{toBase58:()=>selected},signTransaction:async t=>{assert.equal(t,tx);called++;return t;}};const bridge=websiteBridgeProvider(p,owner,()=>{});assert.equal(await bridge.signTransaction(tx),tx);p.signTransaction=async()=>{selected='other';return tx;};await assert.rejects(()=>bridge.signTransaction(tx),/Wallet changed/);assert.equal(called,1);});
test('closing the page before approval stops external signing',async()=>{let calls=0;const p={publicKey:{toBase58:()=>owner},signTransaction:async()=>{calls++;}};await assert.rejects(()=>websiteBridgeProvider(p,owner,()=>{throw Error('Closed');}).signTransaction({}),/Closed/);assert.equal(calls,0);});
test('invalid native reviews are rejected before encrypted key unlock',async()=>{let loads=0;const sign=websiteMoneroSigner({provider:{},owner,address:'wrong',assert:()=>{},vault:{load:async()=>{loads++;}}});await assert.rejects(()=>sign({record:{}},{config:{}},new AbortController().signal));assert.equal(loads,0);});
test('website native signing exposes wallet unlock and signing phases without exposing vault contents',async()=>{
 const address='45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q',owner=Keypair.generate().publicKey.toBase58(),config={abi:3,network:'mainnet-beta',program:Keypair.generate().publicKey.toBase58(),mint:Keypair.generate().publicKey.toBase58(),verifier:Keypair.generate().publicKey.toBase58(),owner,binding:digest(address)},record={p:'xmr20-joint',v:3,net:'mainnet',op:'link',owner:address,to:owner,mint:config.mint,program:config.program,nonce:'ee'.repeat(32)},review={record,message:message(record)},context={schema:'joint-owner-review-v3',config,moneroOwner:address,expectedRecord:record};
 for(const abort of [false,true]){
  const controller=new AbortController(),progress=[];let workers=0;
  const sign=websiteMoneroSigner({owner,address,provider:{},assert(){},vault:{async load(c,p,{onProgress}){onProgress('approval');if(abort)controller.abort();onProgress('encrypting');return 'synthetic-only-vault-content';}},worker:async(action,args)=>{workers++;assert.equal(action,'sign-owner-record-v3');assert.equal(args.review,review);return {signature:'synthetic-only-signature'};}});
  const result=sign(review,context,controller.signal,{onProgress:text=>progress.push(text)});
  if(abort){await assert.rejects(result,/Bridge closed/);assert.equal(workers,0);assert.equal(progress.length,1);}
  else{assert.deepEqual(await result,{signature:'synthetic-only-signature'});assert.equal(workers,1);assert.deepEqual(progress,['Open your connected wallet to unlock Monero signing…','Unlocking your saved Monero wallet…','Signing your Monero record…']);}
  assert.doesNotMatch(progress.join(' '),/synthetic-only|vault-content|signature/);
 }
});
test('the actual session binding preserves injected batch context and account guards',async()=>{
 const source=readFileSync(new URL('../src/wallet-session.jsx',import.meta.url),'utf8');
 const start=source.indexOf('  const p={kind,'),end=source.indexOf('  setProvider(p);',start);assert.ok(start>=0&&end>start);
 const bind=new Function('kind','epoch','revision','injected','address',source.slice(start,end)+'return p;');
 let selected=owner,calls=0;const epoch={current:3},injected={publicKey:{toBase58:()=>selected},async signAllTransactions(txs){assert.equal(this,injected);calls++;return txs;}};
 const session=bind('phantom',epoch,3,injected,owner);assert.equal(session.kind,'phantom');
 const tx={message:'exact'};assert.deepEqual(await session.signAllTransactions([tx]),[tx]);assert.equal(calls,1);
 selected='other';await assert.rejects(session.signAllTransactions([tx]),/Wallet changed/);assert.equal(calls,1);
 selected=owner;injected.signAllTransactions=async()=>{selected='other';return [tx];};const changing=bind('phantom',epoch,3,injected,owner);await assert.rejects(changing.signAllTransactions([tx]),/Wallet changed/);
 const unsupported=bind('phantom',epoch,3,{publicKey:{toBase58:()=>owner}},owner);assert.equal(unsupported.signAllTransactions,undefined);
});
test('Phantom bridge requests one sign-only batch and unchanged SDK owner approval passes',async t=>{
 const key=Keypair.generate();t.after(()=>key.secretKey.fill(0));const owner=key.publicKey.toBase58(),config={abi:3,network:'mainnet-beta',program:Keypair.generate().publicKey.toBase58(),mint:Keypair.generate().publicKey.toBase58(),verifier:Keypair.generate().publicKey.toBase58(),owner,binding:digest('synthetic-link')};
 const p={network:config.network,operation:'deposit',actor:owner,amount:'1000000',expectedFee:'15000',nonce:'ab'.repeat(32),blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100};p.commitment=creditCommitment(config,p);
 let batch=0,single=0,submit=0;const injected={kind:'phantom',publicKey:key.publicKey,async signAllTransactions(txs){assert.equal(this,injected);assert.equal(txs.length,1);batch++;txs[0].sign([key]);return txs;},async signTransaction(){single++;throw Error('Must use the bridge batch');},async signAndSendTransaction(){submit++;throw Error('Must not send');}};
 const wrapped=websiteBridgeProvider(injected,owner,()=>{}),bytes=transaction(config,p).serialize();
 const signed=await approveExternal(config,p,bytes,wrapped);assert.deepEqual(signed.message.serialize(),transaction(config,p).message.serialize());assert.equal(batch,1);assert.equal(single,0);assert.equal(submit,0);
 injected.signAllTransactions=async txs=>{batch++;txs[0].message.compiledInstructions[1].data=ComputeBudgetProgram.setComputeUnitPrice({microLamports:20000}).data;txs[0].sign([key]);return txs;};
 await assert.rejects(approveExternal(config,p,bytes,wrapped),error=>error.code==='WALLET_APPROVAL_MISMATCH'&&error.approvalDiagnostic.reason==='compute-budget-changed');assert.equal(batch,2);assert.equal(single,0);assert.equal(submit,0);
});
test('batch failure or malformed results never trigger a second approval; unsupported wallets keep the single path',async()=>{
 let batch=0,single=0,selected=owner;const tx={message:'exact'},provider={kind:'phantom',publicKey:{toBase58:()=>selected},async signAllTransactions(){batch++;throw Error('Approval rejected');},async signTransaction(){single++;return tx;}};
 const bridge=websiteBridgeProvider(provider,owner,()=>{});await assert.rejects(bridge.signTransaction(tx),/Approval rejected/);assert.equal(batch,1);assert.equal(single,0);
 for(const response of [null,[],[tx,tx],[null]]){provider.signAllTransactions=async()=>{batch++;return response;};await assert.rejects(bridge.signTransaction(tx),/Nothing was submitted/);}assert.equal(batch,5);assert.equal(single,0);
 provider.signAllTransactions=async()=>{batch++;selected='other';return [tx];};await assert.rejects(bridge.signTransaction(tx),/Wallet changed/);assert.equal(batch,6);assert.equal(single,0);
 selected=owner;delete provider.signAllTransactions;assert.equal(await bridge.signTransaction(tx),tx);assert.equal(single,1);
 provider.kind='solflare';provider.signAllTransactions=async()=>{throw Error('Solflare bridge path must be unchanged');};assert.equal(await bridge.signTransaction(tx),tx);assert.equal(single,2);
});
