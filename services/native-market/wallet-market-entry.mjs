// Public presentation and signed-listing transport. Private operations are
// supplied only by the shared wallet's installed worker client.
import {formatDecimal,quoteLot} from '../../shared/market/amounts.mjs';
import {createListingClient} from './listing-client.mjs';
import {encodeOffer} from './native-offers/codec.mjs';
import {createMarketTradePanel} from './trade-panel.mjs';
import {readTradeReferences} from './trade-references.mjs';
import {OPERATOR_CUSTODY,OPERATOR_DISCLOSURE} from './operator-policy.mjs';
import {NATIVE_MARKET_CONFIGURATION} from './frontend/native-market-config.js';
const nonce=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export function prepareMarketPage({serviceOrigin=globalThis.location?.origin,initialMarket=null}={}){
 const $=id=>document.getElementById(id),publish=$('sell-form').querySelector('button'),reason=$('sell-form').querySelector('.order-help');
 const symbol=NATIVE_MARKET_CONFIGURATION?.display?.symbol??'XMR20';
 if(symbol!=='XMR20'){
  const pair=document.createElement('span');pair.className='token-pair';pair.textContent=' / XMR';
  $('token-name').replaceChildren(document.createTextNode(symbol),pair);
  const description=$('token-name').parentElement.querySelector('p');if(description)description.textContent='Monero token · Operator-verified bridge';
  $('listings-heading').textContent=symbol+' listings';
  document.querySelector('.market-stats div:last-child small').textContent=symbol;
  document.querySelector('.section-heading .muted').textContent='XMR per '+symbol;
  document.querySelector('label[for="sell-quantity"] span').textContent=symbol;
  const assetLink=document.querySelector('.token-heading .text-link');
  assetLink.href='https://solscan.io/token/'+NATIVE_MARKET_CONFIGURATION.display.mint;
  assetLink.textContent='View Solana token ↗';assetLink.target='_blank';assetLink.rel='noopener noreferrer';
  const headingLink=document.querySelector('.page-heading .quiet-link');
  headingLink.href='#bridge-trust';headingLink.textContent='About the bridge';
 }
 let session=null,generation=0,service=null,offers=[],busy=false,selected=initialMarket?.listingId??null,tradePanel=null;
 const tradeElement=document.createElement('section');tradeElement.className='native-trade';tradeElement.hidden=true;tradeElement.setAttribute('aria-label','Trade review');document.querySelector('.order-panel').append(tradeElement);
 const savedTrades=document.createElement('section');savedTrades.className='seller-listings';savedTrades.hidden=true;tradeElement.before(savedTrades);
 const publicApi=createListingClient({scope:'read-only'});
 const empty=(id,text)=>{const p=document.createElement('p');p.className='activity-empty';p.textContent=text;$(id).replaceChildren(p);};
 const message=(text,error=false)=>{const el=$(error?'sell-error':'sell-status');el.textContent=text;el.hidden=!text;};
 const current=(expected,version)=>{if(session!==expected||generation!==version)throw Error('Wallet changed.');expected?.assertCurrent();};
 document.querySelector('.account-toolbar').replaceChildren();document.querySelector('.account-toolbar').classList.add('wallet-account-toolbar');
 const bridgeTrust=document.createElement('section');bridgeTrust.className='native-bridge-disclosure';bridgeTrust.hidden=true;bridgeTrust.setAttribute('aria-label','Bridge trust');
 const trustSummary=document.createElement('p');trustSummary.textContent=OPERATOR_DISCLOSURE.native;
 const trustDetails=document.createElement('details'),trustTitle=document.createElement('summary'),trustExplanation=document.createElement('p');trustDetails.id='bridge-trust';
 trustTitle.textContent=OPERATOR_DISCLOSURE.title;trustExplanation.textContent=OPERATOR_DISCLOSURE.summary+' '+OPERATOR_DISCLOSURE.risk;
 trustDetails.append(trustTitle,trustExplanation);bridgeTrust.append(trustSummary,trustDetails);document.querySelector('.account-toolbar').after(bridgeTrust);
 empty('activity-rows','No completed trades yet.');empty('seller-listings','Your published lots will appear here.');
 reason.id='listing-availability';publish.setAttribute('aria-describedby',reason.id);$('review-buy').disabled=true;
 const tradeReady=()=>Boolean(session?.capabilities?.available&&service?.negotiationAvailable&&session.capabilities.manifest===service.manifest);
 function renderBuy(){
  const entry=offers.find(o=>o.id===selected&&o.status==='open'&&o.purchasable);
  $('review-buy').disabled=busy||!entry||!tradeReady()||entry.offer.paymentAddress===session?.address||!!tradePanel;
  $('review-buy').textContent=tradePanel?'Trade review open':!entry?'Choose a listing':tradeReady()?'Review trade':'Buying unavailable';
  if(entry){$('receive-amount').textContent=formatDecimal(entry.offer.quantity,6)+' '+symbol;$('buy-total').textContent=formatDecimal(entry.offer.pricePiconero,12)+' XMR';}
  else{$('receive-amount').textContent='— '+symbol;$('buy-total').textContent='— XMR';}
 }
 function startTrade(entry,role,recoverOnly=false){
  if(session?.openMarket){void launchMarket({view:role==='buyer'?'buy':'list',...(role==='buyer'?{listingId:entry.id}:{})});return;}
  if(busy||tradePanel||!session||!recoverOnly&&!tradeReady())return;const active=session,version=generation;
  tradePanel=createMarketTradePanel({element:tradeElement,context:active,entry,role,recoverOnly,serviceOrigin,assertCurrent:()=>current(active,version),csrfProvider:async()=>{const state=await active.api.recoverySession();current(active,version);if(!state.journalConfigured||state.manifest!==entry.offer.manifest)throw Error('Market recovery journal is unavailable for this token.');return state.csrf;}});
  renderAvailability();renderOffers();tradeElement.scrollIntoView({block:'nearest'});
 }
 function renderSavedTrades(){
  savedTrades.replaceChildren();savedTrades.hidden=true;if(!session)return;
  try{const rows=readTradeReferences(session);if(!rows.length)return;savedTrades.hidden=false;const h=document.createElement('h4');h.textContent='Saved trades';savedTrades.append(h);
   for(const row of rows){const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='Resume '+row.role+' trade · '+formatDecimal(row.entry.offer.quantity,6)+' '+symbol;b.disabled=busy||!!tradePanel;b.addEventListener('click',()=>startTrade(row.entry,row.role,true));savedTrades.append(b);}
  }catch{savedTrades.hidden=false;const p=document.createElement('p');p.className='form-error';p.textContent='Saved trade references could not be read. Preserve this browser’s data before continuing.';savedTrades.append(p);}
 }
 function renderAvailability(){
  bridgeTrust.hidden=NATIVE_MARKET_CONFIGURATION?.backing?.mode!==OPERATOR_CUSTODY&&service?.bridgeTrust!==OPERATOR_CUSTODY&&session?.capabilities?.bridgeTrust!==OPERATOR_CUSTODY;
  const enabled=Boolean(session?.capabilities?.available&&service?.listingAvailable&&session.capabilities.manifest===service.manifest);
  let pending=false,pendingAction=false,storageError='';try{pending=!!session?.api.pending();pendingAction=!!session?.api.pendingAction();}catch(error){storageError=error.message;}
  for(const id of ['sell-quantity','sell-price'])$(id).disabled=busy;
  publish.disabled=busy||!!tradePanel||!!storageError||!(enabled||pendingAction||pending);publish.textContent=pendingAction?'Retry seller action':pending?'Retry listing':enabled?'Publish listing':'Listing unavailable';
  reason.textContent=service?.code==='activation-unconfigured'?'Existing-token conversion has not been activated. Your current holdings remain in their existing bridge.':!service?'Checking market service…':!session?'Connect your wallet to list a mature native token lot.':!session.capabilities?.available?session.capabilities?.reason||'Checking private wallet signing…':!enabled?'Wallet and market activation must match before listing.':'Publishing signs an offer for one whole native token lot. Your tokens remain in your wallet.';
  if(storageError)reason.textContent=storageError;
  renderBuy();
  renderSavedTrades();
 }
 function renderOffers(){
  const open=offers.filter(o=>o.status==='open'&&o.purchasable),sort=$('sort').value;
  open.sort((a,b)=>{const x=sort==='quantity'?a.offer.quantity:sort==='total'?a.offer.pricePiconero:a.offer.pricePiconero*b.offer.quantity,y=sort==='quantity'?b.offer.quantity:sort==='total'?b.offer.pricePiconero:b.offer.pricePiconero*a.offer.quantity;return x<y?-1:x>y?1:0;});
  $('listing-count').textContent=String(open.length);$('listed-amount').textContent=formatDecimal(open.reduce((n,x)=>n+x.offer.quantity,0n),6);
  const cheapest=[...open].sort((a,b)=>a.offer.pricePiconero*b.offer.quantity<b.offer.pricePiconero*a.offer.quantity?-1:1)[0];
  const unit=offer=>formatDecimal(offer.pricePiconero*1000000n/offer.quantity,12);
  $('lowest-ask').textContent=cheapest?unit(cheapest.offer):'—';
  if(!open.length)empty('lots','No listings are available yet.');else $('lots').replaceChildren(...open.map(entry=>{
   const row=document.createElement('label');row.className='lot-row';const radio=document.createElement('input');radio.type='radio';radio.name='native-lot';radio.value=entry.id;
   radio.disabled=busy||!!tradePanel;
   const quantity=document.createElement('span'),price=document.createElement('span'),total=document.createElement('strong');quantity.textContent=formatDecimal(entry.offer.quantity,6);price.textContent=unit(entry.offer);total.textContent=formatDecimal(entry.offer.pricePiconero,12);
   radio.checked=selected===entry.id;radio.addEventListener('change',()=>{selected=entry.id;renderBuy();$('buy-review').hidden=tradeReady();$('buy-review').textContent='Native token conversion and wallet verification must be active before this trade can start.';});row.append(radio,quantity,price,total);return row;
  }));
  const mine=offers.filter(o=>o.offer.paymentAddress===session?.address);
  if(!mine.length)empty('seller-listings','Your published lots will appear here.');else $('seller-listings').replaceChildren(...mine.map(entry=>{
   const row=document.createElement('div'),p=document.createElement('p');p.textContent=formatDecimal(entry.offer.quantity,6)+' '+symbol+' · '+formatDecimal(entry.offer.pricePiconero,12)+' XMR · '+entry.status;row.append(p);
   if(entry.status==='open'){
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel listing';cancel.disabled=busy||!!tradePanel||!session?.capabilities?.available;
    cancel.addEventListener('click',()=>void cancelListing(entry));row.append(cancel);
   }
   if(['open','signature-released'].includes(entry.status)){
    const requests=document.createElement('button');requests.type='button';requests.textContent='Buyer requests';requests.disabled=busy||!tradeReady()||!!tradePanel;requests.addEventListener('click',()=>startTrade(entry,'seller'));row.append(requests);
   }return row;
  }));
  renderBuy();
 }
 async function syncWallet(active,version){
  await active.client.unlock();current(active,version);let sync;
  do{sync=await active.client.sync();current(active,version);message(sync.ready?'Checking native token inventory…':'Checking Monero blocks '+sync.height+' of '+sync.targetHeight+'…');}while(!sync.ready);
 }
 async function cancelListing(entry){
  if(session?.openMarket)return launchMarket({view:'list'});
  if(busy)return;const active=session,version=generation;busy=true;message('',true);renderAvailability();renderOffers();
  try{
   current(active,version);if(active.api.pendingAction())throw Error('Retry the saved seller action first.');
   message('Unlock your Monero wallet to cancel this listing.');await syncWallet(active,version);
   const offer=entry.offer,action={type:'cancel',offerId:entry.id,nonce:nonce()};
   const terms={manifest:offer.manifest,genesis:offer.genesis,source:{txid:offer.source.txid,vout:String(offer.source.vout)},quantity:offer.quantity.toString(),pricePiconero:offer.pricePiconero.toString(),paymentAddress:offer.paymentAddress,expiresAt:offer.expiresAt.toString(),nonce:offer.nonce,recordId:offer.provenance.recordId,height:offer.provenance.height.toString(),globalIndex:offer.provenance.globalIndex.toString()};
   const proof=await active.client.authorizeOfferAction({terms,action});current(active,version);
   await active.api.sellerAction({offerBytes:encodeOffer(offer).toString('hex'),action,proof});current(active,version);
   message('Listing cancelled.');await refresh();
  }catch(error){if(session===active&&generation===version){message('');message(error.message||'Cancellation could not complete. Retry the saved request.',true);}}
  finally{if(session===active&&generation===version){busy=false;renderAvailability();renderOffers();}}
 }
 async function refresh(){
  const version=generation;try{const [state,book]=await Promise.all([publicApi.status(),publicApi.offers()]);if(version!==generation)return;service=state;offers=book.offers;$('market-error').hidden=true;}
  catch{if(version!==generation)return;service={listingAvailable:false};offers=[];$('market-error').textContent='Market data is unavailable. Refresh to retry.';$('market-error').hidden=false;}
  renderAvailability();renderOffers();
 }
 $('sell-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||publish.disabled)return;const active=session,version=generation;busy=true;message('',true);renderAvailability();
  try{
   current(active,version);
   if(active.openMarket){const quote=quoteLot($('sell-quantity').value,$('sell-price').value);if(quote.error)throw Error(quote.error);await active.openMarket({view:'list',quantity:quote.quantityUnits.toString(),total:quote.totalUnits.toString()});current(active,version);message('Review your listing in XMR20 Wallet.');return;}
   if(active.api.pendingAction()){message('Retrying the saved signed seller action…');await active.api.retryAction();current(active,version);message('Seller action recorded.');await refresh();return;}
   if(active.api.pending()){message('Retrying the saved signed listing…');await active.api.retry();}
   else{
    const quote=quoteLot($('sell-quantity').value,$('sell-price').value);if(quote.error)throw Error(quote.error);
    message('Unlock your Monero wallet to review the listing.');await syncWallet(active,version);
    const inventory=await active.client.inventory();current(active,version);const lot=inventory.find(x=>!x.held&&BigInt(x.quantity)===quote.quantityUnits);
    if(!lot)throw Error('This quantity must match one confirmed native token lot. Existing bridge balances need conversion before listing.');
    const terms={manifest:active.capabilities.manifest,genesis:active.capabilities.genesis,source:{txid:lot.source.txid,vout:String(lot.source.vout)},quantity:lot.quantity,pricePiconero:quote.totalUnits.toString(),paymentAddress:active.address,expiresAt:String(Math.floor(Date.now()/1000)+3600),nonce:nonce(),recordId:lot.recordId,height:lot.height,globalIndex:lot.globalIndex};
    message('Signing the exact listing with your Monero wallet…');const signed=await active.client.authorizeOffer({terms});current(active,version);await active.api.publish(signed);
   }
   current(active,version);message('Listing published. Keep this wallet available to approve a buyer’s transaction.');await refresh();
  }catch(error){if(session===active&&generation===version){message('',false);message(error.message||'Listing could not be completed. Refresh and retry.',true);}}
  finally{if(session===active&&generation===version){busy=false;renderAvailability();}}
 });
 for(const id of ['sell-quantity','sell-price'])$(id).addEventListener('input',()=>{const quote=quoteLot($('sell-quantity').value,$('sell-price').value);$('sell-total').textContent=quote.error?'— XMR':formatDecimal(quote.totalUnits,12)+' XMR';});
 $('sort').addEventListener('change',renderOffers);
 $('review-buy').addEventListener('click',()=>{const entry=offers.find(o=>o.id===selected);if(entry&&!$('review-buy').disabled)startTrade(entry,'buyer');});
 $('sell-panel').querySelector('.order-help').textContent='List one confirmed native token lot at a price in XMR.';
 $('buy-panel').querySelector('.purchase-summary p').textContent='The exact XMR total and network fee are reviewed before signing.';
 document.querySelector('.how-it-works ol').replaceChildren(...[
  'Connect your Monero wallet. Sends and trades require no Solana wallet or link.',
  'Existing linked bridge holdings need a one-time, explicitly approved conversion before they can be sent or traded on Monero.',
  'A listing is a signed offer for one whole token output. Buyer and seller must approve the same complete Monero transaction.',
  'Payment and token ownership are checked against confirmed native and token history. An ancestry-changing reorganization is outside that settlement guarantee.'
 ].map(text=>{const li=document.createElement('li');li.textContent=text;return li;}));
 for(const name of ['buy','sell'])$(name+'-tab').addEventListener('click',()=>{for(const tab of ['buy','sell']){$(tab+'-tab').setAttribute('aria-pressed',String(tab===name));$(tab+'-panel').hidden=tab!==name;}});
 async function launchMarket(request){
  const active=session,version=generation;if(!active?.openMarket||busy)return;
  busy=true;renderAvailability();try{await active.openMarket(request);current(active,version);message('Continue in XMR20 Wallet.');}catch(error){if(session===active)message(error.message,true);}finally{if(session===active){busy=false;renderAvailability();}}
 }
 if(initialMarket?.view==='list'){
  $('sell-tab').click();
  if(initialMarket.quantity&&initialMarket.total){
   const q=BigInt(initialMarket.quantity),p=BigInt(initialMarket.total)*1000000n;
   if(p%q!==0n)throw Error('This listing price cannot be represented exactly.');
   $('sell-quantity').value=formatDecimal(q,6).replaceAll(',','');$('sell-price').value=formatDecimal(p/q,12).replaceAll(',','');$('sell-price').dispatchEvent(new Event('input'));
  }
 }
 renderAvailability();renderOffers();void refresh();
 return Object.freeze({refresh,hasActiveTrade:()=>!!tradePanel,needsWalletRestart:()=>session?.client?.isDisposed?.()===true,
  setWallet(value){generation++;tradePanel?.close();tradePanel=null;session=value;busy=false;message('',true);message('');renderAvailability();renderOffers();void refresh();},
  setCapabilities(client,capabilities){if(session?.client===client){session.capabilities=capabilities;renderAvailability();renderOffers();}}
 });
}
