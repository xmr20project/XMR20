import {Buffer} from 'buffer';
import {BUY_FLOW,fixedXmr20Market,readXmr20Market,quoteXmr20,validateInitialSol} from './initial-buy.js';
import {quickPoolPlan,conversionSol} from './quick-plan.js';
import {DIRECT_SOL_SOURCE,directSolQuote} from './sol-conversion.js';
import {SLIPPAGE_BPS} from '../bridge/amounts.js';
import {validatePreset} from './preset.js';
import {QUICK_SENDER_TIP} from '../xmr20/quick-network-fees.js';
const need=(v,m)=>{if(!v)throw Error(m);};
// A quote may move slightly while the browser independently reads both pools.
// This 1% freshness band does not alter the quoted swap's 1% slippage or its
// exact signed minimum. Greater movement requires a completely fresh review.
export function verifyFreshConversion(quoted,current,label){
 need(typeof quoted==='string'&&/^\d+$/.test(quoted)&&typeof current==='string'&&/^[1-9]\d*$/.test(current),'Invalid conversion quote.');
 const value=BigInt(quoted),live=BigInt(current),band=BigInt(SLIPPAGE_BPS);
 need(value*10000n>=live*(10000n-band)&&value*10000n<=live*(10000n+band),`${label} conversion price moved. Refresh the launch quote.`);
}
export function createQuickReview({web3,sdk,builders,connection}){
 const cp=new sdk.CpAmm(connection),pk=v=>new web3.PublicKey(v);
 return async(row,p)=>{
  validatePreset(row.preset);const amount=validateInitialSol(row.initialSolLamports),max=Number(amount)+250000000;
  need(row.flow===BUY_FLOW&&p.flow===BUY_FLOW&&p.id===row.id&&p.owner===row.owner&&p.simulationPassed===true,'Refresh the launch review.');
  need(await connection.getGenesisHash()==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'&&(await connection.isBlockhashValid(p.blockhash,{commitment:'confirmed'})).value,'The launch review expired or changed network.');
  const r=p.review;
  need(r?.initialSolLamports===row.initialSolLamports&&r.creatorShareBps===5000&&r.platformShareBps===5000&&r.maximumSolDebitLamports===max&&Number.isSafeInteger(r.estimatedSolDebitLamports)&&r.estimatedSolDebitLamports>=0&&r.estimatedSolDebitLamports<=max,'Launch cost or first buy changed.');
  const mintReceipt=row.receipts?.find(i=>i.step==='mint');
  const [market,solQuote]=await Promise.all([
   mintReceipt?fixedXmr20Market():readXmr20Market(connection),
   !mintReceipt&&p.quote?.source===DIRECT_SOL_SOURCE?directSolQuote(connection,row.owner,conversionSol(row)):null,
  ]);
  if(solQuote)verifyFreshConversion(p.quote.outAmount,solQuote.outAmount,'SOL');
  if(!mintReceipt)verifyFreshConversion(p.minimumXmr20Raw,quoteXmr20(market,p.quote.otherAmountThreshold),'XMR20');
  const ids={owner:row.owner,mint:row.mint,creatorNft:row.creatorNft,platformNft:row.platformNft,flow:row.flow,initialSolLamports:row.initialSolLamports};
  const plan=await quickPoolPlan({row:ids,quote:p.quote,market,minimumXmr20Raw:p.minimumXmr20Raw,sdk,cp,builders});
  need(plan.buy.minimumTokenRaw===p.minimumTokenRaw&&r.conversionSolLamports===plan.conversionSolLamports,'Initial token purchase changed.');
  const response=await connection.getAddressLookupTable(pk(p.lookup),{commitment:'finalized'}),table=response.value;
  need(table?.isActive()&&table.state.authority?.toBase58()===p.lookupAuthority&&table.state.addresses.length<=100&&response.context.slot>table.state.lastExtendedSlot,'Launch setup is incomplete or changed.');
  const metadata={name:row.name,symbol:row.symbol,uri:row.metadataUri,rentLamports:10000000};
  const rent=await connection.getMinimumBalanceForRentExemption(builders.mintInstructions(ids,metadata).rentSize,'confirmed');
  const mint=[...builders.mintInstructions(ids,{...metadata,rentLamports:rent}).instructions,...plan.fundingInstructions,web3.SystemProgram.transfer({fromPubkey:pk(row.owner),toPubkey:pk(QUICK_SENDER_TIP),lamports:5000})];
  if(mintReceipt){
   const landed=await connection.getTransaction(mintReceipt.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
   need(landed?.meta?.err===null&&landed.transaction.signatures[0]===mintReceipt.signature,'The first-buy funding receipt is unavailable.');
   const msg=landed.transaction.message,keys=[...msg.staticAccountKeys,...(landed.meta.loadedAddresses?.writable||[]),...(landed.meta.loadedAddresses?.readonly||[])];
   const expected=[web3.ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),web3.ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...mint];
   need(msg.staticAccountKeys[0].toBase58()===row.owner&&msg.compiledInstructions.length===expected.length&&expected.every((ix,i)=>{const actual=msg.compiledInstructions[i];return keys[actual.programIdIndex].equals(ix.programId)&&Buffer.from(actual.data).equals(Buffer.from(ix.data))&&actual.accountKeyIndexes.length===ix.keys.length&&ix.keys.every((k,j)=>keys[actual.accountKeyIndexes[j]].equals(k.pubkey));}),'The retry differs from the confirmed SOL conversion.');
  }
  const parts=[...(!row.receipts?.some(i=>i.step==='mint')?[{step:'mint',instructions:mint}]:[]),{step:'pool',instructions:plan.launchInstructions}];
  need(p.items?.length===parts.length,'Approve all launch steps together.');
  return parts.map((part,i)=>{
   need(p.items[i].step===part.step&&p.items[i].blockhash===p.blockhash,'Launch order changed.');
   const expected=builders.compilePlan({owner:row.owner,blockhash:p.blockhash,instructions:part.instructions,lookupTables:[table],priorityMicroLamports:10000}),received=web3.VersionedTransaction.deserialize(Buffer.from(p.items[i].transaction,'base64'));
   need(Buffer.from(received.message.serialize()).equals(Buffer.from(expected.message.serialize())),'Wallet request differs from the launch and buy review.');
   return received;
  });
 };
}
