import {createNativeSwapPage} from '../src/native-swap-page.js';
import '../src/native-send-page.css';
// Mirror the wallet popup container used by app.js.
document.body.classList.add('native-popup-root');
globalThis.fixture={ready:false,calls:[],orders:[],paid:[],failCreate:false};
let quote;
const page=createNativeSwapPage({container:document.body,account:{solana:'PUBLIC SOLANA WALLET',monero:'PUBLIC MONERO WALLET'},
 assertCurrent(){},onClose(){fixture.closed=true;},onTokens(){fixture.tokens=true;},onPay(order){fixture.paid.push(order);},
 maximum:async direction=>direction==='sol-xmr'?'123456789':'123456789012',
 loadOrders:()=>fixture.orders,saveOrder:async order=>{fixture.orders=[...fixture.orders.filter(x=>x.requestId!==order.requestId),order];},
 fetcher:async(url,options)=>{
  const request=JSON.parse(options.body);fixture.calls.push(request);
  if(request.action==='quote')return new Response(JSON.stringify(quote={...request,id:'public-request',receive:'0.002',expires:Date.now()+120000,authorization:'PUBLIC QUOTE'}));
  if(request.action==='create'){
   if(!fixture.orders.length)throw Error('Creation must be saved first');
   if(fixture.failCreate)throw new DOMException('Public fixture timeout','TimeoutError');
   return new Response(JSON.stringify({id:'public-order',requestId:'public-request',direction:quote.direction,amount:quote.amount,destination:quote.destination,refund:quote.refund,payin:'PUBLIC DEPOSIT ADDRESS',receipt:'PUBLIC RECEIPT',status:'waiting'}));
  }
  return new Response(JSON.stringify({id:'public-order',status:'finished'}));
 }
});
page.open();fixture.ready=true;fixture.reopen=()=>page.open();
