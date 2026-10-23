// Local fixture only: the website bridge host with public fakes for the private Monero
// worker, operator services and the Solana wallet. No keys, nodes or transactions.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Keypair} from '@solana/web3.js';
import WebsiteNativeBridge from '../../src/website-native-bridge.jsx';
import NativeMoneroTokens from '../../src/website-native-holdings.jsx';
import {recordNativeBridge,saveNativeDisplay} from '../../src/website-native-holdings.js';
import {nativeWalletLockName} from '../../src/website-native-lock.js';
import {NATIVE_MARKET_CONFIGURATION} from '../../../services/native-market/frontend/native-market-config.js';
import '../../src/wallet.css';

const mode=new URLSearchParams(location.search).get('mode'),solana=Keypair.generate().publicKey,owner=solana.toBase58();
const monero='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
const plan={id:'11'.repeat(32),record:{owner:monero,amount:'0'},request:{kind:'deposit',owner,amount:'0',fee:'0'},recipientCarrier:'PUBLIC FIXTURE'};
const prepared={preparationId:'public-preparation',plan,quote:{net:'0',nativeFee:'30000000',creationDeadline:780}};
const fixture=globalThis.fixture={calls:[],custodyConfirmed:false,closed:0};
if(mode!=='no-height')localStorage.setItem('xmr20-native-birth:'+monero,'3788100');else localStorage.removeItem('xmr20-native-birth:'+monero);const note=(name,value)=>fixture.calls.push({name,value});
const client={
 capabilities:async()=>{note('capabilities');return mode==='unavailable'?{available:false,reason:'This browser cannot run the Monero wallet worker.'}:{available:true};},
 unlock:async()=>note('unlock'),operatorCreditPreparations:async()=>[],dispose:()=>note('dispose'),
 sync:async()=>{note('sync');if(fixture.holdSync)await new Promise(r=>{fixture.releaseSync=r;});return {ready:true,height:100,target:100};},
 feeFundingStatus:async()=>({address:monero,ready:true,reason:'ready',totalRaw:'500000000',availableRaw:'500000000',lockedRaw:'0',requiredRaw:'101000000'}),
 inventory:async()=>[],discardCarrierReview:async()=>{},completeOperatorRefund:async()=>{},
 prepareOperatorCredit:async({request})=>{note('prepare',request);plan.request={...request};plan.record.amount=String(BigInt(request.amount)-BigInt(request.fee));prepared.quote.net=plan.record.amount;return prepared;},
 recoverOperatorCreditPreparation:async()=>prepared,recoverPreparedCarrier:async()=>({state:'signed',transaction:'PUBLIC SIGNED FIXTURE',txid:'22'.repeat(32)}),
 constructOperatorIssuedCredit:async()=>{note('build');if(fixture.holdBuild)await new Promise(r=>{fixture.releaseBuild=r;});return {handle:1,fee:'30000000'};},signCarrier:async v=>{note('sign',v);return {reservationId:'public-signature'};},
 assembleCarrier:async()=>({transaction:'PUBLIC SIGNED FIXTURE',txid:'22'.repeat(32)}),
 // Bridge to Solana (redemption): the Monero wallet signs; no Solana wallet approval.
 nativeRedemptionReceipts:async()=>[],
 constructRedemption:async({terms})=>{note('construct',terms);return {handle:'public-review',fee:'30000000',quantity:terms.quantity,recipient:terms.recipient};},
 signRedemption:async v=>{note('sign-redemption',v);return {reservationId:'public-redemption'};},
 assembleRedemption:async v=>{note('assemble-redemption',v);return {reservationId:'public-redemption',quantity:fixture.redeemed,txid:'66'.repeat(32),transaction:'PUBLIC FIXTURE ONLY',bridgeQuote:fixture.quote};},
 // Monero token send: the Monero wallet signs one transfer to another Monero address.
 nativeSendReceipts:async()=>[],
 constructPeerSend:async({terms})=>{note('construct-send',terms);return {handle:'public-send',fee:'30000000',quantity:terms.quantity,recipientAddress:terms.recipientAddress};},
 signPeerSend:async v=>{note('sign-send',v);return {reservationId:'public-send'};},
 assemblePeerSend:async v=>{note('assemble-send',v);return {reservationId:'public-send',quantity:fixture.calls.find(c=>c.name==='construct-send').value.quantity,txid:'88'.repeat(32),transaction:'PUBLIC FIXTURE ONLY'};}
};
// 'redeem' / 'switch': free Monero tokens to bridge back to Solana.
if(['redeem','switch','send'].includes(mode))client.inventory=async()=>[{source:{txid:'44'.repeat(32),vout:1},quantity:'250000000000',held:false},{source:{txid:'55'.repeat(32),vout:0},quantity:'2500000',held:true}];
const redeemBridge={quote:async v=>{note('redeem-quote',v);fixture.redeemed=v.amount;return fixture.quote={redemption:'77'.repeat(32),terms:{amount:v.amount,destination:v.destination,maximumTokenFee:'3750000000',observedTokenFee:'3750000000'}};},
 status:async()=>({status:'confirming'})};
