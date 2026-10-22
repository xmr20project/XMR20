// Shared-wallet presentation for the typed, privately verified trade driver.
// Polling only reads status. Each signing stage requires its own visible action.
import {Buffer} from 'buffer';
import {openTradeMailbox} from './trade-sessions/mailbox-client.mjs';
import {openTradeSettlement} from './trade-sessions/settlement-client.mjs';
import {createTradeOrchestrator} from './wallet/trade-orchestrator.mjs';
import {encodeOffer} from './native-offers/codec.mjs';
import {inspectCarrier} from './xn1/carrier.mjs';
import {parseDecimal,formatDecimal} from '../../shared/market/amounts.mjs';
import {saveTradeReference} from './trade-references.mjs';

const labels={prepare:'Prepare transaction',authorizeProof:'Approve token transfer',finalize:'Finalize transaction',review:'Review transaction',sign:'Sign reviewed transaction',shareSignature:'Share saved signature',assemble:'Assemble signed transaction',retry:'Retry saved request',rebasePending:'Review updated trade and retry',recoverRelease:'Recover saved release',recoverSignature:'Recover saved signature',syncRecovered:'Verify history for recovered trade'};
const phases={requested:'Waiting for the seller',contributed:'Seller joined',proposed:'Preparing token approvals',finalized:'Ready for wallet review',held:'Seller signature protected',signed:'Both wallets signed',assembled:'Signed transaction prepared',aborted:'Trade cancelled'};
const need=(yes,text)=>{if(!yes)throw Error(text);};
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};

