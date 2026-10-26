#!/usr/bin/env node
// CUTOVER SNAPSHOT from the bridge's Monero-side holder ledger (PUBLIC data, read-only).
// Production fact (26 Oct 2026): Monero-side XMR20 balances are kept per MONERO ADDRESS by the bridge's holder index and published
// at https://api.xmr20.org/api/xmr20/tokens/<id>/holders (schema xmr20-holders-v1, rows {address, amountRaw, network:'monero'}).
// The entitlement to migrate is therefore (mint, address, amount). The claim is signed under the address's PUBLIC SPEND KEY
// (decoded from the address) with the same plain Schnorr scheme the registry already verifies; nothing is spent on Monero and no
// key image is produced. One row per (mint, address); claim id = sha256 over the snapshot key, mint and address.
// Output: XMR20-CUTOVER-SNAPSHOT-2 (one file) + one registry snapshot per asset for the bridge service (registrySnapshots).
//   node migration/holders-snapshot.mjs --out <dir> [--api https://api.xmr20.org] [--mints m1,m2] [--tokens tokens.json --holders-dir dir]
// A LIVE run is a DRY RUN unless the ledger is frozen: the heights it records are the ledger's current reading, not a cutover.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {decodeMoneroAddress} from '../backend/monero-address.mjs';
import {PROFILE,digest} from '../../privacy-successor-20261021/model.mjs';
import {assetIdFor} from './snapshot-reconcile.mjs';
export const SNAPSHOT_FORMAT='XMR20-CUTOVER-SNAPSHOT-2';
const sha256=b=>createHash('sha256').update(b).digest('hex');
export function buildSnapshot({tokens,holdersByMint,mints=null,takenAt=new Date().toISOString(),source}){
 const rows=Array.isArray(tokens)?tokens:(tokens.tokens||[]);const assets=[];const problems=[];
 for(const t of rows){if(!t.mint||t.hidden||t.halted||t.cancelledAt)continue;if(mints&&!mints.includes(t.mint))continue;
  const h=holdersByMint[t.mint];if(!h){if(String(t.xmrOutstanding||'0')!=='0')problems.push({mint:t.mint,problem:'holders missing for a token with Monero-side outstanding balance'});continue;}
  if(h.schema!=='xmr20-holders-v1'||h.mint!==t.mint||h.moneroNetwork!=='mainnet')throw Error('holders document shape for '+t.mint);
  const monero=(h.holders||[]).filter(x=>x.network==='monero');const total=monero.reduce((n,x)=>n+BigInt(x.amountRaw),0n);
  if(String(total)!==String(h.moneroRaw))problems.push({mint:t.mint,problem:`holder sum ${total} differs from moneroRaw ${h.moneroRaw}`});
  if(String(h.moneroRaw)!==String(t.xmrOutstanding??h.moneroRaw))problems.push({mint:t.mint,problem:`moneroRaw ${h.moneroRaw} differs from the tokens API xmrOutstanding ${t.xmrOutstanding}`});
  if(total===0n)continue;
  const symbol=(t.ticker||t.symbol||'').toUpperCase()||t.mint.slice(0,6);const key=`${SNAPSHOT_FORMAT}:${t.mint}:${h.moneroHeight}:${h.checkedAt}`;
  const seen=new Set();const assetRows=[];
  for(const x of monero){const a=decodeMoneroAddress(x.address);if(a.network!=='mainnet')throw Error('non-mainnet holder address');if(seen.has(x.address))throw Error('duplicate holder address '+x.address);seen.add(x.address);
   if(!/^\d+$/.test(String(x.amountRaw))||BigInt(x.amountRaw)<=0n)throw Error('holder amount');
   assetRows.push({claim:digest({domain:PROFILE+':claim',legacyManifest:key,lot:t.mint+':'+x.address}),amount:String(x.amountRaw),legacyOwner:a.spendPublicKey,address:x.address,addressKind:a.kind,mint:t.mint,lastIncoming:x.lastIncoming??null});}
  assetRows.sort((p,q)=>p.claim.localeCompare(q.claim));
  assets.push({profile:PROFILE,format:SNAPSHOT_FORMAT,kind:'address-based entitlements from the bridge holder ledger (xmr20-holders-v1)',asset:symbol,symbol,name:t.name||symbol,mint:t.mint,assetId:assetIdFor(t.mint),decimals:h.decimals??6,network:'mainnet',
   source:{url:source?.holdersUrl?.(t.id)||null,tokenId:t.id,state:h.state,checkedAt:h.checkedAt,moneroHeight:h.moneroHeight,moneroConfirmations:h.moneroConfirmations,moneroRaw:String(h.moneroRaw),escrowAddress:h.escrowAddress||null},
   checkpoint:{height:h.moneroHeight,ledgerCheckedAt:h.checkedAt,note:'ledger reading at export; a real cutover requires the bridge to stop crediting this ledger before export'},
   total:String(total),holders:assetRows.length,rows:assetRows});}
 assets.sort((p,q)=>p.mint<q.mint?-1:1);
 const snapshot={format:SNAPSHOT_FORMAT,takenAt,source:source?{api:source.api,tokensSha256:source.tokensSha256,holdersSha256:source.holdersSha256}:null,summary:{assets:assets.length,holders:assets.reduce((n,a)=>n+a.holders,0),totalRaw:assets.reduce((n,a)=>n+BigInt(a.total),0n).toString(),problems:problems.length},problems,assets};
 snapshot.digest=sha256(JSON.stringify({assets:assets.map(a=>({mint:a.mint,rows:a.rows.map(r=>[r.claim,r.amount,r.legacyOwner,r.address]),checkpoint:a.checkpoint,total:a.total}))}));
 return snapshot;}
