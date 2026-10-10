/* Pinned monero-ts full wallet. Keys remain in this worker; no persistence.
 * Transactions are constructed without relay, then relayed only by an explicit approval.
 */
'use strict';
const NODES=['https://xmr-node.cakewallet.com:18081','https://node.sethforprivacy.com'];
const post=self.postMessage.bind(self),netFetch=self.fetch.bind(self);
let wallet=null,loaded=false,busy=false,currentId=null,lastProgress=0,pending=null,canRelay=false;
for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
const readPaths=new Set(['/send_raw_transaction','/sendrawtransaction','/get_info','/get_height','/getblocks.bin','/gethashes.bin','/gettransactions','/get_o_indexes.bin','/get_outs.bin','/is_key_image_spent','/json_rpc']);
// Both fetch and XHR are guarded because the pinned library uses Axios.
function readRequest(input,body){
 const url=new URL(input);
 if(!NODES.includes(url.origin)||url.search||url.username||url.password||!readPaths.has(url.pathname))throw Error('Node request blocked');
 if(['/sendrawtransaction','/send_raw_transaction'].includes(url.pathname)&&!canRelay)throw Error('Relay requires approval');
 if(url.pathname==='/json_rpc'&&body){const p=JSON.parse(body);if(!['get_version','get_info','get_fee_estimate','get_block_header_by_height','get_block_header_by_hash','get_last_block_header','get_block_headers_range','get_block_count','get_output_distribution','get_output_histogram','get_height'].includes(p.method))throw Error('Node request blocked');}
}
self.fetch=(input,opts={})=>{try{readRequest(typeof input==='string'?input:input.url,opts.body);if(opts.method&&!['GET','POST'].includes(opts.method.toUpperCase()))throw Error();}catch{return Promise.reject(Error('Node request blocked'));}return netFetch(input,{...opts,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});};
const BrowserXHR=self.XMLHttpRequest;
self.XMLHttpRequest=class extends BrowserXHR{
 open(method,url,...rest){if(!['GET','POST'].includes(method.toUpperCase()))throw Error('Node request blocked');readRequest(url);this.nodeUrl=url;return super.open(method,url,...rest);}
 send(body){readRequest(this.nodeUrl,body);this.withCredentials=false;this.timeout=30000;return super.send(body);}
};
async function health(node){
 if(!NODES.includes(node))throw Error('Invalid node');
 const response=await self.fetch(node+'/get_info');if(!response.ok)throw Error('Node unavailable');const data=await response.json();
 if(data.status!=='OK'||data.mainnet!==true||data.nettype!=='mainnet'||!Number.isSafeInteger(data.height)||data.height<=0||data.offline===true||data.synchronized===false)throw Error('Mainnet node is not synced');
 return data.height;
}
async function init(){
 if(loaded)return;
 importScripts('./monero-full-0.11.16.js');
 // Replace the library's general-purpose RPC dispatcher synchronously.
 self.onmessage=handle;
 self.postMessage=message=>{if(Array.isArray(message)&&message[1]==='onSyncProgress_balance'&&Date.now()-lastProgress>500){lastProgress=Date.now();post({id:currentId,progress:{height:message[2],target:message[4]}});}};
 await self.initOneTime();loaded=true;
}
async function snapshot(node){
 const target=await health(node),height=await wallet.getHeight();
 if(height<target-2)throw Error('Wallet sync incomplete');
 return {address:await wallet.getPrimaryAddress(),balanceRaw:String(await wallet.getBalance()),unlockedRaw:String(await wallet.getUnlockedBalance()),height,target,node,updatedAt:Date.now(),network:'mainnet',synced:true};
}
async function handle({data}){
 if(!data||typeof data.id!=='string')return;
 if(busy){post({id:data.id,error:'Wallet is busy syncing.'});return;}
 busy=true;currentId=data.id;
 try{
  let result;
  if(data.action==='open'){
   if(wallet)throw Error('Wallet already unlocked');
   if(typeof data.seed!=='string'||data.seed.trim().split(/\s+/).length!==25||typeof data.address!=='string'||data.address.length!==95||!Number.isSafeInteger(data.restoreHeight)||data.restoreHeight<0)throw Error('Invalid wallet');
   const target=await health(data.node);if(data.restoreHeight>target)throw Error('Invalid restore height');
   await init();
   await self.createWalletFull('native',{networkType:0,seed:data.seed,restoreHeight:data.restoreHeight,password:'',server:{uri:data.node,rejectUnauthorized:true},isTrustedDaemon:false,proxyToWorker:false});
   data.seed='';wallet=self.WORKER_OBJECTS.native;
   if(await wallet.getPrimaryAddress()!==data.address||await wallet.isViewOnly())throw Error('Recovery phrase does not match the linked wallet');
   await self.addListener('native','balance');
   result={address:data.address,node:data.node,target,unlocked:true};
  }else if(data.action==='sync'){
   if(!wallet)throw Error('Unlock first');
   await health(data.node);await wallet.setDaemonConnection({uri:data.node,rejectUnauthorized:true},false);
   post({id:data.id,progress:{phase:'syncing'}});
   await wallet.sync();result=await snapshot(data.node);
  }else if(data.action==='prepareMax'){
   if(!wallet||!/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(data.to)||data.to===await wallet.getPrimaryAddress())throw Error('Invalid transfer');
   await snapshot(data.node);pending=null;
   const txs=await wallet.sweepUnlocked({accountIndex:0,address:data.to,relay:false});
   // Keep the existing single-transaction review/receipt contract. Never relay
   // or partially send a multi-transaction sweep from an amount shortcut.
   if(txs.length!==1)throw Error('Max needs a single transaction');
   const tx=txs[0],destinations=tx.getOutgoingTransfer().getDestinations(),amountRaw=String(tx.getOutgoingAmount()),feeRaw=String(tx.getFee()),hash=tx.getHash();
   if(destinations.length!==1||destinations[0].getAddress()!==data.to||String(destinations[0].getAmount())!==amountRaw||tx.getIsRelayed()||! /^[1-9][0-9]{0,19}$/.test(amountRaw)||! /^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Transfer mismatch');
   const id=crypto.randomUUID();pending={id,tx,to:data.to,amountRaw,expires:Date.now()+120000};
   result={id,to:data.to,amountRaw,feeRaw,hash,expires:pending.expires};
  }else if(data.action==='prepare'){
   if(!wallet||!/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(data.to)||! /^[1-9][0-9]{0,19}$/.test(data.amountRaw))throw Error('Invalid transfer');
   if(data.to===await wallet.getPrimaryAddress())throw Error('Same address');
   await snapshot(data.node);
   pending=null;
   const tx=await wallet.createTx({accountIndex:0,address:data.to,amount:BigInt(data.amountRaw),relay:false});
   const transfer=tx.getOutgoingTransfer(),destinations=transfer.getDestinations();
   if(destinations.length!==1||destinations[0].getAddress()!==data.to||String(destinations[0].getAmount())!==data.amountRaw||tx.getIsRelayed())throw Error('Transfer mismatch');
   const feeRaw=String(tx.getFee()),hash=tx.getHash();
   if(!/^[0-9]+$/.test(feeRaw)||! /^[a-f0-9]{64}$/.test(hash))throw Error('Invalid transaction');
   const id=crypto.randomUUID();pending={id,tx,to:data.to,amountRaw:data.amountRaw,expires:Date.now()+120000};
   result={id,to:data.to,amountRaw:data.amountRaw,feeRaw,hash,expires:pending.expires};
  }else if(data.action==='relay'){
   if(!pending||pending.id!==data.reviewId||Date.now()>pending.expires)throw Error('Review expired');
   const tx=pending.tx;pending=null;canRelay=true;
   try{result={hash:await wallet.relayTx(tx)};}finally{canRelay=false;}
  }else if(data.action==='cancel'){
   pending=null;result={cancelled:true};
  }else if(data.action==='close'){
   if(wallet)await wallet.close(false);wallet=null;result={locked:true};
  }else throw Error('Unsupported wallet operation');
  post({id:data.id,result});
 }catch{
  if(data.action==='open'&&wallet){try{await wallet.close(false);}catch{}wallet=null;}
  data.seed='';
  post({id:data.id,error:data.action==='open'?'Could not unlock this Monero wallet. Check the phrase, restore height and node connection.':data.action==='prepareMax'?'Could not calculate Max for one XMR transaction. Sync your wallet and try a smaller amount. Nothing was sent.':data.action==='sync'?'Monero sync could not finish. Your balance is unavailable; retry or switch nodes.':'Monero transaction could not complete. Check the saved receipt before retrying.'});
 }finally{busy=false;}
}
self.onmessage=handle;
