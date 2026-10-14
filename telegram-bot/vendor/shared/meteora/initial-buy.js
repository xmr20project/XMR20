import {Buffer} from 'buffer';
import {PublicKey,ComputeBudgetProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackAccount} from '@solana/spl-token';
import {CpmmPoolInfoLayout,CpmmConfigInfoLayout,CREATE_CPMM_POOL_PROGRAM,getPdaPoolAuthority,getPdaVault,getPdaObservationId,makeSwapCpmmBaseInInstruction,CurveCalculator} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {bridgeInstructions,validateQuote} from '../bridge/transaction.js';
import {SOL,WXMR,units} from '../bridge/amounts.js';
import {XMR20_MINT,transferFee} from './preset.js';
import {DIRECT_SOL_SOURCE,directSolInstructions} from './sol-conversion.js';
export const BUY_FLOW='sol-launch-buy-v1';
export const XMR20_MARKET='B1w58REDpWVGjP5GmTymitxq4KHL11ytVkHBF2NLBnUw';
export const XMR20_MARKET_CONFIG='CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ';
export const MAX_INITIAL_SOL=10_000_000_000n;
const pk=s=>new PublicKey(s),need=(v,m)=>{if(!v)throw Error(m);};
export function initialSol(value){const n=units(value,9);need(n>=0n&&n<=MAX_INITIAL_SOL,'Initial buy must be between 0 and 10 SOL.');return n.toString();}
export function validateInitialSol(value){need(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)&&BigInt(value)<=MAX_INITIAL_SOL,'Invalid initial SOL buy.');return BigInt(value);}
export function solConversion(row,quote){
 const amount=validateInitialSol(row.initialSolLamports);need(amount>0n,'A SOL amount is required.');
 if(quote?.source===DIRECT_SOL_SOURCE)return directSolInstructions(row,quote);
 const review={wallet:row.owner,direction:'deposit',inputMint:SOL,outputMint:WXMR,amount:amount.toString(),minimumOut:quote.otherAmountThreshold};
 validateQuote(quote,review);
 need(quote.routePlan.length>0&&quote.routePlan.every(s=>s.swapInfo?.inputMint===SOL&&s.swapInfo?.outputMint===WXMR&&s.swapInfo?.label==='Raydium CLMM'),'A direct SOL conversion route is required.');
 return {instructions:bridgeInstructions(quote,review).filter(i=>!i.programId.equals(ComputeBudgetProgram.programId)),minimumWxmr:quote.otherAmountThreshold};
}
export function fixedXmr20Market(){return {baseIn:true,pool:{vaultA:getPdaVault(CREATE_CPMM_POOL_PROGRAM,pk(XMR20_MARKET),pk(WXMR)).publicKey,vaultB:getPdaVault(CREATE_CPMM_POOL_PROGRAM,pk(XMR20_MARKET),pk(XMR20_MINT)).publicKey,observationId:getPdaObservationId(CREATE_CPMM_POOL_PROGRAM,pk(XMR20_MARKET)).publicKey}};}
export async function readXmr20Market(connection){
 const first=await connection.getMultipleAccountsInfo([pk(XMR20_MARKET),pk(XMR20_MARKET_CONFIG)],'confirmed');
 need(first.every(i=>i?.owner.equals(CREATE_CPMM_POOL_PROGRAM)),'XMR20 conversion market is unavailable.');
 const pool=CpmmPoolInfoLayout.decode(first[0].data),config=CpmmConfigInfoLayout.decode(first[1].data);
 need(pool.configId.toBase58()===XMR20_MARKET_CONFIG&&(pool.status&4)===0,'XMR20 conversion market is paused or changed.');
 const baseIn=pool.mintA.toBase58()===WXMR;
 need((baseIn?pool.mintB:pool.mintA).toBase58()===XMR20_MINT&&(baseIn?pool.mintA:pool.mintB).toBase58()===WXMR,'XMR20 conversion pair changed.');
 need((baseIn?pool.mintProgramA:pool.mintProgramB).equals(TOKEN_PROGRAM_ID)&&(baseIn?pool.mintProgramB:pool.mintProgramA).equals(TOKEN_2022_PROGRAM_ID),'Conversion token programs changed.');
 const infos=await connection.getMultipleAccountsInfo([pool.vaultA,pool.vaultB],'confirmed');
 const reserve=(side,info)=>{
  const mint=pool['mint'+side],program=pool['mintProgram'+side],account=unpackAccount(pool['vault'+side],info,program);
  need(account.mint.equals(mint)&&account.owner.equals(getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM).publicKey),'Conversion vault changed.');
  const r=account.amount-BigInt(pool['protocolFeesMint'+side].toString())-BigInt(pool['fundFeesMint'+side].toString())-BigInt(pool['creatorFeesMint'+side].toString());
  need(r>0n,'XMR20 conversion liquidity is unavailable.');return r;
 };
 const a=reserve('A',infos[0]),b=reserve('B',infos[1]);
 return {pool,config,baseIn,inputReserve:baseIn?a:b,outputReserve:baseIn?b:a};
}
export function quoteXmr20(market,wxmr){
 const {pool,config,baseIn,inputReserve,outputReserve}=market,n=BigInt(wxmr);
 need(n>0n&&n*100n<=inputReserve*5n,'Initial buy exceeds the available conversion liquidity.');
 const feeOnInput=pool.feeOn===0||(baseIn?pool.feeOn===1:pool.feeOn===2);
 const result=CurveCalculator.swapBaseInput(new BN(n.toString()),new BN(inputReserve.toString()),new BN(outputReserve.toString()),config.tradeFeeRate,pool.enableCreatorFee?config.creatorFeeRate:new BN(0),config.protocolFeeRate,config.fundFeeRate,feeOnInput);
 const gross=BigInt(result.outputAmount.toString()),net=gross-transferFee(gross),minimum=net*99n/100n;
 need(minimum>1n,'Initial buy is too small.');return minimum.toString();
}
export function xmr20ConversionInstructions(row,market,wxmr,minimum){
 const {pool,baseIn}=market,owner=pk(row.owner),src=getAssociatedTokenAddressSync(pk(WXMR),owner),dst=getAssociatedTokenAddressSync(pk(XMR20_MINT),owner,false,TOKEN_2022_PROGRAM_ID);
 need(BigInt(minimum)>1n,'Initial buy is too small.');
 return [createAssociatedTokenAccountIdempotentInstruction(owner,dst,owner,pk(XMR20_MINT),TOKEN_2022_PROGRAM_ID),makeSwapCpmmBaseInInstruction(CREATE_CPMM_POOL_PROGRAM,owner,getPdaPoolAuthority(CREATE_CPMM_POOL_PROGRAM).publicKey,pk(XMR20_MARKET_CONFIG),pk(XMR20_MARKET),src,dst,baseIn?pool.vaultA:pool.vaultB,baseIn?pool.vaultB:pool.vaultA,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,pk(WXMR),pk(XMR20_MINT),pool.observationId,new BN(wxmr),new BN(minimum))];
}
// Exact fixed-curve arithmetic from the pinned Meteora SDK. The input transfer
// tax applies once here, after the separate conversion market's output tax.
export async function firstBuyInstructions({sdk,cp,builders,row,grossQuoteRaw}){
 const gross=BigInt(grossQuoteRaw),received=gross-transferFee(gross),fee=(received+99n)/100n,net=received-fee;
 need(net>0n,'Initial buy is too small.');
 const {sqrtMinPrice,sqrtMaxPrice}=builders.priceBounds(),plan=await builders.poolInstructions(cp,row),a=plan.accounts;
 const result=sdk.calculateBtoAFromAmountInForConcentratedLiquidity(sqrtMaxPrice,sqrtMinPrice,plan.liquidityDelta,new BN(net.toString()));
 need(result.amountLeft.isZero(),'Initial buy exceeds the launch price range.');
 const minimum=result.outputAmount.toString();need(BigInt(minimum)>0n,'Initial buy is too small.');
 // Fixed time-scheduler mode never requires a live pool read or rate-limiter
 // accounts. The pool is created earlier in this same transaction.
 const poolState={poolFees:{baseFee:{baseFeeInfo:{data:Buffer.alloc(32)}}}};
 const tx=await cp.swap2({pool:a.pool,payer:a.owner,inputTokenMint:a.quote,outputTokenMint:a.mint,tokenAMint:a.mint,tokenBMint:a.quote,tokenAVault:a.baseVault,tokenBVault:a.quoteVault,tokenAProgram:TOKEN_2022_PROGRAM_ID,tokenBProgram:TOKEN_2022_PROGRAM_ID,referralTokenAccount:null,swapMode:sdk.SwapMode.ExactIn,amountIn:new BN(gross.toString()),minimumAmountOut:new BN(minimum),poolState});
 // The pool builder has already created the exact owner ATAs.
 return {instructions:tx.instructions.filter(i=>i.programId.equals(sdk.CP_AMM_PROGRAM_ID)),minimumTokenRaw:minimum,grossQuoteRaw:gross.toString()};
}
