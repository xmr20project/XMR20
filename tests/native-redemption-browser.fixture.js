// Public UI fixtures only. No real wallet, signatures or relay.
import {createNativeRedemptionPage} from '../src/native-redemption-page.js';
import '../src/native-send-page.css';
const mode=new URLSearchParams(location.search).get('mode'),destination='11111111111111111111111111111112';
const quote={redemption:'11'.repeat(32),terms:{amount:'7530668912636',maximumTokenFee:'112960033690',observedTokenFee:'112960033690',destination}};
const row={reservationId:'public-receipt',operationId:quote.redemption,signatureHash:'22'.repeat(32),quantity:quote.terms.amount,recipient:'00'.repeat(31)+'01',bridgeQuote:quote,txid:mode==='uncached'?null:'33'.repeat(32)};
globalThis.fixture={calls:[],destination,closed:false,confirmed:false,paid:false,lost:false};
const note=(name,value)=>fixture.calls.push({name,value});
const client={
 unlock:async()=>note('unlock'),nativeRedemptionReceipts:async()=>['saved','uncached'].includes(mode)?[row]:[],
 sync:async()=>{note('sync');return {ready:true};},inventory:async()=>[{quantity:row.quantity,source:{txid:'44'.repeat(32),vout:0},held:false}],
 constructRedemption:async({terms})=>{note('construct',terms);if(fixture.holdConstruction)await new Promise(r=>fixture.finishConstruction=r);if(fixture.fundingMissing)throw Error('Add XMR to pay the Monero network fee');return {handle:'public-review',fee:fixture.feeOverride||'30000000',quantity:fixture.quantityOverride||terms.quantity,recipient:fixture.recipientOverride||terms.recipient};},
 signRedemption:async value=>{note('sign',value);return row;},assembleRedemption:async()=>{note('assemble');return {...row,transaction:'PUBLIC FIXTURE ONLY'};},
 recoverRedemption:async()=>{note('recover');return {...row,txid:'33'.repeat(32),transaction:'PUBLIC FIXTURE ONLY'};}
};
const state=()=>({txid:'33'.repeat(32),status:fixture.confirmed?'confirmed':['saved','uncached'].includes(mode)?'not-found':'mempool',confirmed:fixture.confirmed,confirmations:fixture.confirmed?10:0,requiredConfirmations:10});
const api={publish:async value=>{note('publish',value);if(fixture.lost)throw Error('Connection interrupted. Your approval is saved.');return state();},status:async value=>{note('status',value);return state();}};
const bridge={quote:async value=>{note('quote',value);if(fixture.quoteError)throw Error('Fee service unavailable');return {...quote,terms:{...quote.terms,...value}};},status:async value=>{note('bridge-status',value);return {status:fixture.paid?'finalized':'confirming',signature:'2'.repeat(88)};}};
const page=createNativeRedemptionPage({client,api,bridge,token:{symbol:'EXTREMIST'},assertCurrent:()=>{},onClose:()=>{fixture.closed=true;}});
fixture.close=()=>page.close();await page.open();fixture.ready=true;window.addEventListener('pagehide',()=>page.close());
