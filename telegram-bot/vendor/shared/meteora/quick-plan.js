import {SystemProgram,PublicKey} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {SOL,WXMR} from '../bridge/amounts.js';
import {BUY_FLOW,validateInitialSol,solConversion,xmr20ConversionInstructions,firstBuyInstructions} from './initial-buy.js';
import {LAUNCH_FEE_LAMPORTS,LAUNCH_TREASURY} from '../xmr20/launch-policy.js';
import {QUICK_SENDER_TIP} from '../xmr20/quick-network-fees.js';
export const ZERO_BUY_SETUP_SOL='10000';
export const uniqueKeys=instructions=>[...new Map(instructions.flatMap(ix=>[ix.programId,...ix.keys.filter(k=>!k.isSigner).map(k=>k.pubkey)]).map(k=>[k.toBase58(),k])).values()];
// Only deployment/market addresses belong in the reusable table. Per-launch
// mint, NFT, pool and wallet addresses remain in each transaction itself.
export function sharedLaunchKeys(row,instructions,{sdk,builders}){
 const a=builders.accounts(row),dynamic=new Set(Object.entries(a).filter(([name])=>!['quote','platformOwner'].includes(name)).map(([,key])=>key.toBase58()));
 for(const mint of [SOL,WXMR])dynamic.add(getAssociatedTokenAddressSync(new PublicKey(mint),a.owner).toBase58());
 dynamic.add(sdk.deriveTokenBadgeAddress(a.mint).toBase58());
 return uniqueKeys(instructions).filter(key=>!dynamic.has(key.toBase58()));
}
function compactPoolInstructions(pool,row,builders){
 const a=builders.accounts(row),expected=[a.ownerBase,a.ownerQuote].map((ata,i)=>createAssociatedTokenAccountIdempotentInstruction(a.owner,ata,a.owner,i?a.quote:a.mint,TOKEN_2022_PROGRAM_ID));
 const same=(left,right)=>left.programId.equals(right.programId)&&left.data.equals(right.data)&&left.keys.length===right.keys.length&&left.keys.every((key,i)=>key.pubkey.equals(right.keys[i].pubkey)&&key.isSigner===right.keys[i].isSigner&&key.isWritable===right.keys[i].isWritable);
 const removed=pool.filter(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
 if(removed.length!==2||!expected.every(ix=>removed.some(other=>same(ix,other))))throw Error('Launch account setup changed.');
 // Both exact ATAs are created in the preceding mint/conversion transaction.
 // Recovery proves that receipt, and the full bundle is simulated before signing.
 return pool.filter(ix=>!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
}
export function conversionSol(row){return validateInitialSol(row.initialSolLamports)>0n?row.initialSolLamports:ZERO_BUY_SETUP_SOL;}
export async function quickPoolPlan({row,quote,market,minimumXmr20Raw,sdk,cp,builders}){
 if(row.flow!==BUY_FLOW)throw Error('Unsupported launch flow.');
 const initial=validateInitialSol(row.initialSolLamports),converted=conversionSol(row);
 const route=solConversion({...row,initialSolLamports:converted},quote);
 if(!/^[1-9]\d*$/.test(minimumXmr20Raw)||BigInt(minimumXmr20Raw)<=1n)throw Error('Invalid XMR20 minimum.');
 const pool=await builders.poolInstructions(cp,row);
 const buy=initial>0n?await firstBuyInstructions({sdk,cp,builders,row,grossQuoteRaw:(BigInt(minimumXmr20Raw)-1n).toString()}):{instructions:[],minimumTokenRaw:'0',grossQuoteRaw:'0'};
 const owner=new PublicKey(row.owner);
 const fundingInstructions=[...route.instructions,...xmr20ConversionInstructions(row,market,route.minimumWxmr,minimumXmr20Raw)];
 const compact=quote.source==='raydium-clmm-direct-v1';
 const launchInstructions=[...(compact?compactPoolInstructions(pool.instructions,row,builders):pool.instructions),...buy.instructions,
  SystemProgram.transfer({fromPubkey:owner,toPubkey:new PublicKey(LAUNCH_TREASURY),lamports:LAUNCH_FEE_LAMPORTS}),
  SystemProgram.transfer({fromPubkey:owner,toPubkey:new PublicKey(QUICK_SENDER_TIP),lamports:5000})];
 return {instructions:[...fundingInstructions,...launchInstructions],fundingInstructions,launchInstructions,buy,conversionSolLamports:converted,minimumWxmrRaw:route.minimumWxmr,minimumXmr20Raw,quote};
}
