import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,TransactionMessage,TransactionInstruction,VersionedTransaction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {matchesWalletApproval,verifyWalletGuardProgram,LIGHTHOUSE_PROGRAM,LIGHTHOUSE_DATA} from '../bridge/core-transferable/wallet-guards.mjs';
import {transaction,creditCommitment,approveExternal} from '../bridge/core-transferable/sdk.mjs';
import {digest} from '../bridge/core-transferable/records.mjs';
const key=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
 const owner=Keypair.generate(),config={abi:3,network:'mainnet-beta',owner:owner.publicKey.toBase58(),program:key(),mint:key(),verifier:key(),binding:digest('test-binding')};
 const proposal={network:config.network,operation:'deposit',actor:config.owner,amount:'1000000',expectedFee:'15000',nonce:digest('test-nonce'),blockhash:key()};proposal.commitment=creditCommitment(config,proposal);
 const expected=transaction(config,proposal);
 const guard=new TransactionInstruction({programId:new PublicKey(LIGHTHOUSE_PROGRAM),keys:[{pubkey:owner.publicKey,isWritable:false,isSigner:false}],data:Buffer.from([5,0,0,...new Uint8Array(8),4])});
 const edit=(fn)=>{const m=TransactionMessage.decompile(VersionedTransaction.deserialize(expected.serialize()).message);fn(m);return new VersionedTransaction(m.compileToV0Message());};
 return {owner,config,proposal,expected,guard,edit};
}
test('only known read-only wallet guards may augment an unchanged deposit',async()=>{
 const f=fixture(),signed=f.edit(m=>{m.instructions.splice(2,0,f.guard);m.instructions.push(f.guard);});
 assert.ok(matchesWalletApproval(f.expected.message,signed.message,'deposit'));
 assert.equal(matchesWalletApproval(f.expected.message,signed.message,'register'),false);
 const provider={publicKey:f.owner.publicKey,async signTransaction(){signed.sign([f.owner]);return signed;}};
 assert.equal(await approveExternal(f.config,f.proposal,f.expected.serialize(),provider),signed);
 assert.notDeepEqual(signed.message.serialize(),f.expected.message.serialize(),'Actual guarded bytes must remain signed, never stripped.');
 f.owner.secretKey.fill(0);
});
test('a guard cannot hide changed amount, fee, destination, blockhash, budget, signer or privilege',()=>{
 const f=fixture(),checks=[
  m=>{m.instructions.at(-1).data[1]^=1;},m=>{m.instructions.at(-1).data[m.instructions.at(-1).data.length-1]^=1;},
  m=>{m.instructions.at(-1).keys[7].pubkey=Keypair.generate().publicKey;},
  m=>{m.recentBlockhash=key();},m=>{m.instructions[1]=ComputeBudgetProgram.setComputeUnitPrice({microLamports:20000});},
  m=>{m.instructions.at(-1).keys[3].isWritable=true;},m=>{m.instructions.at(-1).keys[3].isSigner=true;},
  m=>{m.instructions.push(SystemProgram.transfer({fromPubkey:f.owner.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));},
  m=>{m.instructions.reverse();},m=>{m.instructions.pop();},m=>{m.instructions.push(m.instructions.at(-1));}
 ];
 for(const mutate of checks){const tx=f.edit(m=>{mutate(m);m.instructions.push(f.guard);});assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),false);}
 f.owner.secretKey.fill(0);
});
test('memory operations, unknown variants/programs, CPI log modes and additional writes are rejected',()=>{
 const f=fixture();
 for(const code of [0,1,16,18,255]){const tx=f.edit(m=>m.instructions.push(new TransactionInstruction({...f.guard,data:Buffer.from([code,0,0])})));assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),false);}
 for(const mode of [3,6,16,17,18,255]){const data=Buffer.from(f.guard.data);data[1]=mode;const tx=f.edit(m=>m.instructions.push(new TransactionInstruction({...f.guard,data})));assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),false);}
 for(const extra of [
  {...f.guard,programId:Keypair.generate().publicKey},
  {...f.guard,keys:[{pubkey:Keypair.generate().publicKey,isWritable:true,isSigner:false}]},
  {...f.guard,keys:[{pubkey:Keypair.generate().publicKey,isWritable:false,isSigner:true}]},
  {...f.guard,keys:[]}, {...f.guard,data:Buffer.from([5,0])}
 ]){const tx=f.edit(m=>m.instructions.push(new TransactionInstruction(extra)));assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),false);}
 const tx=f.edit(m=>{for(let i=0;i<17;i++)m.instructions.push(f.guard);});assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),false);
 f.owner.secretKey.fill(0);
});
test('guard compatibility still rejects invalid owner signatures and registration changes',async()=>{
 const f=fixture(),signed=f.edit(m=>m.instructions.push(f.guard)),provider={publicKey:f.owner.publicKey,signTransaction:async()=>signed};
 await assert.rejects(approveExternal(f.config,f.proposal,f.expected.serialize(),provider),/signature does not match/);
 assert.equal(matchesWalletApproval(f.expected.message,signed.message,'register'),false);
 assert.equal(matchesWalletApproval(f.expected.message,signed.message,'unknown'),false);
 f.owner.secretKey.fill(0);
});
test('guard program verification rejects mutable, mismatched and unavailable deployments',async()=>{
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),p=Buffer.alloc(36),d=Buffer.alloc(424293);p.writeUInt32LE(2);new PublicKey(LIGHTHOUSE_DATA).toBuffer().copy(p,4);d.writeUInt32LE(3);
 const rpc={getAccountInfo:async k=>k.toBase58()===LIGHTHOUSE_PROGRAM?{owner:loader,executable:true,data:p}:{owner:loader,executable:false,data:d}};
 await assert.rejects(verifyWalletGuardProgram(rpc),/could not be verified/);d[12]=1;await assert.rejects(verifyWalletGuardProgram(rpc),/could not be verified/);
 await assert.rejects(verifyWalletGuardProgram({getAccountInfo:async()=>null}),/could not be verified/);
});

