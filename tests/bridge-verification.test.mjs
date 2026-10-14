import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {withBridgeVerification,prepareBridgeSolana,expectedBridgeInstructions,escrowAddresses,BRIDGE_PROGRAMS} from '../review/bridge.mjs';
const require=createRequire(import.meta.url);
const {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction}=require('@solana/web3.js');
const {MintLayout,AccountLayout,TOKEN_2022_PROGRAM_ID}=require('@solana/spl-token');
const genesis='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
function fixture(overrides={}){
 const owner=Keypair.generate().publicKey,attestor=Keypair.generate().publicKey;
 const a={sol:owner.toBase58(),xmr:'4'+'A'.repeat(94)};
 const row={id:'synthetic-launch',mint:Keypair.generate().publicKey.toBase58(),deployment:'a'.repeat(64),bridgeVersion:1,program:BRIDGE_PROGRAMS[1]};
 const t={id:'synthetic-bridge',owner:a.sol,launchId:row.id,mint:row.mint,moneroAddress:a.xmr,direction:'xmr-to-sol',amountRaw:'100000000',transferTaxRaw:'0',netReceivedRaw:'100000000',state:'source_finalized',sourceTxid:'b'.repeat(64)};
 const addresses=escrowAddresses(row.program,row.mint),configData=Buffer.alloc(138);configData[0]=1;
 configData.set(new PublicKey(row.mint).toBuffer(),1);configData.set(attestor.toBuffer(),33);configData.set(addresses.vault.toBuffer(),65);configData.set(Buffer.from(row.deployment,'hex'),97);configData.writeBigUInt64LE(100000000n,129);
 const mintData=Buffer.alloc(MintLayout.span);MintLayout.encode({mintAuthorityOption:0,mintAuthority:SystemProgram.programId,supply:1000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:SystemProgram.programId},mintData);
 const vaultData=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:new PublicKey(row.mint),owner:addresses.config,amount:1000000000n,delegateOption:0,delegate:SystemProgram.programId,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:SystemProgram.programId},vaultData);
 const info=(owner,data)=>({owner,data,executable:false,lamports:1,rentEpoch:0});
 const blockhash=Keypair.generate().publicKey.toBase58(),tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:blockhash,instructions:expectedBridgeInstructions(t,a,row,attestor.toBase58())}).compileToV0Message());
 const p={transaction:Buffer.from(tx.serialize()).toString('base64'),program:row.program,blockhash,lastValidBlockHeight:100,ticket:'synthetic-unsigned-review',network:'mainnet-beta',simulationPassed:true,estimatedSolDebitLamports:10000};
 const c={getGenesisHash:async()=>genesis,getMultipleAccountsInfo:async()=>[info(new PublicKey(row.program),configData),info(TOKEN_2022_PROGRAM_ID,mintData),info(TOKEN_2022_PROGRAM_ID,vaultData)],getBalance:async()=>100000000,getFeeForMessage:async()=>({value:5000}),simulateTransaction:async()=>({value:{err:null,accounts:[{lamports:99980000}]}}),getBlockHeight:async()=>10,...overrides};
 return {a,row,t,p,c};
}
test('an unresponsive verification has one bounded deadline and cannot return a review',async()=>{
 const start=Date.now();await assert.rejects(withBridgeVerification(()=>new Promise(()=>{}),{c:{},timeoutMs:20}),/existing bridge is saved/);assert.ok(Date.now()-start<1000);
});
test('the actual RPC fetch is aborted on deadline and rate limits are not silently retried',async()=>{
 let aborted=false,calls=0;
 await assert.rejects(withBridgeVerification(c=>c.getGenesisHash(),{timeoutMs:20,fetcher:(_url,options)=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});})}),/existing bridge is saved/);
 assert.equal(aborted,true);
 await assert.rejects(withBridgeVerification(c=>c.getGenesisHash(),{fetcher:async()=>{calls++;return new Response('busy',{status:429});}}),/429/);assert.equal(calls,1);
});
test('verification transport rejects broadcasts and caller cancellation',async()=>{
 let calls=0;await assert.rejects(withBridgeVerification(c=>c.sendRawTransaction(Uint8Array.of(1)),{fetcher:async()=>{calls++;return new Response('{}');}}),/Only bridge verification reads/);assert.equal(calls,0);
 const controller=new AbortController(),pending=withBridgeVerification(()=>new Promise(()=>{}),{c:{},signal:controller.signal});controller.abort();await assert.rejects(pending,/closed or changed/);
});
test('verification uses the existing wallet Helius proxy without a client credential or transaction change',async()=>{
 const calls=[];
 const result=await withBridgeVerification(c=>c.getGenesisHash(),{fetcher:async(url,options)=>{
  const envelope=JSON.parse(options.body);calls.push({url,envelope,options});
  assert.equal(url,'https://xmr20.org/api/wallet');assert.equal(envelope.action,'walletRpc');assert.equal(envelope.rpc.method,'getGenesisHash');assert.deepEqual(envelope.rpc.params,[]);assert.deepEqual(Object.keys(envelope).sort(),['action','rpc']);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.signal instanceof AbortSignal,true);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:envelope.rpc.id,result:genesis}));
 }});
 assert.equal(result,genesis);assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);
});
test('fresh escrow verification starts independent checks together and checks expiry last',async()=>{
 const started=[];let release;const gate=new Promise(r=>release=r);const begin=name=>{started.push(name);if(started.length===3)release();return gate;};
 const f=fixture({getBalance:async()=>{await begin('balance');return 100000000;},getFeeForMessage:async()=>{await begin('fee');return {value:5000};},simulateTransaction:async(_tx,options)=>{assert.equal(options.sigVerify,false);assert.equal(options.commitment,'confirmed');await begin('simulation');return {value:{err:null,accounts:[{lamports:99980000}]}};},getBlockHeight:async()=>{assert.deepEqual(new Set(started),new Set(['balance','fee','simulation']));return 10;}});
 const stages=[],review=await prepareBridgeSolana(f.p,f.t,f.a,f.row,{c:f.c,onStage:text=>stages.push(text),timeoutMs:1000});
 assert.equal(review.feeRaw,'25000');assert.equal(review.attestor.length>0,true);assert.equal(review.tx.signatures.every(bytes=>bytes.every(n=>n===0)),true);assert.equal(stages.length,2);
});
test('network and escrow public reads start together; wrong network or backing stops further checks',async()=>{
 const f=fixture(),accounts=f.c.getMultipleAccountsInfo,started=[];let release;const gate=new Promise(r=>release=r);
 const start=name=>{started.push(name);if(started.length===2)release();return gate;};
 f.c.getGenesisHash=async()=>{await start('genesis');return genesis;};
 f.c.getMultipleAccountsInfo=async(...args)=>{await start('accounts');return accounts(...args);};
 await prepareBridgeSolana(f.p,f.t,f.a,f.row,{c:f.c,timeoutMs:1000});assert.deepEqual(new Set(started),new Set(['genesis','accounts']));
 for(const bad of ['network','backing']){
  const denied=fixture(),original=denied.c.getMultipleAccountsInfo;let reads=0,financialChecks=0;
  denied.c.getGenesisHash=async()=>{reads++;return bad==='network'?'wrong-network':genesis;};
  denied.c.getMultipleAccountsInfo=async(...args)=>{reads++;const infos=await original(...args);if(bad==='backing')infos[2].data.writeBigUInt64LE(0n,64);return infos;};
  for(const method of ['getEpochInfo','getBalance','getFeeForMessage','simulateTransaction','getBlockHeight'])denied.c[method]=async()=>{financialChecks++;throw Error('Further checks must not start');};
  await assert.rejects(prepareBridgeSolana(denied.p,denied.t,denied.a,denied.row,{c:denied.c}),bad==='network'?/Wrong Solana network/:/Invalid bridge token or backing/);
  assert.equal(reads,2);assert.equal(financialChecks,0);
 }
});
test('deadline, wrong chain, simulation failure, changed instruction and final expiry fail closed',async()=>{
 for(const [override,pattern] of [[{getGenesisHash:async()=> 'wrong-network'},/Wrong Solana network/],[{simulateTransaction:async()=>({value:{err:{InstructionError:[0,'Custom']},accounts:[{lamports:99980000}]}})},/simulation failed/],[{getBlockHeight:async()=>100},/Approval expired/],[{getBalance:()=>new Promise(()=>{})},/existing bridge is saved/]]){
  const f=fixture(override);await assert.rejects(prepareBridgeSolana(f.p,f.t,f.a,f.row,{c:f.c,timeoutMs:20}),pattern);
 }
 const f=fixture();await assert.rejects(prepareBridgeSolana({...f.p,blockhash:Keypair.generate().publicKey.toBase58()},f.t,f.a,f.row,{c:f.c}),/differs from the reviewed bridge/);
});
