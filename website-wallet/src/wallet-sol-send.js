import {Connection,PublicKey,SystemProgram,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getMint,getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction,createTransferCheckedWithFeeInstruction,getTransferFeeConfig,calculateEpochFee} from '@solana/spl-token';
import bs58 from 'bs58';
import {Buffer} from 'buffer';

const rpc=new URL('/api/wallet',location.origin).href;
const connection=()=>new Connection(rpc,{commitment:'confirmed',fetch:async(_url,options)=>{
 const payload=JSON.parse(options.body);
 return fetch(rpc,{...options,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'walletRpc',rpc:payload})});
}});
export function rawUnits(amount){if(typeof amount!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))throw Error('Enter an amount with at most 6 decimals.');const [whole,fraction='']=amount.split('.');const raw=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(raw<1n||raw>1000000000000000n)throw Error('Amount must be between 0.000001 and 1 billion tokens.');return raw;}
export const solanaRpc=()=>connection();
// Native SOL payment, such as a ChangeNOW deposit. The exact lamports, fee and
// balance are checked before review; signing reuses the token-send guards.
export async function prepareSolTransfer({owner,to,lamports}){
 const sender=new PublicKey(owner),recipient=new PublicKey(to),amount=BigInt(lamports);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 if(amount<1n||amount>18446744073709551615n)throw Error('Invalid SOL amount.');
 const c=connection(),latest=await c.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:sender,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight}).add(SystemProgram.transfer({fromPubkey:sender,toPubkey:recipient,lamports:amount}));
 const fee=await c.getFeeForMessage(tx.compileMessage(),'confirmed');if(fee?.value===null||fee?.value===undefined)throw Error('Network fee unavailable. Try again.');
 const balance=await c.getBalance(sender,'confirmed');if(!Number.isSafeInteger(balance)||amount+BigInt(fee.value)>BigInt(balance))throw Error('Not enough SOL for this amount and the network fee.');
 return {tx,fee:BigInt(fee.value),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight};
}
export async function prepareSolanaTokenSend({row,owner,to,amount}){
 const sender=new PublicKey(owner),recipient=new PublicKey(to),mint=new PublicKey(row.mint),raw=rawUnits(amount);
 if(recipient.equals(sender))throw Error('Choose another Solana wallet.');
 const c=connection(),info=await c.getAccountInfo(mint,'confirmed');
 if(!info||!info.owner.equals(TOKEN_PROGRAM_ID)&&!info.owner.equals(TOKEN_2022_PROGRAM_ID))throw Error('Token program could not be verified.');
 const program=info.owner,m=await getMint(c,mint,'confirmed',program);
 if(m.decimals!==6)throw Error('Token decimals differ from the XMR20 index.');
 const source=getAssociatedTokenAddressSync(mint,sender,false,program),destination=getAssociatedTokenAddressSync(mint,recipient,false,program);
 const holding=await getAccount(c,source,'confirmed',program);if(holding.amount<raw)throw Error('Not enough available tokens.');
 const feeConfig=program.equals(TOKEN_2022_PROGRAM_ID)?getTransferFeeConfig(m):null;
 const fee=feeConfig?calculateEpochFee(feeConfig,(await c.getEpochInfo('confirmed')).epoch,raw):0n;
 const latest=await c.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:sender,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight});
 tx.add(createAssociatedTokenAccountIdempotentInstruction(sender,destination,recipient,mint,program));
 tx.add(feeConfig?createTransferCheckedWithFeeInstruction(source,mint,destination,sender,raw,6,fee,[],program):createTransferCheckedInstruction(source,mint,destination,sender,raw,6,[],program));
 return {tx,fee,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,source:source.toBase58(),destination:destination.toBase58()};
}
export async function signAndSubmitSolanaTokenSend({prepared,provider,owner,row,to,amount,assertCurrent=()=>{},onSubmitted=()=>{}}){
 assertCurrent();provider?.assertCurrent?.();
 if(provider?.publicKey?.toBase58()!==owner)throw Error('Wallet changed. Reconnect before sending.');
 const tx=prepared.tx,before=tx.serializeMessage(),signed=await provider.signTransaction(tx);
 // Closing/cancelling while the wallet prompt is open must not send a late reply.
 assertCurrent();provider?.assertCurrent?.();
 if(provider?.publicKey?.toBase58()!==owner||!Buffer.from(before).equals(Buffer.from(signed.serializeMessage())))throw Error('Wallet changed the reviewed transaction. Nothing was submitted.');
 if(!signed.verifySignatures())throw Error('Wallet signature is missing or invalid. Nothing was submitted.');
 const signature=bs58.encode(signed.signature),bytes=signed.serialize();
 const key=`xmr20-sol-send:${owner}:${row.mint}:${to}:${amount}`;
 sessionStorage.setItem(key,JSON.stringify({signature,transaction:Buffer.from(bytes).toString('base64'),blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight}));
 onSubmitted({signature,confirmed:false,savedKey:key});
 const c=connection();try{await c.sendRawTransaction(bytes,{skipPreflight:false,maxRetries:2});}catch(e){const status=await c.getSignatureStatuses([signature],{searchTransactionHistory:true}).catch(()=>null);if(!status?.value?.[0])throw Error(`Submission uncertain. Saved receipt ${signature}; check its status before retrying.`);}
 const confirmed=await checkSolanaTokenSend(signature,{connection:c});
 if(confirmed)sessionStorage.removeItem(key);return {signature,confirmed};
}
export async function checkSolanaTokenSend(signature,{connection:c=connection(),attempts=8}={}){
 for(let i=0;i<attempts;i++){
  const status=await c.getSignatureStatuses([signature],{searchTransactionHistory:true}).catch(()=>null);
  const result=status?.value?.[0];if(result?.err)throw Error('Solana reported a failed transfer. Keep the saved receipt.');
  if(['confirmed','finalized'].includes(result?.confirmationStatus))return true;
  if(i+1<attempts)await new Promise(resolve=>setTimeout(resolve,2500));
 }
 return false;
}
