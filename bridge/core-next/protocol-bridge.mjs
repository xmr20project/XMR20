import {supportedMint} from './mint-policy.mjs';
import {multiTokenManifest} from './multi-token-config.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const actions=new Set(['readiness','prepare-deposit','submit-deposit','deposit-status','deposit-outcome','publish','snapshot','prepare-return','release','reconcile','retry-return']);
export function protocolRoute(path){
 if(path==='/api/joint-protocol/catalog')return {catalog:true};
 const m=typeof path==='string'&&path.match(/^\/api\/joint-protocol\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([a-z-]+)$/);
 return m&&supportedMint(m[1])&&actions.has(m[2])?{mint:m[1],action:m[2]}:null;
}
// Discovery is NEVER authorization. The host injects read-only verifiers for
// the finalized launch receipt and the confirmed canonical Monero declaration.
// No version-3 legacy escrow, manual mint allowlist, or old custody is required.
export async function verifyProtocolLaunch(row,{verifyMoneroLaunch,verifySolanaLaunch}){
 need(row&&supportedMint(row.mint)&&supportedMint(row.owner)&&row.network==='mainnet-beta'&&row.moneroNetwork==='mainnet'&&/^[a-f0-9]{64}$/.test(row.moneroTxid||'')&&/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(row.solanaSignature||'')&&typeof row.ticker==='string'&&row.ticker.length>0&&row.ticker.length<=64,'Confirmed XMR20 launch references required.');
 const [m,s]=await Promise.all([verifyMoneroLaunch(row),verifySolanaLaunch(row)]);
 need(m?.network==='mainnet'&&m.verified===true&&m.txid===row.moneroTxid&&m.mint===row.mint&&m.owner===row.owner&&m.ticker===row.ticker&&m.supply==='1000000000000000'&&Number.isSafeInteger(m.confirmations)&&m.confirmations>=10,'Canonical Monero launch proof required.');
 need(s?.finalized===true&&s.mint===row.mint&&s.creator===row.owner&&s.supply==='1000000000000000'&&[0,150].includes(s.transferTaxBps)&&s.mintAuthorityRevoked===true&&s.freezeAuthorityRevoked===true,'Finalized compatible Solana launch proof required.');
 return {mint:row.mint,moneroTxid:m.txid,solanaSignature:row.solanaSignature,confirmations:m.confirmations};
}
export function protocolCatalog(rows){
 need(Array.isArray(rows)&&rows.length<=10000,'Launch catalog is incomplete.');
 const seen=new Set(),tokens=[];for(const row of rows){if(!supportedMint(row?.mint)||seen.has(row.mint))continue;seen.add(row.mint);tokens.push({mint:row.mint,name:String(row.name||row.ticker||'Token').slice(0,120),symbol:String(row.ticker||row.symbol||'Token').slice(0,64)});}
 return {schema:'joint-protocol-catalog-v1',tokens,discoveryOnly:true};
}
// Each runtime uses the SAME immutable program but pins one mint and retains
// its own journals. The existing operator performs program/carrier/index proof
// checks. This factory never imports a signer or activates a service itself.
export function createProtocolBridge({launches,verifyMoneroLaunch,verifySolanaLaunch,openToken,maxActive=64}){
 need([launches,verifyMoneroLaunch,verifySolanaLaunch].every(f=>typeof f==='function')&&(openToken===undefined||typeof openToken==='function')&&Number.isSafeInteger(maxActive)&&maxActive>0,'Explicit protocol read transports required.');
 const active=new Map();let closed=false;
 async function call(path,input={}){
  need(!closed,'Protocol bridge is closed.');const route=protocolRoute(path);need(route,'Protocol bridge route unavailable.');
  if(route.catalog){need(input&&Object.keys(input).length===0,'Catalog has no wallet input.');return protocolCatalog(await launches());}
  const mint=route.mint,manifest=multiTokenManifest(mint);
  if(!openToken&&route.action==='readiness')return {schema:'joint-mainnet-readiness-v2',manifest,ready:false,requirements:[{code:'shared-deployment',description:'The shared bridge deployment and verified token service are not active yet.'}]};
  need(openToken,'Protocol bridge is not active.');
  const rows=await launches();need(Array.isArray(rows)&&rows.length<=10000,'Launch catalog is incomplete.');const matches=rows.filter(r=>r?.mint===mint);need(matches.length===1,'Exactly one XMR20 launch must match this token.');
  const row=structuredClone(matches[0]);await verifyProtocolLaunch(row,{verifyMoneroLaunch,verifySolanaLaunch});need(!closed,'Protocol bridge closed during verification.');
  let pending=active.get(mint);
  if(!pending){need(active.size<maxActive,'Active token capacity reached.');pending=Promise.resolve().then(()=>openToken({manifest,row})).then(operator=>{if(JSON.stringify(operator?.policy?.manifest)!==JSON.stringify(manifest)||typeof operator.call!=='function'||typeof operator.close!=='function'){operator?.close?.();throw Error('Token operator differs from the shared deployment.');}return operator;});active.set(mint,pending);pending.catch(()=>{if(active.get(mint)===pending)active.delete(mint);});}
  const operator=await pending;need(!closed,'Protocol bridge closed during startup.');
  return operator.call(route.action,input);
 }
 return {call,async close(){closed=true;await Promise.allSettled([...active.values()].map(p=>p.then(o=>o.close())));active.clear();}};
}