export function createMarketTradePanel({element,context,entry,role,csrfProvider,assertCurrent,recoverOnly=false,serviceOrigin=globalThis.location?.origin}){
 let active=true,busy=false,mailbox,driver,settlement,quote,hasSynced=false;
 const current=()=>{need(active,'Trade view closed.');assertCurrent();};
 const after=async promise=>{const result=await promise;current();return result;};
 const title=node('h4',role==='buyer'?'Buy this listing':'Respond to a buyer');
 const status=node('p','Review the fee limit before opening this trade.','order-help');status.setAttribute('role','status');
 const error=node('p','','form-error');error.setAttribute('role','alert');error.hidden=true;
 const feeLabel=node('label','Maximum network fee (XMR)'),fee=node('input');fee.type='text';fee.inputMode='decimal';fee.placeholder='e.g. 0.005';fee.autocomplete='off';feeLabel.append(fee);
 const details=node('div',undefined,'purchase-summary'),signedDetails=node('div',undefined,'purchase-summary'),actions=node('div',undefined,'trade-actions');signedDetails.hidden=true;
 const start=node('button',role==='buyer'?'Request this trade':'Check buyer requests','secondary');start.type='button';
 element.replaceChildren(title,status,feeLabel,details,signedDetails,error,actions);actions.append(start);element.hidden=false;
 function paintQuote(value){
  quote=value;details.replaceChildren();
  const amount=(label,value,decimals=12,suffix='XMR')=>{if(value===undefined)return;const row=node('div');row.append(node('span',label),node('strong',formatDecimal(BigInt(value),decimals)+' '+suffix));details.append(row);};
  amount('Token quantity',value.quantity,6,'XMR20');amount('Listing price',value.pricePiconero);amount('Network fee',value.feePiconero);amount('Carrier amount',value.carrierPiconero);amount('Total debit',value.debitPiconero);amount('You receive',value.receivePiconero);
  const fingerprint=node('small','Transaction review: '+value.signatureHash);fingerprint.className='trade-fingerprint';details.append(fingerprint);
 }
 function button(text,fn){const e=node('button',text,'secondary');e.type='button';e.disabled=busy;e.addEventListener('click',()=>void work(fn));return e;}
 async function work(fn){
  if(busy||!active)return;busy=true;error.hidden=true;for(const el of actions.querySelectorAll('button'))el.disabled=true;
  try{await fn();current();}
  catch(e){if(active){error.textContent=e.message||'Trade could not continue. Its saved requests and input reservations remain protected.';error.hidden=false;if(driver){try{await paint();}catch{/* Keep the original actionable error and existing recovery state. */}}}}
  finally{if(active){busy=false;for(const el of actions.querySelectorAll('button'))el.disabled=false;}}
 }
 async function init(){
  if(driver)return;
  const maximumFee=parseDecimal(fee.value,12);need(maximumFee>0n,'Enter a positive maximum network fee in XMR.');
  const identity=await after(saveTradeReference({context,entry,role,assertCurrent:current}));
  const opened=await openTradeMailbox({scope:{owner:context.owner+':'+context.address,genesis:entry.offer.genesis,offerId:entry.id,role,identity},csrfProvider,assertCurrent:current,origin:serviceOrigin});
  try{current();mailbox=opened;driver=await createTradeOrchestrator({wallet:context.client,mailbox,role,offerBytes:encodeOffer(entry.offer).toString('hex'),offerProof:entry.proof,maximumFee:maximumFee.toString(),carrier:'1000000',assertCurrent:current});current();}
  catch(e){opened.close();driver?.close();mailbox=null;driver=null;throw e;}
  fee.disabled=true;
 }
 async function unlock(){
  if(hasSynced)return;status.textContent='Unlock your linked Monero wallet and verify its history.';
  await after(context.client.unlock());let s;do{s=await after(context.client.sync());status.textContent=s.ready?'Monero history verified.':'Checking Monero blocks '+s.height+' of '+s.targetHeight+'…';}while(!s.ready);
  hasSynced=true;
 }
 async function openSettlement(){
  if(settlement)return settlement;
  const opened=await openTradeSettlement({mailbox,csrfProvider,assertCurrent:current,origin:serviceOrigin});
  try{current();settlement=opened;return opened;}catch(e){opened.close();throw e;}
 }
 async function paintSettlement(result){
  const tx=inspectCarrier(Buffer.from(result.transaction,'hex'));signedDetails.replaceChildren();signedDetails.hidden=false;
  const amounts=[['Token quantity',formatDecimal(entry.offer.quantity,6)+' XMR20'],['Listing price',formatDecimal(entry.offer.pricePiconero,12)+' XMR'],['Network fee',formatDecimal(tx.fee,12)+' XMR']];
  for(const [label,value] of amounts){const row=node('div');row.append(node('span',label),node('strong',value));signedDetails.append(row);}
  signedDetails.append(node('p','Signed transaction: '+tx.txid,'trade-fingerprint'));
  status.textContent='Both wallets signed. This is not a completed purchase until payment and token ownership are confirmed.';
  const client=await openSettlement();
  let state,pending;try{pending=await after(client.pending());state=await after(client.status());}
  catch(e){status.textContent='Confirmation is unavailable. Your signed transaction and saved submission remain available for recovery.';actions.append(button('Check confirmation',paint));if(pending)actions.append(button('Retry saved submission',async()=>{await after(client.retry());await paint();}));throw e;}
  const descriptions={
   assembled:'Both wallets signed. Broadcast the exact signed transaction to submit this trade.',
   'submission-unknown':'The submission result is unknown. Check confirmation or retry the same saved transaction.',
   accepted:'A Monero node accepted the transaction. Payment and token ownership are awaiting independent confirmation.',
   mempool:'The transaction is in the Monero mempool. Payment and token ownership are not confirmed yet.',
   confirming:'The transaction is being confirmed. Token ownership has not yet been verified.',
   confirmed:'Payment and token ownership are verified. The new token lot is waiting to reach spending maturity.',
   mature:'Trade confirmed. Payment and token ownership are verified, and the new token lot has reached spending maturity.',
   rejected:'The Monero node rejected this submission. The saved transaction remains available for inspection.',
   'invalid-allocation':'The native transaction does not have a valid matching token allocation. This is not a completed trade.',
   unavailable:'Settlement verification is unavailable. Preserve this trade’s saved recovery data.'
  };
  status.textContent=descriptions[state.status];
  if(state.confirmations!=='0')signedDetails.append(node('p',state.confirmations+' native confirmations · '+(state.mature?'token lot mature':'token maturity pending'),'order-help'));
  if(state.reason)signedDetails.append(node('p',state.reason,'order-help'));
  if(!state.confirmed&&!state.mature&&state.status!=='invalid-allocation'){
   if(pending)actions.append(button('Retry saved submission',async()=>{await after(client.retry());await paint();}));
   else if(state.status==='assembled')actions.append(button(state.submissionAttempted?'Rebroadcast signed transaction':'Broadcast signed transaction',async()=>{await after(state.submissionAttempted?client.rebroadcast():client.broadcast());await paint();}));
  }
  actions.append(button('Check confirmation',paint));
 }
 async function paint(){
  const state=await after(driver.poll());actions.replaceChildren();status.textContent=phases[state.phase]||'Trade ready to continue.';
  if(state.recoveryRequired){status.textContent='This trade needs recovery. Existing wallet reservations remain protected; do not create a replacement signature.';}
  const permitted=Array.isArray(state.actions)?state.actions:[];
  for(const action of permitted){if(!labels[action])continue;
   actions.append(button(labels[action],async()=>{
    if(['recoverRelease','recoverSignature','syncRecovered'].includes(action))await after(context.client.unlock());
    else if(!['retry','rebasePending','shareSignature','assemble'].includes(action))await unlock();
    let result;if(action==='sign'){need(quote?.signatureHash,'Review this exact transaction before signing.');result=await after(driver.sign({signatureHash:quote.signatureHash}));}
    else if(action==='syncRecovered'){
     do{result=await after(driver.syncRecovered());status.textContent=result.sync.ready?'Monero history verified.':'Checking Monero blocks '+result.sync.height+' of '+result.sync.targetHeight+'…';}while(!result.sync.ready);
     hasSynced=true;
    }
    else result=await after(driver[action]());
    if(action==='review')paintQuote(result);if(action==='recoverSignature'&&result.quote)paintQuote(result.quote);await paint();
   }));
  }
  if(state.phase==='assembled'){
   const result=await after(Promise.resolve(driver.result()));
   if(result?.transaction)await paintSettlement(result);
  }
  actions.append(button('Refresh trade',paint));
 }
 async function open(){
  await init();const identity=await after(mailbox.identity());
  if(identity.sessionId){await paint();return;}
  need(!recoverOnly,'No trade was submitted from this saved reference. Open a verified live listing to start a new trade.');
  if(role==='buyer'){await after(driver.create({}));await paint();}
  else{
   const requests=await after(mailbox.inbox());actions.replaceChildren();status.textContent=requests.length?'Choose a buyer request to review.':'No buyer requests yet.';
   for(const request of requests)actions.append(button('Review buyer '+request.buyerKey.slice(0,8)+'…',async()=>{await unlock();await after(driver.accept(request));await paint();}));
   actions.append(button('Refresh requests',open));
  }
 }
 start.addEventListener('click',()=>void work(open));
 return Object.freeze({close(){active=false;settlement?.close();driver?.close();mailbox?.close();element.replaceChildren();element.hidden=true;}});
}
