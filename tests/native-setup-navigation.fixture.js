// Disposable public fixtures only: no owner wallet, keys, network or signatures.
import {createNativePopupFlow} from '../src/native-popup-flow.js';
import {createNativeConversionPage} from '../src/native-conversion-page.js';
import {createNativeRedemptionPage} from '../src/native-redemption-page.js';
const mode=new URLSearchParams(location.search).get('mode')||'convert';
// '<view>-finished': the saved credit is confirmed with tokens allocated.
const [initialView,setupState='open']=mode.split('-');
const legacy=new URLSearchParams(location.search).get('legacy')==='1',receiptsOk=new URLSearchParams(location.search).get('receipts')==='ok';
const account={id:'public-fixture',monero:'4'+'a'.repeat(94),solana:'11111111111111111111111111111112'};
const plan={id:'11'.repeat(32),request:{kind:'migrate-output',amount:'7530668912636',fee:'0'},record:{owner:account.monero,amount:'7530668912636'}};
const saved={preparationId:'public-preparation',plan,quote:{kind:'migrate-output',net:'7530668912636'}};
globalThis.fixture={calls:[],ready:false};const note=name=>fixture.calls.push(name);
const client={capabilities:async()=>({available:true}),unlock:async()=>note('unlock'),
 operatorCreditPreparations:async()=>{note('saved-list');return [saved];},
 nativeRedemptionReceipts:async()=>{note('redemption-list');if(receiptsOk)return [];throw Error('Native market operation could not be verified. Reopen the wallet and try again; saved records are kept. (M00)');},
 recoverOperatorCreditPreparation:async()=>{note('recover-preparation');return saved;},
 recoverPreparedCarrier:async()=>{note('recover-carrier');return {state:'signed',transaction:'PUBLIC FIXTURE',txid:'22'.repeat(32)};},
 sync:async()=>{note('sync');throw Error('Navigation must not sync');}
};
const api={status:async()=>{note('status');return {status:'not-found',confirmed:false,confirmations:0,requiredConfirmations:10};}};
const bridge={quote:async()=>{note('quote');throw Error('No amount selected');}};
const setupStatus=async()=>{note('setup-status');return setupState==='finished'?{status:'confirmed',confirmed:true,tokenAllocated:true,confirmations:10,requiredConfirmations:10}:{status:'not-found',confirmed:false,confirmations:0,requiredConfirmations:10};};
const setupManifest='ab'.repeat(32),marks={},setupStore={get:async keys=>Object.fromEntries(keys.filter(k=>k in marks).map(k=>[k,marks[k]])),set:async value=>{note('setup-mark');Object.assign(marks,value);}};
const event=()=>{const listeners=[];return {addListener:f=>listeners.push(f),emit:v=>listeners.forEach(f=>f(v))};};
const runtime={getURL:p=>p==='market-entry.css'?'/market-entry.css':'/'+p,connect(){
 const port={onMessage:event(),onDisconnect:event(),disconnect(){},postMessage({id,message}){note(message.action);queueMicrotask(()=>port.onMessage.emit({id,reply:{value:{requestId:'12345678-1234-1234-1234-123456789012',account}}}));}};return port;
}};
const modal=document.querySelector('dialog');let flow;
async function open(view,savedOnly=false){
 flow?.close();fixture.ready=false;
 flow=createNativePopupFlow({modal,accountId:account.id,runtime,assertWallet:()=>{},token:{symbol:'EXTREMIST'},onBack:()=>note('back'),
  onSavedSetup:savedOnly?undefined:()=>void open('convert',true),pageOptions:{savedOnly,setupStore,setupManifest},setupStatus,setupStore,setupManifest,
  // Mirrors app.js: the panels' swap button switches direction; earlier balances keep a separate link.
  bridgeSwitch:savedOnly?undefined:id=>void open(id),bridgeLinks:!savedOnly&&legacy?[{label:'Previously bridged tokens',open:()=>note('legacy')}]:[],onCoins:savedOnly?undefined:()=>note('coins'),
  hostFactory:()=>({open:async()=>({account,market:{view},client,signCustody:async()=>{note('SIGN');throw Error('Never sign');},assertCurrent:()=>{}}),check:async()=>{},close(){},release:async()=>note('release')}),
  pages:{convert:options=>createNativeConversionPage({...options,api,bridge,readBalance:async()=>{note('balance');return '0';}}),redeem:options=>createNativeRedemptionPage({...options,api,bridge})}
 });await flow.open(view);fixture.ready=true;
}
fixture.close=()=>flow?.close();await open(initialView);window.addEventListener('pagehide',()=>flow?.close());
