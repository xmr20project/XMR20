import {createHash} from 'node:crypto';
export const RULES_VERSION='xmr20-reader-0.2.0';
export const canonical=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const order=(a,b)=>a<b?-1:a>b?1:0;

export function verificationReport(input,ledger,snapshots){
 const state={tokens:[...ledger.tokens].map(([deployment,t])=>({deployment,mint:t.record.mint,outstandingRaw:t.outstanding.toString(),balances:[...t.balances].filter(([,n])=>n>0n).sort(([a],[b])=>order(a,b)).map(([address,n])=>({address,amountRaw:n.toString()}))})).sort((a,b)=>order(a.deployment,b.deployment)),
  credits:[...ledger.credits].sort(),transfers:[...ledger.transfers.keys()].sort(),burns:[...ledger.burns.keys()].sort()};
 const backing=snapshots.map(s=>({deployment:s.id,mint:s.mint,solanaSlot:s.solanaSlot,state:s.state,
  currentSupplyRaw:s.currentSupplyRaw??null,escrowRaw:s.escrowRaw??null,moneroRaw:s.moneroRaw??null,
  inTransitRaw:s.inTransitRaw??null,unassignedEscrowRaw:s.unassignedEscrowRaw??null,withheldTaxRaw:s.withheldTaxRaw??null,
  holders:(s.holders||[]).map(({network,address,amountRaw})=>({network,address,amountRaw})).sort((a,b)=>order(a.network+':'+a.address,b.network+':'+b.address))})).sort((a,b)=>order(a.deployment,b.deployment));
 return {schema:'xmr20-verification-v1',rulesVersion:RULES_VERSION,
  sourceSha256:typeof __XMR20_SOURCE_HASH__==='string'?__XMR20_SOURCE_HASH__:'unbuilt',
  policySha256:digest({policy:input.policy,scanStartHeight:input.scanStartHeight??null}),
  moneroCheckpoint:input.checkpoint,ledgerSha256:digest(state),backingSha256:digest(backing),
  solanaCheckpoints:backing.map(s=>({deployment:s.deployment,slot:s.solanaSlot})),
  ledger:state,backing,
  scope:'locally-recomputed-accounting; RPC evidence is not a standalone consensus proof'};
}

export function compareReports(a,b){
 const valid=r=>r?.schema==='xmr20-verification-v1'&&r.rulesVersion===RULES_VERSION&&/^[a-f0-9]{64}$/.test(r.policySha256||'')&&r.moneroCheckpoint&&Number.isSafeInteger(r.moneroCheckpoint.height)&&r.moneroCheckpoint.height>=0&&/^[a-f0-9]{64}$/.test(r.moneroCheckpoint.hash||'')&&Array.isArray(r.solanaCheckpoints)&&r.ledger&&Array.isArray(r.backing)&&r.backing.every(s=>Number.isSafeInteger(s.solanaSlot)&&s.solanaSlot>=0)&&canonical(r.solanaCheckpoints)===canonical(r.backing.map(s=>({deployment:s.deployment,slot:s.solanaSlot})))&&r.ledgerSha256===digest(r.ledger)&&r.backingSha256===digest(r.backing);
 if(!valid(a)||!valid(b))return {status:'INVALID_REPORT'};
 if(a.policySha256!==b.policySha256||canonical(a.moneroCheckpoint)!==canonical(b.moneroCheckpoint))return {status:'NOT_COMPARABLE',reason:'policy-or-monero-checkpoint'};
 if(a.ledgerSha256!==b.ledgerSha256)return {status:'MISMATCH',component:'monero-ledger'};
 if(canonical(a.solanaCheckpoints)!==canonical(b.solanaCheckpoints))return {status:'LEDGER_MATCH_BACKING_NOT_COMPARABLE',reason:'solana-checkpoints'};
 if(a.backingSha256!==b.backingSha256)return {status:'MISMATCH',component:'solana-backing'};
 return {status:'MATCH',sameSource:a.sourceSha256===b.sourceSha256};
}