const sendApi={publish:async v=>{note('send-publish',v);return {status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10};},status:async()=>({status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10})};
const burnApi={publish:async v=>{note('burn-publish',v);return {status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10};},status:async()=>({status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10})};
const bridge={
 quote:async v=>{note('quote',v);return {...v,fee:'15000'};},
 prepare:async()=>fixture.custodyConfirmed?{status:'finalized'}:{status:'prepared',proposal:{transaction:'PUBLIC CUSTODY'}},
 approve:async(plan,transaction)=>{note('approve',{owner:plan?.request?.owner,transaction});return {status:'submitted'};},status:async()=>({status:fixture.custodyConfirmed?'finalized':'confirming'}),
 retry:async()=>({status:'submitted'}),issue:async()=>{note('issue');return {signature:'33'.repeat(64)};}
};
// 'reserved': an earlier bridge holds the XMR fee coin and was never approved on Solana.
// 'reserved-cancel' cancels it; 'reserved-landed' finds its deposit already on Solana.
if(mode?.startsWith('reserved')){
 Object.assign(plan.request,{amount:'100000000000',fee:'1500000000'});plan.record.amount='98500000000';prepared.quote={kind:'deposit',gross:'100000000000',fee:'1500000000',net:'98500000000',nativeFee:'30000000',creationDeadline:3790500};
 client.feeFundingStatus=async()=>({address:monero,ready:false,reason:'reserved',height:'3789900',totalRaw:'227117000',availableRaw:'0',lockedRaw:'0',reservedRaw:'227117000',requiredRaw:'101000000'});
 client.operatorCreditPreparations=async()=>[{preparationId:'public-preparation',operationId:plan.id,quote:prepared.quote,claims:{issuance:'public-preparation'},completion:null}];
 client.recoverPreparedCarrier=async()=>({state:'not-signed',kind:'issuance'});
 client.prepareOperatorCredit=async()=>{note('prepare-new');throw Error('A new bridge must not start while XMR is reserved');};
 let cancelled=false;
 client.cancelOperatorCreditPreparation=async v=>{note('cancel',v);cancelled=true;return {evidence:{status:'cancelled'},released:['issuance']};};
 const reserved=client.feeFundingStatus,listed=client.operatorCreditPreparations;
 client.feeFundingStatus=async()=>cancelled?{address:monero,ready:true,reason:'ready',height:'3789900',totalRaw:'227117000',availableRaw:'227117000',lockedRaw:'0',requiredRaw:'101000000'}:reserved();
 client.operatorCreditPreparations=async()=>cancelled?(await listed()).map(r=>({...r,completion:{evidence:{status:'cancelled'},released:['issuance']}})):listed();
 bridge.status=async()=>({status:mode==='reserved-landed'?'finalized':'expired'});
}
// 'balance': read-only Monero balance check (sync to a ready checkpoint, then inventory).
// 'balance-empty': the same check for a wallet with no bridged tokens.
if(mode==='balance'||mode==='balance-empty'){client.sync=async()=>{note('sync');return {ready:true,height:'3790000',checkpoint:'33'.repeat(32)};};
 client.inventory=async()=>{note('inventory');return mode==='balance-empty'?[]:[{source:{txid:'44'.repeat(32),vout:1},quantity:'100000000000',held:false},{source:{txid:'55'.repeat(32),vout:0},quantity:'2500000',held:false}];};}