test('pure mint, account, clock and failure-only logging assertions retain the exact deposit',()=>{
 const f=fixture();
 for(const variant of [2,3,4,5,6,7,8,9,10,11,12,13,14,15,17])for(const mode of [0,1,2,4,5]){
  const keys=variant===15?[]:variant===4?[...f.guard.keys,...f.guard.keys]:f.guard.keys;
  const tx=f.edit(m=>m.instructions.push(new TransactionInstruction({...f.guard,keys,data:Buffer.from([variant,mode,0])})));
  assert.equal(matchesWalletApproval(f.expected.message,tx.message,'deposit'),true,`${variant}/${mode}`);
 }
});

for(const operation of ['transfer','release'])test(`Phantom assertions preserve both signatures and exact ${operation} terms`,async()=>{
 const f=fixture(),verifier=Keypair.generate();f.config.verifier=verifier.publicKey.toBase58();
 const proposal={...f.proposal,operation,commitment:digest('confirmed-'+operation),toOwner:key()};
 const expected=transaction(f.config,proposal);
 const edit=(mutate=()=>{})=>{const m=TransactionMessage.decompile(VersionedTransaction.deserialize(expected.serialize()).message);mutate(m);m.instructions.push(f.guard);return new VersionedTransaction(m.compileToV0Message());};
 const signed=edit();signed.sign([f.owner]);
 const provider={publicKey:f.owner.publicKey,signTransaction:async()=>signed};
 assert.equal(await approveExternal(f.config,proposal,expected.serialize(),provider),signed);
 assert.equal(signed.signatures.length,2);assert.ok(signed.signatures[1].every(n=>n===0));
 const ownerSignature=Buffer.from(signed.signatures[0]);signed.sign([verifier]);
 assert.deepEqual(Buffer.from(signed.signatures[0]),ownerSignature,'Verifier must sign the actual owner-approved message.');
 assert.ok(matchesWalletApproval(expected.message,signed.message,operation));
 await assert.rejects(approveExternal(f.config,proposal,expected.serialize(),provider),/another signer/);
 for(const mutate of [
  m=>{m.instructions.at(-1).data[1]^=1;}, // amount
  m=>{m.instructions.at(-1).data[9]^=1;}, // nonce
  m=>{m.instructions.at(-1).data[41]^=1;}, // public proof commitment
  m=>{m.instructions.at(-1).keys.at(-1).pubkey=Keypair.generate().publicKey;}, // recipient or verifier
  m=>{m.instructions.at(-1).keys[0].pubkey=Keypair.generate().publicKey;}, // holder
  m=>{m.recentBlockhash=key();},
  m=>{m.instructions[1]=ComputeBudgetProgram.setComputeUnitPrice({microLamports:20000});},
  m=>{m.instructions.push(SystemProgram.transfer({fromPubkey:f.owner.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));},
  m=>{m.instructions.push(new TransactionInstruction({programId:new PublicKey(LIGHTHOUSE_PROGRAM),keys:[],data:Buffer.from([0,0,0])}));},
  m=>{m.instructions.push(new TransactionInstruction({programId:new PublicKey(LIGHTHOUSE_PROGRAM),keys:[{pubkey:Keypair.generate().publicKey,isWritable:true,isSigner:false}],data:f.guard.data}));}
 ]){
  const altered=edit(mutate);if(altered.message.staticAccountKeys.slice(0,altered.message.header.numRequiredSignatures).some(k=>k.equals(f.owner.publicKey)))altered.sign([f.owner]);
  assert.equal(matchesWalletApproval(expected.message,altered.message,operation),false);
  await assert.rejects(approveExternal(f.config,proposal,expected.serialize(),{...provider,signTransaction:async()=>altered}),/Nothing was submitted/);
 }
 f.owner.secretKey.fill(0);verifier.secretKey.fill(0);
});
