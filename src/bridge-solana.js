import {Buffer} from 'buffer';
import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,unpackMint,unpackAccount,getTransferFeeConfig,getAccountLenForMint,calculateEpochFee} from '@solana/spl-token';
import {sha256} from '@noble/hashes/sha256';
import {bridgeAmounts,validateBridgeReceipt} from './bridge-policy.js';
import {connection,importSol,bs58} from './core.js';
const pk=x=>new PublicKey(x),hash=x=>Buffer.from(sha256(new TextEncoder().encode(x)));
const meta=(key,isSigner=false,isWritable=false)=>({pubkey:pk(key),isSigner,isWritable});
export function escrowAddresses(program,mint){const p=pk(program),m=pk(mint),[config]=PublicKey.findProgramAddressSync([Buffer.from('xmr20'),m.toBuffer()],p);return {config,vault:getAssociatedTokenAddressSync(m,config,true,TOKEN_2022_PROGRAM_ID),receipt:(type,id)=>PublicKey.findProgramAddressSync([Buffer.from(type),config.toBuffer(),id],p)[0]};}
export function expectedBridgeInstructions(t,a,row,attestor){
 const p=pk(row.program),m=pk(row.mint),owner=pk(a.sol),s=escrowAddresses(p,m),ata=getAssociatedTokenAddressSync(m,owner,false,TOKEN_2022_PROGRAM_ID);
 const common=[meta(owner,true,true),meta(s.config,false,true),meta(m),meta(s.vault,false,true),meta(TOKEN_2022_PROGRAM_ID),meta(SystemProgram.programId)];
 const ixs=[ComputeBudgetProgram.setComputeUnitLimit({units:300000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0})];let data,keys;
 if(t.direction==='sol-to-xmr'){data=Buffer.alloc(73);data[0]=1;data.writeBigUInt64LE(BigInt(t.amountRaw),1);hash(t.id).copy(data,9);hash(a.xmr).copy(data,41);keys=[...common,meta(ata,false,true),meta(s.receipt('deposit',hash(t.id)),false,true)];}
 else{if(!/^[a-f0-9]{64}$/.test(t.sourceTxid||''))throw Error('Confirmed Monero burn receipt missing.');data=Buffer.alloc(41);data[0]=2;data.writeBigUInt64LE(BigInt(t.amountRaw),1);Buffer.from(t.sourceTxid,'hex').copy(data,9);keys=[...common,meta(ata,false,true),meta(s.receipt('withdraw',Buffer.from(t.sourceTxid,'hex')),false,true),meta(attestor,true)];ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner,ata,owner,m,TOKEN_2022_PROGRAM_ID));}
 ixs.push(new TransactionInstruction({programId:p,keys,data}));return ixs;
}
export function validateBridgeTransaction(prepared,t,a,row,attestor){
 validateBridgeReceipt(t,a,row);
 if(t.direction==='sol-to-xmr'?t.state!=='reserved':t.state!=='source_finalized'||t.destinationSignature)throw Error('Bridge is not awaiting this approval.');
 if(prepared?.network!=='mainnet-beta'||prepared.program!==row.program||prepared.simulationPassed!==true||typeof prepared.ticket!=='string'||prepared.ticket.length>30000||typeof prepared.transaction!=='string'||prepared.transaction.length>1800||!Number.isSafeInteger(prepared.lastValidBlockHeight)||!Number.isSafeInteger(prepared.estimatedSolDebitLamports)||prepared.estimatedSolDebitLamports<0||prepared.estimatedSolDebitLamports>50000000)throw Error('Unverified bridge transaction.');
 const bytes=Buffer.from(prepared.transaction,'base64');if(bytes.length>1232)throw Error('Bridge transaction too large.');
 const tx=VersionedTransaction.deserialize(bytes),expected=new TransactionMessage({payerKey:pk(a.sol),recentBlockhash:prepared.blockhash,instructions:expectedBridgeInstructions(t,a,row,attestor)}).compileToV0Message();
 if(!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.serialize()))||tx.signatures.some(s=>s.some(v=>v!==0)))throw Error('Transaction differs from the reviewed bridge. Nothing signed.');
 return tx;
}
async function chainState(a,row,c){
 if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Wrong Solana network.');
 const s=escrowAddresses(row.program,row.mint),[configInfo,mintInfo,vaultInfo]=await c.getMultipleAccountsInfo([s.config,pk(row.mint),s.vault],'finalized');
 if(!configInfo||!configInfo.owner.equals(pk(row.program))||configInfo.data.length!==138||configInfo.data[0]!==row.bridgeVersion)throw Error('Bridge escrow could not be verified.');
 const d=Buffer.from(configInfo.data),attestor=pk(d.subarray(33,65)).toBase58();
 if(pk(d.subarray(1,33)).toBase58()!==row.mint||pk(d.subarray(65,97)).toBase58()!==s.vault.toBase58()||d.subarray(97,129).toString('hex')!==row.deployment)throw Error('Bridge escrow belongs to another token.');
 const mint=unpackMint(pk(row.mint),mintInfo,TOKEN_2022_PROGRAM_ID),vault=unpackAccount(s.vault,vaultInfo,TOKEN_2022_PROGRAM_ID);
 if(mint.decimals!==6||mint.mintAuthority||mint.freezeAuthority||!vault.mint.equals(pk(row.mint))||!vault.owner.equals(s.config)||vault.delegate||vault.closeAuthority||vault.isFrozen||vault.amount<d.readBigUInt64LE(129))throw Error('Invalid bridge token or backing.');
 const fee=getTransferFeeConfig(mint),rate=row.bridgeVersion>=2?150:0;
 if((fee?.olderTransferFee.transferFeeBasisPoints||0)!==rate||(fee?.newerTransferFee.transferFeeBasisPoints||0)!==rate)throw Error('Token transfer fee changed.');
 return {attestor,mint,fee};
}
export async function bridgeSolReserve(a,row,{c=connection}={}){
 const {mint}=await chainState(a,row,c),ata=getAssociatedTokenAddressSync(pk(row.mint),pk(a.sol),false,TOKEN_2022_PROGRAM_ID),exists=await c.getAccountInfo(ata,'confirmed');
 const rent=await c.getMinimumBalanceForRentExemption(row.bridgeVersion>=2?154:138,'confirmed');
 const ataRent=exists?0:await c.getMinimumBalanceForRentExemption(getAccountLenForMint(mint),'confirmed');
 const needed=rent+ataRent+10000,balance=await c.getBalance(pk(a.sol),'confirmed');
 if(balance<needed)throw Error(`Add SOL to ${a.sol.slice(0,6)}…${a.sol.slice(-5)} for bridge network/account fees (about ${(needed/1e9).toFixed(6)} SOL).`);
 return needed;
}
export async function prepareBridgeSolana(prepared,t,a,row,{c=connection}={}){
 const {attestor,fee}=await chainState(a,row,c),tx=validateBridgeTransaction(prepared,t,a,row,attestor);
 if(fee){const epoch=(await c.getEpochInfo('confirmed')).epoch;if(calculateEpochFee(fee,epoch,BigInt(t.amountRaw))!==bridgeAmounts(t,row.bridgeVersion).fee)throw Error('On-chain token fee differs from your review.');}
 if(await c.getBlockHeight('confirmed')>=prepared.lastValidBlockHeight)throw Error('Approval expired. Prepare it again.');
 const balance=await c.getBalance(pk(a.sol),'confirmed'),networkFee=(await c.getFeeForMessage(tx.message,'confirmed')).value;
 if(!Number.isSafeInteger(networkFee)||networkFee<0)throw Error('Solana network fee unavailable.');
 const sim=await c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[a.sol]}});
 const after=sim.value.accounts?.[0]?.lamports;
 if(sim.value.err||!Number.isSafeInteger(after))throw Error('Bridge simulation failed. Check your tokens and SOL for fees.');
 const feeRaw=Math.max(0,balance-after,prepared.estimatedSolDebitLamports)+networkFee;
 if(feeRaw>50000000||balance<feeRaw)throw Error('Insufficient SOL or bridge cost exceeds 0.05 SOL.');
 return {...prepared,tx,feeRaw:String(feeRaw),expires:Date.now()+20000,attestor};
}
export function signBridgeSolana(prepared,t,a,row){
 if(Date.now()>prepared.expires)throw Error('Approval expired. Prepare it again.');
 const tx=validateBridgeTransaction(prepared,t,a,row,prepared.attestor),key=importSol(a.solSecret);
 try{if(key.publicKey.toBase58()!==a.sol)throw Error('Wrong Solana account.');tx.sign([key]);return {transaction:Buffer.from(tx.serialize()).toString('base64'),signature:bs58.encode(tx.signatures[0]),ticket:prepared.ticket,blockhash:tx.message.recentBlockhash,operation:t.direction==='sol-to-xmr'?'Deposit':'Withdrawal'};}finally{key.secretKey.fill(0);}
}
export function signedAttemptResolved(t,s){
 if(!s)return false;
 const signature=s.operation==='Deposit'?t.sourceSignature:t.destinationSignature;
 if(signature===s.signature)return true;
 const history=s.operation==='Deposit'?t.depositHistory:t.withdrawalHistory;
 return history?.some(h=>h.signature===s.signature&&h.blockhash===s.blockhash&&['expired','failed'].includes(h.reason)&&Number.isSafeInteger(h.checkedAt))||false;
}
