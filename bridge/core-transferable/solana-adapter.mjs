import {PublicKey,VersionedTransaction} from '@solana/web3.js';
import {unpackMint,getTransferFeeConfig,getExtensionTypes,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {MAINNET_GENESIS} from '../core-next/deployment-policy.mjs';
import {addresses,receiptAddress,transaction,decodePosition,decodeReceipt} from './sdk.mjs';
import {canonical,digest} from './records.mjs';
import {BINARY_HASH,BINARY_SIZE} from './deployment-policy.mjs';
import {privateTestPolicy as validatePrivateTestPolicy,privateTestConfig,privateTestOperation} from './private-test.mjs';
export {BINARY_HASH,BINARY_SIZE};
const need=(v,m)=>{if(!v)throw Error(m);};
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export function createSolanaAdapter({connection,manifest,privateTestPolicy}){
 need(manifest?.abi===3&&manifest.network==='mainnet-beta'&&manifest.genesisHash===MAINNET_GENESIS&&manifest.binaryHash===BINARY_HASH&&manifest.binarySize===BINARY_SIZE,'Reviewed ABI 3 manifest required.');
 const pinned=canonical(manifest),program=new PublicKey(manifest.program),mint=new PublicKey(manifest.mint),verifier=new PublicKey(manifest.verifier);
 need(PublicKey.isOnCurve(verifier.toBytes()),'Verifier signing wallet required.');
 const testPolicy=privateTestPolicy?validatePrivateTestPolicy(privateTestPolicy,manifest):null;
 const dataKey=PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0];
 const checkedConfig=c=>{need(c?.abi===3&&c.network===manifest.network&&c.program===manifest.program&&c.verifier===manifest.verifier&&c.mint===manifest.mint,'Wrong transferable deployment.');if(testPolicy)privateTestConfig(c,testPolicy);};
 async function verifyProgram(){
  need(canonical(manifest)===pinned,'Changed deployment or Solana network.');
  // These fixed public addresses do not depend on a prior RPC result. Read
  // them together, but retain every fresh network/code/authority check.
  const [genesis,p,d]=await Promise.all([connection.getGenesisHash(),connection.getAccountInfo(program,'finalized'),connection.getAccountInfo(dataKey,'finalized')]);
  need(genesis===MAINNET_GENESIS&&canonical(manifest)===pinned,'Changed deployment or Solana network.');
  need(p?.executable&&p.owner.equals(LOADER)&&p.data.length===36&&p.data.readUInt32LE(0)===2,'Transferable program is not deployed.');
  need(new PublicKey(p.data.subarray(4)).equals(dataKey),'Changed program-data address.');
  need(d?.owner.equals(LOADER)&&!d.executable&&d.data.length>=45+BINARY_SIZE&&d.data.readUInt32LE(0)===3,'Reviewed transferable program-data required.');
  if(testPolicy)need(d.data[12]===1&&new PublicKey(d.data.subarray(13,45)).toBase58()===testPolicy.upgradeAuthority,'Private test requires the exact retained upgrade authority.');
  else need(d.data[12]===0,'Transferable program must be immutable.');
  need(digest(d.data.subarray(45,45+BINARY_SIZE))===BINARY_HASH&&d.data.subarray(45+BINARY_SIZE).every(x=>x===0),'Transferable deployed code differs from review.');
 }
 async function fee(amount){
  await verifyProgram();need(typeof amount==='string'&&/^[1-9][0-9]{0,13}$/.test(amount)&&BigInt(amount)<=50000000000000n,'Exact supported amount required.');
  if(testPolicy)need(BigInt(amount)<=BigInt(testPolicy.maxGrossAtomic),'Private test permits at most 1 XMR20.');
  const a=await connection.getAccountInfo(mint,'finalized');need(a?.owner.equals(TOKEN_2022_PROGRAM_ID),'Token-2022 mint required.');const m=unpackMint(mint,a,TOKEN_2022_PROGRAM_ID);
  need(m.decimals===6&&!m.mintAuthority&&!m.freezeAuthority&&m.supply>0n&&m.supply<=1000000000000000n&&getExtensionTypes(m.tlvData).every(e=>[1,18,19].includes(e)),'Unsupported mint authorities or extensions.');
  const f=getTransferFeeConfig(m);if(!f)return '0';const epoch=BigInt((await connection.getEpochInfo('finalized')).epoch),r=epoch>=f.newerTransferFee.epoch?f.newerTransferFee:f.olderTransferFee;
  const n=BigInt(amount),rounded=(n*BigInt(r.transferFeeBasisPoints)+9999n)/10000n,out=rounded<r.maximumFee?rounded:r.maximumFee;need(n>out,'Transfer fee consumes the amount.');return out.toString();
 }
 function validSigned(c,p,tx){
  checkedConfig(c);if(testPolicy)privateTestOperation(c,p,testPolicy);const expected=transaction(c,p),msg=tx.message.serialize();need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize())),'Changed reviewed transaction.');
  const keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures),count=['register','transfer','release'].includes(p.operation)?2:1;
  need(keys.length===count&&tx.signatures.length===count&&keys.every((k,i)=>ed25519.verify(tx.signatures[i],msg,k.toBytes())),'Every required signature must be valid.');
  return bs58.encode(tx.signatures[0]);
 }
 // Replay verifies the deployment once before reading its account set. Avoid
 // re-downloading the entire binary for every holder and receipt account.
 async function readAccount(key){const a=await connection.getAccountInfo(new PublicKey(key),'finalized');return a?{owner:a.owner.toBase58(),executable:a.executable,finalized:true,data:Uint8Array.from(a.data)}:null;}
 async function outcome(tx,lastValidBlockHeight){
  need(Number.isSafeInteger(lastValidBlockHeight)&&lastValidBlockHeight>0,'Saved expiry required.');const signature=bs58.encode(tx.signatures[0]);
  const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(status)return {kind:status.confirmationStatus==='finalized'?(status.err?'failed':'finalized'):'pending',signature};
  if(await connection.getBlockHeight('finalized')<=lastValidBlockHeight)return {kind:'pending',signature};
  const r=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(r)return {kind:r.meta?.err?'failed':'finalized',signature};
  if((await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0])return {kind:'pending',signature};
  need((await connection.isBlockhashValid(tx.message.recentBlockhash,{commitment:'finalized'})).value===false,'RPC expiry evidence disagrees.');return {kind:'expired',signature};
 }
 return Object.freeze({verifyProgram,readAccount,fee,
  async prepare(config,terms){checkedConfig(config);if(testPolicy)privateTestOperation(config,terms,testPolicy);await verifyProgram();const latest=await connection.getLatestBlockhash('confirmed'),proposal={network:config.network,...terms,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};return {config,proposal,transaction:transaction(config,proposal)};},
  async submit(config,proposal,tx){await verifyProgram();validSigned(config,proposal,tx);if(proposal.operation!=='register'){const current=await fee(proposal.amount);if(proposal.operation!=='transfer')need(current===proposal.expectedFee,'Token fee changed.');}return connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});},
  async finalizedOperation({config,proposal,bytes}){
   await verifyProgram();const tx=VersionedTransaction.deserialize(bytes),signature=validSigned(config,proposal,tx),r=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!r)return null;
   need(r.meta?.err===null&&r.transaction.signatures[0]===signature&&Buffer.from(r.transaction.message.serialize()).equals(Buffer.from(tx.message.serialize())),'Operation did not finalize with the exact approval.');
   const a=addresses(config);
   if(proposal.operation==='register'){
    const raw=await readAccount(a.position.toBase58());need(raw?.owner===manifest.program&&!raw.executable,'Finalized linked position missing.');const p=decodePosition(raw.data);need(p.owner===config.owner&&p.verifier===manifest.verifier&&p.mint===manifest.mint&&p.binding===config.binding&&p.linkProof===proposal.commitment,'Finalized wallet link differs from approval.');
   }else{
    const raw=await readAccount(receiptAddress(config,proposal.nonce).toBase58());need(raw?.owner===manifest.program&&!raw.executable,'Finalized operation receipt missing.');const p=decodeReceipt(raw.data),kind={deposit:2,release:3,transfer:4,donate:5}[proposal.operation],actor=proposal.actor??config.owner,dest=proposal.operation==='transfer'?addresses({...config,owner:proposal.toOwner}).position.toBase58():proposal.operation==='release'?config.owner:a.position.toBase58(),from=kind===2||kind===5?actor:a.position.toBase58(),fee=kind===4?'0':proposal.expectedFee;
    need(p.kind===kind&&p.from===from&&p.to===dest&&p.nonce===proposal.nonce&&p.commitment===proposal.commitment&&p.gross===proposal.amount&&p.fee===fee&&BigInt(p.net)===BigInt(p.gross)-BigInt(fee),'Finalized receipt differs from exact approval.');
   }
   return {signature,confirmed:true};
  },
  async pendingOutcome({bytes,lastValidBlockHeight}){
   await verifyProgram();need(Number.isSafeInteger(lastValidBlockHeight)&&lastValidBlockHeight>0,'Saved expiry required.');const tx=VersionedTransaction.deserialize(bytes),msg=tx.message.serialize(),keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
   need(tx.signatures.length===keys.length&&keys.every((k,i)=>ed25519.verify(tx.signatures[i],msg,k.toBytes())),'Changed saved signatures.');return outcome(tx,lastValidBlockHeight);
  },
  // Read-only recovery for a holder approval that may never have reached the
  // co-signer. This does not relax fully signed submission or custody checks.
  async ownerApprovalOutcome({config,proposal,bytes}){
   await verifyProgram();checkedConfig(config);if(testPolicy)privateTestOperation(config,proposal,testPolicy);
   const tx=VersionedTransaction.deserialize(bytes),msg=tx.message.serialize(),expected=transaction(config,proposal),keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures);
   need(Buffer.from(msg).equals(Buffer.from(expected.message.serialize()))&&tx.signatures.length===keys.length&&keys.every((k,i)=>i>0&&tx.signatures[i].every(x=>x===0)||ed25519.verify(tx.signatures[i],msg,k.toBytes())),'Changed saved owner approval.');
   return outcome(tx,proposal.lastValidBlockHeight);
  }
 });
}
