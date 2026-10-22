import {Buffer} from 'buffer';
import {createMarketFetch,MARKET_ORIGIN} from './market-policy.js';
import {createExtensionMarketHost} from './market-wallet-host.js';
import {prepareMarketPage} from '../services/native-market/wallet-market-entry.mjs';
import {createListingClient} from '../services/native-market/listing-client.mjs';
import {moneroWalletIdentity} from '../services/native-market/wallet/identity.mjs';
import {createNativeSendPage} from './native-send-page.js';
import {createNativeRedemptionPage} from './native-redemption-page.js';
import {createNativeConversionPage} from './native-conversion-page.js';
import './native-send-page.css';
import {nativeTokenMetadata} from './native-token-holdings.js';
import {createTokenImageClient,tokenImage} from './token-display.js';
import {createPriceClient} from './prices.js';

globalThis.Buffer=Buffer;
// This packaged surface talks only to the fixed market service. Its worker has
// a separate fixed transport; no website scripts execute in either context.
const publicFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=createMarketFetch({fetchImpl:publicFetch});
const requestId=new URLSearchParams(location.search).get('request');
const status=document.createElement('div');status.className='connection-error';status.id='wallet-market-error';status.setAttribute('role','alert');status.hidden=true;
document.querySelector('.account-toolbar').after(status);
let host,page,client,sendPage;
const showError=text=>{
 if(!status.isConnected)(document.getElementById('native-send')||document.body).prepend(status);
 status.textContent=text;status.hidden=false;
};
function close(){sendPage?.close();client?.dispose();host?.close();page?.setWallet(null);}
window.addEventListener('pagehide',close,{once:true});
try{
 host=createExtensionMarketHost({requestId});
 const opened=await host.open();client=opened.client;
 if(['send','redeem','convert'].includes(opened.market.view)){
  const capability=await client.capabilities();if(!capability.available)throw Error(capability.reason);
  const metadata=nativeTokenMetadata();
  sendPage=(opened.market.view==='convert'?createNativeConversionPage:opened.market.view==='redeem'?createNativeRedemptionPage:createNativeSendPage)({client,account:opened.account,signCustody:opened.signCustody,assertCurrent:opened.assertCurrent,token:metadata??undefined});
  if(metadata){
   const images=createTokenImageClient({fetcher:publicFetch});
   const prices=createPriceClient({fetcher:publicFetch,onMetadata:rows=>void images.load(rows).then(()=>sendPage?.setTokenImage(tokenImage(metadata.mint)))});
   void prices.load([metadata.mint]).catch(()=>{});
  }
  await sendPage.open();
 }else{
 page=prepareMarketPage({serviceOrigin:MARKET_ORIGIN,initialMarket:opened.market});
 const capabilities=await client.capabilities();
 const {account,assertCurrent}=opened;
 const balance=document.createElement('p');balance.id='account-balance';balance.textContent='XMR20 Wallet · '+account.name+' · '+account.monero.slice(0,7)+'…'+account.monero.slice(-6);balance.title=account.monero;
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Refresh';
 refresh.addEventListener('click',async()=>{refresh.disabled=true;try{await host.check();await page.refresh();}catch{close();showError('Your wallet was locked or changed. Close this window and reconnect from the website.');}finally{refresh.disabled=false;}});
 document.querySelector('.account-toolbar').append(balance,refresh);
 // Preserve existing public recovery references; new Monero-only accounts need
 // no Solana identity. Private signing scope is always native address + genesis.
 const recoveryOwner=account.solana||moneroWalletIdentity(account.monero);
 const api=createListingClient({scope:recoveryOwner+':'+account.monero,assertCurrent});
 page.setWallet({client,api,owner:recoveryOwner,address:account.monero,assertCurrent,capabilities});
 }
 const timer=setInterval(()=>{void host.check().catch(()=>{clearInterval(timer);close();showError('Your wallet was locked or changed. Close this window and reconnect from the website.');});},2000);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}catch{close();showError('This window could not connect to your selected wallet. Close it and reopen from XMR20 Wallet or the market.');}
