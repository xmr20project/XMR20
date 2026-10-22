// Patch a staged copy only. The live wallet chat owns the ordinary worker and
// app; every expected seam must still match before this adapter can be built.
export function patchMarketOrdinaryWorker(source) {
  const marker = '/* XMR20 shared native spend guard v2 */';
  if (source.includes(marker)) return source;
  if (source.includes('/* XMR20 shared native spend guard v1 */')) throw Error('Restage the ordinary worker from the current installed baseline before updating spend protection');
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw Error('Ordinary worker changed; review market integration at: ' + from.slice(0, 70));
    source = source.replace(from, to);
  };
  replace("'use strict';", "'use strict';\n" + marker + `
let spendGuard=null;
async function savedPaymentRead(data){
 if(!wallet||!spendGuard)throw Error('Open this wallet first');
 if(data.action==='paymentRecoveryStatus')return spendGuard.recoveryStatus();
 if(! /^[a-f0-9]{64}$/.test(data.txid))throw Error('Exact saved payment required');
 const target=await health(data.node);
 const response=await self.fetch(data.node+'/gettransactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[data.txid],decode_as_json:false,prune:false})});
 if(!response.ok)throw Error('Payment status unavailable');const body=await response.text();
 if(body.length>2*1024*1024)throw Error('Payment status exceeds bound');
 return spendGuard.paymentStatus(data.txid,JSON.parse(body),target);
}`);
  // These reads neither touch wallet2 nor alter a review. They may run while a
  // companion scan is downloading blocks; mutations still obey the busy gate.
  replace("if(busy){post({id:data.id,error:'Wallet is busy syncing.'});return;}", `if(busy){
  if(currentAction==='sync'&&['paymentRecoveryStatus','checkPayment'].includes(data.action)){
   try{post({id:data.id,result:await savedPaymentRead(data)});}catch{post({id:data.id,error:'Could not check this payment. Your saved transaction is kept; try again.'});}return;
  }
  post({id:data.id,error:'Wallet is busy syncing.'});return;
 }`);
  replace("importScripts('./native-carrier-guard.js');", "importScripts('./market-ordinary-guard.js');\n importScripts('./native-carrier-guard.js');");
  replace("if(await wallet.getPrimaryAddress()!==data.address||await wallet.isViewOnly())throw Error('Recovery phrase does not match the linked wallet');",
    "if(await wallet.getPrimaryAddress()!==data.address||await wallet.isViewOnly())throw Error('Recovery phrase does not match the linked wallet');\n   spendGuard=await self.XMR20OrdinarySpendGuard.create(wallet);");
  replace('return new Set(result.protected);', "if(!spendGuard)throw Error('Shared spend protection unavailable');\n return new Set([...result.protected,...await spendGuard.freeze(result.protected)]);");
  replace("}else if(data.action==='relay'){", `}else if(data.action==='paymentRecoveryStatus'){
   result=await savedPaymentRead(data);
  }else if(data.action==='checkPayment'){
   result=await savedPaymentRead(data);
  }else if(data.action==='exportPaymentRecovery'){
   if(!wallet||!spendGuard)throw Error('Open this wallet first');result={packageBytes:await spendGuard.exportRecovery()};
  }else if(data.action==='importPaymentRecovery'){
   pending=null;if(!wallet||!spendGuard)throw Error('Open this wallet first');
   result=await spendGuard.importRecovery(data.packageBytes);
  }else if(data.action==='prepareRecovery'){
   pending=null;if(!wallet||!spendGuard)throw Error('Open this wallet first');await health(data.node);
   const saved=await spendGuard.reviewRecovery(data.txid),id=crypto.randomUUID();
   pending={...saved,id,recovery:true,node:data.node,expires:Date.now()+120000};
   result={id,to:saved.to,amountRaw:saved.amountRaw,feeRaw:saved.feeRaw,hash:saved.hash,expires:pending.expires,recovery:true};
  }else if(data.action==='relay'){`);
  replace('await snapshot(approved.node);checkInputs(approved.tx,approved.protectedImages);', `if(approved.recovery){
    await health(approved.node);
    relayStage='saving';result=await spendGuard.relayRecovery(approved.hash,async(transaction,hash)=>{
     relayStage='submitting';
     canRelay=true;try{
      const r=await self.fetch(approved.node+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:transaction,do_not_relay:false})});
      if(!r.ok)throw Error('Saved payment submission uncertain');const value=await r.json();
      if(value.status!=='OK'||value.untrusted===true)throw Error('Saved payment submission uncertain');return {hash};
     }finally{canRelay=false;}
    });post({id:data.id,result});return;
   }
   await snapshot(approved.node);checkInputs(approved.tx,approved.protectedImages);`);
  replace("const tx=approved.tx;relayStage='submitting';canRelay=true;\n   try{result={hash:await wallet.relayTx(tx)};}finally{canRelay=false;}",
    `const tx=approved.tx;relayStage='saving';
   result=await spendGuard.relay(tx,approved,async(transaction,hash)=>{
    relayStage='submitting';canRelay=true;try{
     const response=await self.fetch(approved.node+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:transaction,do_not_relay:false})});
     if(!response.ok)throw Error('Payment submission uncertain');const value=await response.json();
     if(value.status!=='OK'||value.untrusted===true)throw Error('Payment submission uncertain');return {hash};
    }finally{canRelay=false;}
   });`);
  replace("if(wallet)await wallet.close(false);wallet=null;result={locked:true};", "spendGuard?.close();spendGuard=null;if(wallet)await wallet.close(false);wallet=null;result={locked:true};");
  replace("if(data.action==='open'&&wallet){", "if(data.action==='open'){spendGuard?.close();spendGuard=null;}\n  if(data.action==='open'&&wallet){");
  return source;
}
