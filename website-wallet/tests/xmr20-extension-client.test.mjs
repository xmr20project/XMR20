import test from 'node:test';import assert from 'node:assert/strict';
import {createXmr20ExtensionClient,XMR20_EXTENSION_ID} from '../src/xmr20-extension-client.js';
const account={id:'test',name:'Disposable account',solana:'11111111111111111111111111111111',monero:'public-test-address',canSign:true};
test('native connection exposes no Solana public key and cannot request Solana signing',async()=>{
 const native={id:'native',name:'Monero fixture',solana:null,monero:'4'+'1'.repeat(94),canSign:false,canSignMonero:true},calls=[];
 const client=createXmr20ExtensionClient({sleep:async()=>{},runtime:{async sendMessage(_id,m){calls.push(m.action);
  return {value:m.action==='connectMonero'?{requestId:'native'}:m.action==='result'?{done:true,value:{account:native}}:m.action==='status'?{account:native}:m.action==='ping'?{nativeMarket:true}:m.action==='openMarket'?{opened:true,account:native}:null};
 }}});
 assert.equal((await client.connectMonero()).address,native.monero);assert.equal(client.publicKey,null);
 assert.equal((await client.openMarket({view:'list'})).opened,true);
 await assert.rejects(client.signMessage(new TextEncoder().encode('anything')),/cannot sign Solana/);
 await assert.rejects(client.openBridge({}),/separately/);
 assert.equal(calls.some(a=>['signIn','openBridge','connect'].includes(a)),false);
});
function fixture(){const calls=[];let current=account,request='';const client=createXmr20ExtensionClient({sleep:async()=>{},runtime:{async sendMessage(id,m){assert.equal(id,XMR20_EXTENSION_ID);calls.push(m);if(m.action==='connect'||m.action==='openBridge'){request=m.action;return {value:{requestId:'test-request'}};}if(m.action==='result')return {value:{done:true,value:request==='connect'?{account}:{opened:true,account}}};if(m.action==='status')return {value:{account:current}};if(m.action==='ping')return {value:{jointBridge:true}};if(m.action==='disconnect')return {value:true};throw Error('unsupported');}}});return {client,calls,lock:()=>current=null};}
test('website connection and bridge launch exchange only public scope and request data',async()=>{const f=fixture();await f.client.connect();await f.client.openBridge({mint:'test-mint',amountRaw:'1000000',direction:'sol-to-xmr'});assert.equal(f.client.publicKey.toBase58(),account.solana);assert.deepEqual(f.calls.map(c=>c.action),['connect','result','status','ping','openBridge','result']);assert.ok(!JSON.stringify(f.calls).includes('privateKey'));await assert.rejects(f.client.signTransaction({}),/Arbitrary/);});
test('a locked or disconnected connection cannot launch a bridge',async()=>{const f=fixture();await f.client.connect();f.lock();await assert.rejects(f.client.openBridge({}),/locked/);assert.ok(!f.calls.some(c=>c.action==='openBridge'));await assert.rejects(f.client.checkCurrent(),/Reconnect/);});
test('market handoff requires extension support and exact returned account without signing',async()=>{
 for(const mode of ['ready','old-build','changed-solana','changed-monero','changed-id','locked']){
  const calls=[];let connectedAccount=account;
  const client=createXmr20ExtensionClient({sleep:async()=>{},runtime:{async sendMessage(id,m){
   calls.push(m);let value;
   if(m.action==='connect')value={requestId:'fixture'};
   else if(m.action==='result')value={done:true,value:{account}};
   else if(m.action==='status')value=connectedAccount?{account:connectedAccount}:null;
   else if(m.action==='ping')value={nativeMarket:mode!=='old-build'};
   else if(m.action==='openMarket'){
    if(mode==='locked')connectedAccount=null;
    value={opened:true,account:{...account,...(mode==='changed-solana'?{solana:'different'}:mode==='changed-monero'?{monero:'different'}:mode==='changed-id'?{id:'different'}:{})}};
   }else throw Error('Unexpected action');
   return {value};
  }}});
  await client.connect();assert.equal((await client.marketCapabilities()).walletMarket,mode!=='old-build');
  if(mode==='ready')assert.equal((await client.openMarket({view:'list'})).opened,true);
  else await assert.rejects(client.openMarket({view:'list'}));
  assert.equal(calls.some(m=>m.action==='signIn'||m.action==='marketKeys'),false);
  if(mode==='old-build')assert.equal(calls.some(m=>m.action==='openMarket'),false);
 }
});
