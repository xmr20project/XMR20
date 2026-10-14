import {lookupLaunch,validateTradePool} from './launch-directory.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {PublicKey,SystemProgram,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,unpackMint,getAssociatedTokenAddressSync,unpackAccount,getTransferFeeConfig,ExtensionType,getExtensionTypes} from '@solana/spl-token';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';
import {XMR20_MINT} from '../vendor/shared/meteora/preset.js';
import {QUICK_SENDER_TIP} from '../vendor/shared/xmr20/quick-network-fees.js';
const need=(v,c)=>{if(!v)throw Error(c);},pk=v=>new PublicKey(v),hash=b=>createHash('sha256').update(b).digest('hex');

// Direct XMR20-pair execution. No server-supplied transaction or arbitrary mint
// route: mint/pool must be a published XMR20 launch, regardless of creator.
export class TradePilot {
  constructor({vault,owner,withdrawalAddress,connection,helius,signer,journal,now=Date.now,signal,lookup=lookupLaunch}){Object.assign(this,{vault,owner,withdrawalAddress,connection,helius,signer,journal,now,signal,lookup});this.cp=new sdk.CpAmm(connection);}
  save(d){this.vault.transaction(s=>{s.trades??={};s.trades[d.id]=structuredClone(d);});return d;}
  get(id){const d=this.vault.state.trades?.[id];need(d?.owner===this.owner,'TRADE_NOT_FOUND');return structuredClone(d);}
  async prepare({side,mint,amountRaw}) {
    need(['buy','sell','withdraw'].includes(side)&&typeof amountRaw==='string'&&/^[1-9]\d{0,19}$/.test(amountRaw),'TRADE_INPUT');
    const owner=pk(this.owner),amount=BigInt(amountRaw);let instructions,minimumRaw=null,inputMint=null,outputMint=null,launch=null;
    if(side==='withdraw'){
      need(this.withdrawalAddress&&this.withdrawalAddress!==this.owner&&amount<=250000000n,'WITHDRAW_LIMIT');
      instructions=[SystemProgram.transfer({fromPubkey:owner,toPubkey:pk(this.withdrawalAddress),lamports:amount})];
    }else{
      launch=await this.lookup(mint);
      need(launch.mint===mint,'TRADE_LAUNCH_REQUIRED');
      const poolKey=sdk.deriveCustomizablePoolAddress(pk(mint),pk(XMR20_MINT));need(poolKey.toBase58()===launch.pool,'TRADE_POOL');
      const [poolInfo,mints,clock,epoch]=await Promise.all([this.connection.getAccountInfo(poolKey,'confirmed'),this.connection.getMultipleAccountsInfo([pk(mint),pk(XMR20_MINT)],'confirmed'),this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,'confirmed'),this.connection.getEpochInfo('confirmed')]);
      need(poolInfo?.owner.equals(sdk.CP_AMM_PROGRAM_ID),'TRADE_POOL');
      const pool=await this.cp.fetchPoolState(poolKey);
      validateTradePool(pool,launch,mint);
      const decoded=mints.map((info,i)=>{need(info?.owner.equals(TOKEN_2022_PROGRAM_ID),'TRADE_MINT');return unpackMint(i?pk(XMR20_MINT):pk(mint),info,TOKEN_2022_PROGRAM_ID);});
      need(decoded.every(m=>m.isInitialized&&m.decimals===6&&!m.freezeAuthority),'TRADE_MINT');
      need(decoded.every(m=>!getExtensionTypes(m.tlvData).some(e=>[ExtensionType.TransferHook,ExtensionType.PermanentDelegate,ExtensionType.NonTransferable].includes(e))),'TRADE_EXTENSION');
      // SDK handles Token-2022 transfer fees once on each actual transfer.
      const quoteFee=getTransferFeeConfig(decoded[1]);need(quoteFee,'TRADE_QUOTE_FEE');
      const currentFee=epoch.epoch>=Number(quoteFee.newerTransferFee.epoch)?quoteFee.newerTransferFee:quoteFee.olderTransferFee;
      need(currentFee.transferFeeBasisPoints===150,'TRADE_QUOTE_FEE');
      need(clock?.data.length===40,'TRADE_CLOCK');
      inputMint=side==='buy'?XMR20_MINT:mint;outputMint=side==='buy'?mint:XMR20_MINT;
      const quote=this.cp.getQuote2({inputTokenMint:pk(inputMint),slippage:100,currentPoint:new BN(clock.data.readBigInt64LE(32).toString()),poolState:pool,inputTokenInfo:{mint:decoded[side==='buy'?1:0],currentEpoch:epoch.epoch},outputTokenInfo:{mint:decoded[side==='buy'?0:1],currentEpoch:epoch.epoch},tokenADecimal:6,tokenBDecimal:6,hasReferral:false,swapMode:sdk.SwapMode.ExactIn,amountIn:new BN(amountRaw)});
      minimumRaw=quote.minimumAmountOut?.toString();need(minimumRaw&&BigInt(minimumRaw)>0n&&quote.priceImpact.abs().lte(5),'TRADE_LIQUIDITY');
      const source=getAssociatedTokenAddressSync(pk(inputMint),owner,false,TOKEN_2022_PROGRAM_ID);
      const info=await this.connection.getAccountInfo(source,'finalized');need(info,'TRADE_BALANCE');const account=unpackAccount(source,info,TOKEN_2022_PROGRAM_ID);need(account.owner.equals(owner)&&account.mint.equals(pk(inputMint))&&account.amount>=amount&&!account.isFrozen,'TRADE_BALANCE');
      const plan=await this.cp.swap2({pool:poolKey,payer:owner,inputTokenMint:pk(inputMint),outputTokenMint:pk(outputMint),tokenAMint:pool.tokenAMint,tokenBMint:pool.tokenBMint,tokenAVault:pool.tokenAVault,tokenBVault:pool.tokenBVault,tokenAProgram:TOKEN_2022_PROGRAM_ID,tokenBProgram:TOKEN_2022_PROGRAM_ID,referralTokenAccount:null,poolState:pool,swapMode:sdk.SwapMode.ExactIn,amountIn:new BN(amountRaw),minimumAmountOut:new BN(minimumRaw)});
      instructions=plan.instructions;
    }
    instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions,SystemProgram.transfer({fromPubkey:owner,toPubkey:pk(QUICK_SENDER_TIP),lamports:5000})];
    const latest=await this.connection.getLatestBlockhash('confirmed');
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());
    need(tx.serialize().length<=1232&&tx.message.header.numRequiredSignatures===1,'TRADE_TRANSACTION');
    const fee=(await this.connection.getFeeForMessage(tx.message,'confirmed')).value;need(Number.isSafeInteger(fee)&&fee>0&&fee<=100000,'TRADE_FEE');
    const balance=await this.connection.getBalance(owner,'finalized');
    // Allow output ATA rent but cap all non-trade SOL costs to 0.01 SOL.
    const maxDebit=(side==='withdraw'?amount:0n)+10000000n;need(BigInt(balance)>=maxDebit,'TRADE_SOL_BALANCE');
    const sim=await this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[this.owner]}});
    need(sim.value.err===null&&Number.isSafeInteger(sim.value.accounts?.[0]?.lamports)&&BigInt(balance)-BigInt(sim.value.accounts[0].lamports)<=maxDebit,'TRADE_SIMULATION');
    const d={id:randomUUID(),owner:this.owner,side,...(launch?{launchId:launch.id,launchCreator:launch.owner}:{}),mint:mint||null,inputMint,outputMint,amountRaw,minimumRaw,withdrawalAddress:side==='withdraw'?this.withdrawalAddress:null,feeLamports:fee,maxDebitLamports:maxDebit.toString(),transaction:Buffer.from(tx.serialize()).toString('base64'),messageSha256:hash(tx.message.serialize()),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,expiresAt:this.now()+30000,state:'review'};
    this.save(d);return d;
  }
  async approve(id){const d=this.get(id);need(d.state==='review'&&d.expiresAt>this.now(),'TRADE_REVIEW_EXPIRED');
    need((await this.connection.isBlockhashValid(d.blockhash,{commitment:'confirmed'})).value,'TRADE_BLOCKHASH');
    const tx=VersionedTransaction.deserialize(Buffer.from(d.transaction,'base64'));
    need(hash(tx.message.serialize())===d.messageSha256,'TRADE_REVIEW_CHANGED');
    const sim=await this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});need(sim.value.err===null,'TRADE_SIMULATION');
    d.state='signing';this.save(d);
    try{
      need(!this.signal?.aborted,'STOPPED');
      const signed=await this.signer.signReviewed({operationId:'trade:'+id,address:this.owner,transaction:Buffer.from(d.transaction,'base64'),messageSha256:d.messageSha256,expiresAt:d.expiresAt});
      d.signedTransaction=Buffer.from(signed.transaction).toString('base64');d.signature=bs58.encode(VersionedTransaction.deserialize(signed.transaction).signatures[0]);d.state='submitted';this.save(d);
      need(!this.signal?.aborted,'STOPPED');
      d.delivery=await this.helius.sendExact(signed.transaction,d.signature);this.save(d);return d;
    }catch{d.state='attention';this.save(d);throw Error('TRADE_RECONCILE');}
  }
  async status(id){const d=this.get(id);if(!d.signature)return d;
    const status=await this.helius.signature(d.signature);
    if(status?.confirmationStatus==='finalized'){
      const receipt=await this.connection.getTransaction(d.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
      need(receipt?.transaction.signatures[0]===d.signature&&hash(receipt.transaction.message.serialize())===d.messageSha256,'TRADE_RECEIPT');
      d.state=receipt.meta?.err?'failed':'finalized';d.slot=receipt.slot;this.save(d);
    }
    return d; // Unknown/expired stays reserved. Never re-sign or replace here.
  }
}
