// Read-only projection. Publish only receipts for already-submitted Monero records.
// Never expose drafts, recovery data, signatures, signing messages or owner accounts.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const raw=n=>typeof n==='string'&&/^[1-9][0-9]{0,15}$/.test(n)&&BigInt(n)<=1000000000000000n;
export function createPendingIndex({store,validateAddress,moneroNetwork='mainnet',solanaNetwork='mainnet-beta',now=Date.now}){
 return {read(address){
  const check=validateAddress(address,'mainnet');if(moneroNetwork!=='mainnet'||solanaNetwork!=='mainnet-beta'||!check?.valid||check.kind!=='standard')throw Error('Use a primary Monero mainnet address.');
  const checkedAt=now(),rows=[],seen=new Set();let complete=true;
  function add(t,operation,destination,txid,amountRaw){
   if(destination!==address)return;
   const launch=store.get('launch',t.launchId);
   if(!launch||launch.halted||launch.cancelledAt||launch.hidden||launch.publicIndexExcluded===true||!launch.proofVerified||!launch.solanaFinalized||!Number.isSafeInteger(launch.confirmations)||launch.confirmations<10)return;
   if(!UUID.test(t.id)||!UUID.test(t.launchId)||!MINT.test(launch.mint)||!HASH.test(launch.moneroTxid)||!HASH.test(txid)||!raw(amountRaw)||!Number.isSafeInteger(t.confirmations)||t.confirmations<0||t.confirmations>10000000||!Number.isSafeInteger(t.updatedAt)||t.updatedAt<=0||t.updatedAt>checkedAt+60000||typeof launch.ticker!=='string'||! /^[A-Z][A-Z0-9]{0,9}$/.test(launch.ticker)||typeof launch.name!=='string'||!launch.name.length||launch.name.length>256){complete=false;return;}
   if(seen.has(txid)){complete=false;return;}seen.add(txid);
   rows.push({id:t.id,launchId:t.launchId,address,network:'monero',operation,mint:launch.mint,deployment:launch.moneroTxid,name:launch.name,ticker:launch.ticker,amountRaw,txid,confirmations:t.confirmations,state:t.confirmations<10?'confirming':'validating',checkedAt:t.updatedAt});
  }
  for(const t of store.list('moneroTransfer'))if(t.state==='pending'&&typeof t.signature==='string'&&/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(t.signature)&&HASH.test(t.txid||''))add(t,'transfer',t.recipient,t.txid,t.amountRaw);
  for(const t of store.list('transfer'))if(t.direction==='sol-to-xmr'&&t.state==='destination_pending'&&typeof t.sourceSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(t.sourceSignature)&&HASH.test(t.destinationTxid||'')&&raw(t.creditRaw))add(t,'credit',t.moneroAddress,t.destinationTxid,t.creditRaw);
  rows.sort((a,b)=>a.id.localeCompare(b.id));if(rows.length>1000)complete=false;
  return {schema:'xmr20-wallet-pending-v1',address,network:'monero',moneroNetwork,solanaNetwork,checkedAt,complete,rows:rows.slice(0,1000)};
 }};
}
