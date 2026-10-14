import {Buffer} from 'buffer';
import {PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,TransactionInstruction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction,TOKEN_PROGRAM_ID,unpackMint} from '@solana/spl-token';
import {CLMM_PROGRAM_ID,ClmmConfigLayout,PoolInfoLayout,TickArrayLayout,TickArrayBitmapExtensionLayout,TickArrayBitmapUtil,getPdaExBitmapAccount,getPdaTickArrayAddress,swapInternal,ClmmInstrument} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {SOL,WXMR,SLIPPAGE_BPS} from '../bridge/amounts.js';
import {validateQuote} from '../bridge/transaction.js';

export const DIRECT_SOL_SOURCE='raydium-clmm-direct-v1';
export const SOL_MARKET=Object.freeze({pool:'CgHuN3ajFijPidxiWStiDBUBkchWGNb8tVTGaNgYx9UJ',config:'9WjDVMHWCirG9jkchbetHTnSzdXbAPnD9bsoGRcz1xUw',vaultA:'5CJ4ycoanPimfwHZRRbu7mrKruhHBX98Hz6Se2GKbLD5',vaultB:'8LFqeBuXNsbLuRacHnoi4pn79un4RnLMwe6sM1yEoVmV',observation:'BBnKtS1RdtqdbaS9MunJPNjastfzYbt1ywMV1NEdeosK',tickSpacing:10});
const pk=v=>new PublicKey(v),need=(v,m)=>{if(!v)throw Error(m);},poolKey=pk(SOL_MARKET.pool),bitmapKey=getPdaExBitmapAccount(CLMM_PROGRAM_ID,poolKey).publicKey;
const integer=v=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
function validStarts(starts){return Array.isArray(starts)&&starts.length>0&&starts.length<=3&&new Set(starts).size===starts.length&&starts.every((n,i)=>Number.isSafeInteger(n)&&n%600===0&&n>=-444000&&n<=443400&&(i===0||n<starts[i-1]));}
export function directSolWarmKeys(quote){
 need(quote?.source===DIRECT_SOL_SOURCE&&validStarts(quote.availableTickArrayStarts),'Invalid SOL conversion warm accounts.');
 return quote.availableTickArrayStarts.map(start=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,poolKey,start).publicKey);
}

// Quote the existing SOL/wXMR market from Solana itself. The tiny zero-buy
// setup conversion follows exactly the same path; it needs no Jupiter request.
export async function directSolQuote(connection,owner,amount){
 need(integer(amount)&&BigInt(amount)<=10000000000n,'Invalid SOL conversion amount.');pk(owner);
 const keys=[poolKey,pk(SOL_MARKET.config),bitmapKey,pk(SOL),pk(WXMR),SYSVAR_CLOCK_PUBKEY];
 const infos=await connection.getMultipleAccountsInfo(keys,'confirmed');
 need(infos.slice(0,3).every(a=>a?.owner.equals(CLMM_PROGRAM_ID)),'SOL conversion market is unavailable.');
 const pool=PoolInfoLayout.decode(infos[0].data),config=ClmmConfigLayout.decode(infos[1].data),bitmap=TickArrayBitmapExtensionLayout.decode(infos[2].data);
 need(pool.configId.toBase58()===SOL_MARKET.config&&pool.mintA.toBase58()===SOL&&pool.mintB.toBase58()===WXMR&&pool.vaultA.toBase58()===SOL_MARKET.vaultA&&pool.vaultB.toBase58()===SOL_MARKET.vaultB&&pool.observationId.toBase58()===SOL_MARKET.observation&&pool.tickSpacing===SOL_MARKET.tickSpacing&&config.tickSpacing===SOL_MARKET.tickSpacing&&bitmap.poolId.equals(poolKey),'SOL conversion market changed.');
 need((pool.status&16)===0&&!pool.liquidity.isZero(),'SOL conversion market is paused or has no liquidity.');
 for(const [i,decimals] of [[3,9],[4,12]]){
  need(infos[i]?.owner.equals(TOKEN_PROGRAM_ID),'SOL conversion token program changed.');
  const mint=unpackMint(keys[i],infos[i],TOKEN_PROGRAM_ID);need(mint.isInitialized&&mint.decimals===decimals,'SOL conversion decimals changed.');
 }
 need(infos[5]?.data.length===40,'Solana time is unavailable.');
 const timestamp=Number(infos[5].data.readBigInt64LE(32));need(Number.isSafeInteger(timestamp)&&timestamp>0,'Invalid Solana time.');
 const starts=TickArrayBitmapUtil.findTickArrayStartIndex({tickSpacing:pool.tickSpacing,poolBitmap:pool.tickArrayBitmap,tickArrayBitmap:bitmap,findInfo:{type:'zeroForOne',count:3,tickArrayCurrent:pool.tickCurrent}});
 need(starts.length>0&&starts.length<=3,'SOL conversion liquidity is unavailable.');
 const addresses=starts.map(start=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,poolKey,start).publicKey),ticks=await connection.getMultipleAccountsInfo(addresses,'confirmed');
 const tickArrays=ticks.map((info,i)=>{
  need(info?.owner.equals(CLMM_PROGRAM_ID),'SOL conversion price range is unavailable.');
  const value=TickArrayLayout.decode(info.data);need(value.poolId.equals(poolKey)&&value.startTickIndex===starts[i],'SOL conversion price range changed.');return {address:addresses[i],value};
 });
 const result=swapInternal({programId:CLMM_PROGRAM_ID,poolId:poolKey,poolInfo:pool,tickArrays,configInfo:config,tickarrayBitmapExtension:bitmap,amountSpecified:new BN(amount),sqrtPriceLimitX64:new BN(0),zeroForOne:true,isBaseInput:true,blockTimestamp:timestamp,includeExtraTickArrays:false});
 need(result.allTrade&&result.amountSpecifiedRemaining.isZero()&&result.amountCalculated.gt(new BN(0)),'Initial buy exceeds the available SOL conversion liquidity.');
 const out=BigInt(result.amountCalculated.toString()),spot=BigInt(amount)*BigInt(pool.sqrtPriceX64.toString())**2n/(1n<<128n),difference=spot>out?spot-out:out-spot;
 need(spot>0n&&difference*100n<=spot*5n,'Initial buy exceeds the SOL conversion price limit.');
 const minimum=out*BigInt(10000-SLIPPAGE_BPS)/10000n;need(minimum>0n,'SOL conversion amount is too small.');
 const byAddress=new Map(addresses.map((key,i)=>[key.toBase58(),starts[i]])),tickArrayStarts=result.accounts.map(key=>byAddress.get(key.toBase58()));
 need(tickArrayStarts.length>0&&tickArrayStarts.every(Number.isInteger),'SOL conversion accounts could not be verified.');
 return {source:DIRECT_SOL_SOURCE,instructionVersion:1,inputMint:SOL,outputMint:WXMR,inAmount:amount,outAmount:out.toString(),otherAmountThreshold:minimum.toString(),swapMode:'ExactIn',slippageBps:SLIPPAGE_BPS,platformFee:null,priceImpactPct:(Number(difference*1000000000n/spot)/1000000000).toString(),tickArrayStarts,availableTickArrayStarts:starts,
  routePlan:[{percent:100,bps:10000,swapInfo:{ammKey:SOL_MARKET.pool,label:'Raydium CLMM',inputMint:SOL,outputMint:WXMR,inAmount:amount,outAmount:out.toString()}}]};
}

