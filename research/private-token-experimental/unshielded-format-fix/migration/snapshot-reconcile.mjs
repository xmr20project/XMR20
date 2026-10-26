#!/usr/bin/env node
// Reproducible PUBLIC-DATA snapshot and reconciliation for every XMR20-launched token, as preparation for the legacy -> private
// migration. Reads only public sources (the public tokens API as recorded or fetched read-only, the catalog with its on-chain
// decimals checks) and never any holder secret. For each mint it records identity (mint address, decimals and their source,
// inscription/bridge versions, chain labels), fee policy (Token-2022 transfer-fee bps), supply figures (supply, lockedRaw,
// xmrOutstanding) and derives the MIGRATION ENVELOPE: the Monero-side outstanding amount, which is the upper bound of all private
// entitlements that may ever be credited for that mint. Checks: supply >= lockedRaw >= xmrOutstanding (bridge backing order),
// decimals present and verified, mint unique, asset id derivation stable. The snapshot digest is the sha256 of the canonical rows
// plus the source digests, so two runs over the same inputs produce the same digest and a changed source changes it.
// WHAT PUBLIC DATA CANNOT GIVE: per-holder lots (who may claim how much). Those require replaying the legacy inscription records
// from a Monero MAINNET node at the chosen cutoff height through the isolated cutover indexer (legacy/cutover-indexer.mjs in the
// stagenet-roles lab). That replay, and the cutoff height itself, are recorded here as open dependencies, not performed.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));const root=path.resolve(here,'..');
const sha256=b=>createHash('sha256').update(b).digest('hex');
const canon=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x);
const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const assetIdFor=(mint)=>'uxmr20private'+mint.toLowerCase();   // the backend's rule: one asset id per mint, nothing per symbol