const api={publish:async v=>{note('publish',v);if(fixture.holdPublish)await new Promise(r=>{fixture.releasePublish=r;});return {status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10};},status:async()=>({status:'mempool',confirmed:false,confirmations:0,requiredConfirmations:10})};
const provider={kind:'phantom',publicKey:solana,assertCurrent(){},on(){},removeListener(){}};
// The website signer is replaced by a recorder: it must receive this wallet's plan.
const createSigner=({account})=>async({plan,proposal})=>{note('holder-sign',{account,owner:plan.request.owner,proposal:proposal.transaction});return {transaction:'PUBLIC HOLDER APPROVAL'};};
// 'held-lock': this page holds the engine's real exclusive lock, like a second xmr20.org tab would.
if(mode==='held-lock'){const name=await nativeWalletLockName({genesis:NATIVE_MARKET_CONFIGURATION.chainGenesis,address:monero});
 await new Promise(ready=>navigator.locks.request(name,{mode:'exclusive'},()=>{ready();return new Promise(r=>{fixture.releaseLock=r;});}));}
// 'holdings': the Monero tab rows from saved records; status reads are a public stub.
// 'unchecked' / 'checked-empty': a wallet never checked here, and one whose check found nothing.
// 'holdings-out' / 'holdings-sent': the same saved balance while a bridge to Solana or a send, started after it, confirms.
if(['holdings','holdings-out','holdings-sent','unchecked','checked-empty'].includes(mode)){localStorage.clear();
 if(mode!=='unchecked')saveNativeDisplay({address:monero,inventory:mode.startsWith('holdings')?[{source:{txid:'44'.repeat(32),vout:1},quantity:'7530668912636',held:false}]:[],checkpoint:{ready:true,height:'3790000',checkpoint:'33'.repeat(32)},now:Date.now()-180000});
 if(mode==='holdings')recordNativeBridge(monero,{preparationId:'public-preparation',amountRaw:'100000000000',stage:'sending',txid:'22'.repeat(32)});
 if(mode==='holdings-sent')recordNativeBridge(monero,{preparationId:'send:'+'88'.repeat(32),amountRaw:'1500000000',stage:'sending',txid:'88'.repeat(32),to:'address'});
 if(mode==='holdings-out')recordNativeBridge(monero,{preparationId:'solana:'+'66'.repeat(32),amountRaw:'250000000000',stage:'sending',txid:'66'.repeat(32),to:'solana'});
 createRoot(document.querySelector('#frame')).render(<section className="wallet-assets"><div className="wallet-assets-head"><h3>Tokens <span>Monero</span></h3></div>
  <NativeMoneroTokens address={monero} onCheck={()=>note('check')} onSend={()=>note('send')} onBridge={()=>note('bridge')} statusClient={{status:async({txid})=>{note('status',txid);return {status:'confirming',confirmations:6,requiredConfirmations:10,confirmed:false};}}}/></section>);
}
else createRoot(document.querySelector('#frame')).render(<>
 <div className="wallet-assets-head"><h3>Tokens</h3></div><div className="wallet-actions-row"><button className="wallet-primary">Open new bridge</button></div>
 <WebsiteNativeBridge mode={mode?.startsWith('balance')?'balance':['redeem','send'].includes(mode)?mode:'bridge'} owner={owner} provider={provider} moneroAddress={monero} token={{symbol:'EXTREMIST'}} onClose={()=>{fixture.closed++;}}
  createClient={({context})=>{note('client',context);return client;}} createSigner={createSigner}
  pageOptions={{bridge,api,readBalance:async({kind})=>{note('balance',kind);return '24113974003764';}}} redeemOptions={{bridge:redeemBridge,api:burnApi}} sendOptions={{api:sendApi}}/>
 <div className="wallet-asset-wrap"><article className="wallet-asset">$EXTREMIST 24,113,974.00</article></div>
</>);
Object.assign(fixture,{ready:true,owner,monero,ownerHex:[...solana.toBytes()].map(b=>b.toString(16).padStart(2,'0')).join('')});