// Reconstruct every account/instruction from fixed market identities and the
// reviewed amount. The server cannot supply an arbitrary swap or destination.
export function directSolInstructions(row,quote){
 need(quote?.source===DIRECT_SOL_SOURCE,'Unsupported SOL conversion source.');
 validateQuote(quote,{wallet:row.owner,inputMint:SOL,outputMint:WXMR,amount:row.initialSolLamports});
 const route=quote.routePlan;
 need(route.length===1&&route[0].percent===100&&route[0].bps===10000&&route[0].swapInfo?.ammKey===SOL_MARKET.pool&&route[0].swapInfo?.label==='Raydium CLMM'&&route[0].swapInfo?.inputMint===SOL&&route[0].swapInfo?.outputMint===WXMR&&route[0].swapInfo?.inAmount===quote.inAmount&&route[0].swapInfo?.outAmount===quote.outAmount,'SOL conversion route changed.');
 const starts=quote.tickArrayStarts;
 need(validStarts(starts),'Invalid SOL conversion price accounts.');
 const version=quote.instructionVersion===undefined?2:quote.instructionVersion;
 need(version===1||version===2,'Unsupported SOL conversion instruction version.');
 const owner=pk(row.owner),src=getAssociatedTokenAddressSync(pk(SOL),owner),dst=getAssociatedTokenAddressSync(pk(WXMR),owner);
 const ticks=starts.map(start=>getPdaTickArrayAddress(CLMM_PROGRAM_ID,poolKey,start).publicKey);
 let swap;
 if(version===1){
  // Both pinned conversion mints use the original SPL Token program. Raydium's
  // SwapSingle instruction needs no Token-2022 or memo accounts for this pair.
  // Keeping the version explicit preserves existing SwapV2 recovery bytes.
  const data=Buffer.alloc(41);Buffer.from([248,198,158,145,225,117,135,200]).copy(data);
  data.writeBigUInt64LE(BigInt(quote.inAmount),8);data.writeBigUInt64LE(BigInt(quote.otherAmountThreshold),16);data[40]=1;
  const key=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
  swap=new TransactionInstruction({programId:CLMM_PROGRAM_ID,data,keys:[key(owner,false,true),key(pk(SOL_MARKET.config)),key(poolKey,true),key(src,true),key(dst,true),key(pk(SOL_MARKET.vaultA),true),key(pk(SOL_MARKET.vaultB),true),key(pk(SOL_MARKET.observation),true),key(TOKEN_PROGRAM_ID),key(ticks[0],true),key(bitmapKey,true),...ticks.slice(1).map(tick=>key(tick,true))]});
 }else{
  swap=ClmmInstrument.swapV2Instruction(CLMM_PROGRAM_ID,owner,poolKey,pk(SOL_MARKET.config),src,dst,pk(SOL_MARKET.vaultA),pk(SOL_MARKET.vaultB),pk(SOL),pk(WXMR),ticks,pk(SOL_MARKET.observation),new BN(quote.inAmount),new BN(quote.otherAmountThreshold),new BN(0),true,bitmapKey);
 }
 return {minimumWxmr:quote.otherAmountThreshold,instructions:[createAssociatedTokenAccountIdempotentInstruction(owner,src,owner,pk(SOL)),createAssociatedTokenAccountIdempotentInstruction(owner,dst,owner,pk(WXMR)),SystemProgram.transfer({fromPubkey:owner,toPubkey:src,lamports:BigInt(quote.inAmount)}),createSyncNativeInstruction(src),swap,createCloseAccountInstruction(src,owner,owner)]};
}