export async function fetchLive(api='https://api.xmr20.org',{mints=null,fetchImpl=globalThis.fetch}={}){
 const get=async u=>{const r=await fetchImpl(u,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('HTTP '+r.status+' '+u);const text=await r.text();return {json:JSON.parse(text),sha256:sha256(text)};};
 const tokens=await get(api+'/api/xmr20/tokens');const list=Array.isArray(tokens.json)?tokens.json:(tokens.json.tokens||[]);
 const holdersByMint={};const holdersSha256={};
 for(const t of list){if(!t.mint||t.hidden||t.halted||t.cancelledAt)continue;if(mints?!mints.includes(t.mint):String(t.xmrOutstanding||'0')==='0')continue;
  const h=await get(`${api}/api/xmr20/tokens/${t.id}/holders`);holdersByMint[t.mint]=h.json;holdersSha256[t.mint]=h.sha256;}
 return {tokens:list,holdersByMint,source:{api,tokensSha256:tokens.sha256,holdersSha256,holdersUrl:id=>`${api}/api/xmr20/tokens/${id}/holders`}};}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const argv=process.argv.slice(2);const flag=k=>{const i=argv.indexOf('--'+k);if(i<0)return null;return argv[i+1];};
 const out=flag('out');if(!out)throw Error('--out <dir> required');const mints=flag('mints')?flag('mints').split(','):null;
 let input;if(flag('tokens')){const tokens=JSON.parse(await readFile(flag('tokens'),'utf8'));const dir=flag('holders-dir');const holdersByMint={};const list=Array.isArray(tokens)?tokens:tokens.tokens;for(const t of list){try{holdersByMint[t.mint]=JSON.parse(await readFile(path.join(dir,t.mint+'.json'),'utf8'));}catch{}}input={tokens:list,holdersByMint,source:{api:'fixture:'+flag('tokens'),tokensSha256:null,holdersSha256:null}};}
 else input=await fetchLive(flag('api')||'https://api.xmr20.org',{mints});
 const snapshot=buildSnapshot({...input,mints});await mkdir(out,{recursive:true});
 await writeFile(path.join(out,'cutover-snapshot.json'),JSON.stringify(snapshot,null,1)+'\n');
 const registries={};for(const a of snapshot.assets){registries[a.symbol]=a;await writeFile(path.join(out,`registry-${a.symbol}.json`),JSON.stringify(a,null,1)+'\n');}
 // raw inputs for reproducibility (public data)
 if(!flag('tokens')){await mkdir(path.join(out,'raw'),{recursive:true});await writeFile(path.join(out,'raw','tokens.json'),JSON.stringify(input.tokens));for(const [m,h] of Object.entries(input.holdersByMint))await writeFile(path.join(out,'raw',m+'.json'),JSON.stringify(h));}
 console.log(JSON.stringify({out,digest:snapshot.digest,summary:snapshot.summary,assets:snapshot.assets.map(a=>({symbol:a.symbol,mint:a.mint,holders:a.holders,total:a.total,height:a.checkpoint.height})),problems:snapshot.problems}));
}
