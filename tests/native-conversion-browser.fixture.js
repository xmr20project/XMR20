// Public UI state only; no wallet, node, signing key or real transaction.
import {createNativeConversionPage} from '../src/native-conversion-page.js';
import '../src/native-send-page.css';
const mode=new URLSearchParams(location.search).get('mode');
const plan={id:'11'.repeat(32),record:{owner:'4'+'a'.repeat(94),amount:'7530668912636'},request:{kind:'migrate-output',owner:'PUBLIC SOLANA HOLDER',amount:'7530668912636',fee:'0'},recipientCarrier:'PUBLIC FIXTURE'};
const prepared={preparationId:'public-preparation',plan,quote:{net:plan.record.amount,nativeFee:'30000000',creationDeadline:780}};
globalThis.fixture={calls:[],ready:false,closed:false,confirmed:false,custodyConfirmed:false};
const note=(name,value)=>fixture.calls.push({name,value});
const client={
 unlock:async()=>{fixture.workerLocked=false;note('unlock');},operatorCreditPreparations:async()=>['saved','saved-only','refunded'].includes(mode)?[{...prepared,...(mode==='refunded'?{completion:{status:'refunded'}}:{})}]:[],
 subscribeProgress:listener=>{fixture.progress=listener;return ()=>{fixture.progress=null;};},
 sync:async()=>{if(fixture.workerLocked)throw Error('Unlock your Monero wallet first.');note('sync');fixture.creditNeedsRefresh=false;if(fixture.holdSync)await new Promise(resolve=>{fixture.finishSync=resolve;fixture.progress?.('Syncing Monero history · block 100 of 200');});return {ready:true,height:mode==='saved'?800:60};},inventory:async()=>[],
 feeFundingStatus:async()=>{if(fixture.workerLocked)throw Error('Unlock your Monero wallet first.');note('funding-status');return {address:plan.record.owner,ready:!fixture.fundingMissing,reason:fixture.fundingMissing?'insufficient':'ready',totalRaw:fixture.fundingMissing?'0':'8000000000',availableRaw:fixture.fundingMissing?'0':'8000000000',requiredRaw:'101000000',...(fixture.fundingOverride||{})};},
 discardCarrierReview:async()=>note('discard-review'),
 completeOperatorRefund:async()=>note('complete-refund'),
 prepareOperatorCredit:async({request})=>{note('prepare',request);if(fixture.failPrepareFunding){fixture.failPrepareFunding=false;fixture.workerLocked=true;throw Error('Add spendable XMR for the Monero network fee before bridging');}if(fixture.fundingMissing)throw Error('Add spendable XMR for the Monero network fee before bridging');plan.request={...request,...(fixture.changedPreparation?{amount:'1'}:{})};plan.record.amount=String(BigInt(request.amount)-BigInt(request.fee));return prepared;},
 recoverOperatorCreditPreparation:async()=>prepared,
 recoverPreparedCarrier:async()=>({state:'signed',transaction:'PUBLIC SIGNED FIXTURE',txid:'22'.repeat(32)}),
 constructOperatorIssuedCredit:async value=>{note('construct',value);if(fixture.workerLocked||fixture.creditNeedsRefresh)throw Error('Stale or closed private worker');if(fixture.failCreditVerification){fixture.failCreditVerification=false;fixture.workerLocked=true;throw Error('Your saved Solana approval could not be verified. Check status to retry. (M12)');}return {handle:1,fee:fixture.feeOverride||'30000000'};},
 signCarrier:async value=>{note('sign',value);return {reservationId:'public-signature'};},
 assembleCarrier:async()=>({transaction:'PUBLIC SIGNED FIXTURE',txid:'22'.repeat(32)})
};
const bridge={
 quote:async value=>{note('quote',value);if(fixture.quoteError)throw Error('Fee service unavailable');return {...value,fee:'0'};},
 prepare:async()=>fixture.custodyConfirmed?{status:'finalized'}:{status:'prepared',proposal:{transaction:'PUBLIC CUSTODY'}},
 approve:async value=>{note('approve',value);fixture.creditNeedsRefresh=true;return {status:'submitted'};},
 status:async()=>{note('custody-status');return {status:fixture.custodyConfirmed?'finalized':'confirming'};},
 retry:async()=>({status:'submitted'}),
 issue:async()=>{note('issue');return {signature:'33'.repeat(64)};},
 refundQuote:async()=>{note('refund-quote');return {plan:{id:'44'.repeat(32),source:plan,fee:'0',record:plan.record,request:{owner:'PUBLIC SOLANA HOLDER'}}};},
 prepareRefund:async()=>({status:'prepared',proposal:{transaction:'PUBLIC REFUND'}}),
 approveRefund:async()=>{note('refund-approve');return {status:'finalized',receipt:{net:plan.record.amount}};}
};
const state=()=>fixture.statusOverride??({status:fixture.confirmed?'confirmed':['saved','saved-only'].includes(mode)?'not-found':'mempool',confirmed:fixture.confirmed,confirmations:fixture.confirmed?10:0,requiredConfirmations:10});
const api={publish:async value=>{note('publish',value);return state();},status:async()=>{note('status');return state();}};
const page=createNativeConversionPage({client,bridge,api,readBalance:async({kind})=>{note('balance',kind);if(fixture.balanceError)throw Error('Balance unavailable');return fixture.balanceOverride??(kind==='migrate-output'?'7530668912636':'123456789');},setup:mode==='setup',savedOnly:mode==='saved-only',initialSource:'migrate-output',onComplete:()=>note('complete'),account:{solana:'PUBLIC SOLANA HOLDER',monero:plan.record.owner},signCustody:async value=>{note('holder-sign',value);return {transaction:'PUBLIC HOLDER APPROVAL'};},token:{symbol:'EXTREMIST'},assertCurrent:()=>{},onClose:()=>{fixture.closed=true;}});
fixture.close=()=>page.close();await page.open();fixture.ready=true;window.addEventListener('pagehide',()=>page.close());