export function reconcile({api,catalog,apiSource,catalogSource}){
 const tokens=Array.isArray(api)?api:(api.tokens||[]);
 const byMint=new Map();for(const t of tokens)if(t.mint)byMint.set(t.mint,t);
 const rows=[];const problems=[];const seen=new Set();
 for(const c of catalog.assets){
  const mint=c.mint;const key=c.key||c.symbol;const t=byMint.get(mint)||null;
  const row={key,symbol:c.symbol,name:c.name,mint,assetId:assetIdFor(mint),decimals:c.decimals??null,decimalsSource:c.decimalsVerified?{onChain:c.decimalsVerified.onChain,rpc:c.decimalsVerified.rpc,checkedAt:c.decimalsVerified.checkedAt}:(c.decimalsSource||null),
   transferTaxBps:c.transferTaxBps??t?.transferTaxBps??null,inscriptionVersion:c.inscriptionVersion??t?.inscriptionVersion??null,bridgeVersion:c.bridgeVersion??t?.bridgeVersion??null,
   moneroTxid:c.moneroTxid||t?.moneroTxid||null,solanaNetworkLabel:c.solanaNetworkLabel||t?.network||null,moneroNetworkLabel:t?.moneroNetwork||null,bridgeProgramId:c.bridgeProgramId||t?.bridgeProgramId||null,
   api:t?{state:t.state,supply:t.supply??null,lockedRaw:t.lockedRaw??null,xmrOutstanding:t.xmrOutstanding??null,confirmations:t.confirmations??null,bridgeReady:t.bridgeReady??null}:null,
   checks:{},envelope:null};
  const fail=(k,msg)=>{row.checks[k]=false;problems.push({mint,key,check:k,message:msg});};const pass=k=>{row.checks[k]=true;};
  if(!BASE58.test(mint))fail('mintFormat','mint is not a base58 Solana address');else pass('mintFormat');
  if(seen.has(mint))fail('mintUnique','duplicate mint in the catalog');else{seen.add(mint);pass('mintUnique');}
  if(!Number.isInteger(row.decimals)||row.decimals<0||row.decimals>18)fail('decimals','decimals missing or out of range');else pass('decimals');
  if(c.decimalsVerified&&c.decimalsVerified.onChain!==c.decimals)fail('decimalsVerified','recorded on-chain decimals differ from the catalog value');else if(c.decimalsVerified)pass('decimalsVerified');else fail('decimalsVerified','no on-chain decimals check recorded');
  if(![0,150,200].includes(row.transferTaxBps))fail('feePolicyKnown','transfer-fee bps outside the documented variants (0, 150, 200)');else pass('feePolicyKnown');
  if(!t)fail('inPublicApi','mint absent from the public tokens API snapshot');else{pass('inPublicApi');
   const big=v=>(v===null||v===undefined||!/^\d+$/.test(String(v)))?null:BigInt(v);const supply=big(t.supply),locked=big(t.lockedRaw),out=big(t.xmrOutstanding);
   if(supply===null)fail('supplyPresent','supply missing');else pass('supplyPresent');
   if(locked===null||out===null)fail('outstandingPresent','lockedRaw/xmrOutstanding missing from the public row: the migration envelope cannot be derived from public data for this mint');
   else{pass('outstandingPresent');if(!(supply>=locked&&locked>=out))fail('backingOrder',`supply ${supply} >= lockedRaw ${locked} >= xmrOutstanding ${out} violated`);else pass('backingOrder');row.envelope={moneroOutstandingRaw:out.toString(),units:row.decimals!==null?(Number(out)/10**row.decimals).toString():null,meaning:'upper bound of all private entitlements for this mint (sum of legacy lots at the cutoff must not exceed it)'};}
  }
  rows.push(row);
 }
 rows.sort((a,b)=>a.mint<b.mint?-1:1);
 const summary={mints:rows.length,withEnvelope:rows.filter(r=>r.envelope).length,withoutEnvelope:rows.filter(r=>!r.envelope).map(r=>r.key),allChecksPassed:rows.filter(r=>Object.values(r.checks).every(Boolean)).length,problems:problems.length,
  byFee:Object.fromEntries([0,150,200].map(b=>[b,rows.filter(r=>r.transferTaxBps===b).length])),byInscriptionVersion:Object.fromEntries([...new Set(rows.map(r=>String(r.inscriptionVersion)))].map(v=>[v,rows.filter(r=>String(r.inscriptionVersion)===v).length]))};
 const sources={api:apiSource,catalog:catalogSource};
 const digest=sha256(canon({rows,sources:{api:apiSource.sha256,catalog:catalogSource.sha256}}));
 return {format:'XMR20-MIGRATION-SNAPSHOT-1',kind:'public-data reconciliation (totals and identities); NOT a per-holder cutoff snapshot',at:new Date().toISOString(),sources,summary,rows,problems,digest,
  dependencies:['per-holder lots: replay of the legacy inscription records from a Monero MAINNET node at the cutoff height through the isolated cutover indexer (not performed; no mainnet node in this candidate)','cutoff height: owner decision (not chosen)','live Solana reads (mint supply, vault balance, withheld fees) for a fresh reconciliation: public RPC, read-only, opt-in --live-solana (not performed here)']};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
 const argv=process.argv.slice(2);const flag=k=>{const i=argv.indexOf('--'+k);if(i<0)return null;const v=argv[i+1];argv.splice(i,2);return v;};
 const apiPath=flag('api')||path.join(root,'runs/xmr20-tokens-api-raw.json');const catalogPath=flag('catalog')||path.join(here,'third-party-assets.json');const out=flag('out')||path.join(root,'runs/migration-snapshot-'+new Date().toISOString().slice(0,10)+'.json');
 const apiBytes=await readFile(apiPath),catBytes=await readFile(catalogPath);
 const r=reconcile({api:JSON.parse(apiBytes),catalog:JSON.parse(catBytes),apiSource:{path:path.relative(root,apiPath),sha256:sha256(apiBytes),note:'public tokens API as recorded (read-only)'},catalogSource:{path:path.relative(root,catalogPath),sha256:sha256(catBytes)}});
 await mkdir(path.dirname(out),{recursive:true});await writeFile(out,JSON.stringify(r,null,1)+'\n');await writeFile(out+'.sha256',r.digest+'  '+path.basename(out)+'\n');
 console.log(JSON.stringify({out:path.relative(root,out),digest:r.digest,summary:r.summary,problems:r.problems.slice(0,10)},null,1));
}
