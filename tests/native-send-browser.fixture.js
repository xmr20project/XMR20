// Entirely public UI fixture. No wallet keys, native worker or network relay.
import {createNativeSendPage} from '../src/native-send-page.js';
import '../src/native-send-page.css';
const mode=new URLSearchParams(location.search).get('mode');
const recipient='47zk7yrx6CeD1Xjxb6ogocPtpgrKN2wcXcUSynYUqn5xaxPL6h2Lu5Ndjs9o3gqfRbZKGsAGKiH2N42Jw4wm5ktbRa439Ee';
const row={reservationId:'public-receipt',operationId:'11'.repeat(32),signatureHash:'22'.repeat(32),quantity:'7530668912636',recipientAddress:recipient,txid:mode==='uncached'?null:'33'.repeat(32)};
globalThis.fixture={calls:[],recipient,closed:false,confirmed:false,lost:false};
const note=(name,value)=>fixture.calls.push({name,value});
const client={
 unlock:async()=>{note('unlock');},nativeSendReceipts:async()=>mode==='saved'||mode==='uncached'?[row]:[],
 sync:async()=>{note('sync');return {ready:true};},inventory:async()=>[{quantity:row.quantity,source:{txid:'44'.repeat(32),vout:0},held:false}],
 constructPeerSend:async({terms})=>{note('construct',terms);if(fixture.holdConstruction)await new Promise(r=>fixture.finishConstruction=r);if(fixture.fundingMissing)throw Error('Add XMR to pay the Monero network fee');return {handle:'public-review',quantity:fixture.quantityOverride||terms.quantity,recipientAddress:fixture.recipientOverride||terms.recipientAddress,fee:fixture.feeOverride||'30000000'};},
 signPeerSend:async value=>{note('sign',value);return row;},
 assemblePeerSend:async()=>{note('assemble');return {...row,transaction:'PUBLIC FIXTURE ONLY'};},
 recoverPeerSend:async()=>{note('recover');return {...row,txid:'33'.repeat(32),transaction:'PUBLIC FIXTURE ONLY'};}
};
const state=()=>fixture.statusOverride??({txid:'33'.repeat(32),status:fixture.confirmed?'confirmed':mode==='saved'||mode==='uncached'?'not-found':'mempool',confirmed:fixture.confirmed,tokenAllocated:fixture.confirmed,confirmations:fixture.confirmed?10:0,requiredConfirmations:10});
const api={publish:async value=>{note('publish',value);if(fixture.lost)throw Error('Connection interrupted. Your send is saved.');return state();},status:async value=>{note('status',value);return state();}};
const page=createNativeSendPage({client,api,token:{symbol:'EXTREMIST'},assertCurrent:()=>{},onClose:()=>{fixture.closed=true;}});
fixture.close=()=>page.close();await page.open();fixture.ready=true;window.addEventListener('pagehide',()=>page.close());
