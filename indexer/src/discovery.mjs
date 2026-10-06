// Derive token bindings from verified inscription events and raw Solana accounts.
// Never fetch listing flags, metadata or balances from an XMR20-operated API.
import {PublicKey} from '@solana/web3.js';
import {addresses,decodeConfig} from './escrow.mjs';
import {PROGRAMS,account,verifyPrograms,GENESIS,validateInputs} from './accounting.mjs';
import {replayMainnetEvents} from './replay.mjs';

const need=(ok,reason)=>{if(!ok)throw Error('discovery.'+reason);};
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export function discoveryKeys(mint){return PROGRAMS.map(p=>addresses(p.programId,mint).config.toBase58());}

export function selectBinding(record,rawConfigs){
 need(Array.isArray(rawConfigs)&&rawConfigs.length===PROGRAMS.length,'config-coverage');
 const candidates=[];
 for(let i=0;i<PROGRAMS.length;i++){
  if(rawConfigs[i]===null)continue;
  const p=PROGRAMS[i],info=account(rawConfigs[i]);
  need(info&&!info.executable&&info.owner.toBase58()===p.programId,'config-owner');
  let c;try{c=decodeConfig(info.data,p.version);}catch{throw Error('discovery.config-format');}
  need(c.mint===record.mint&&c.moneroTxid===record.txid&&c.vault===addresses(p.programId,record.mint).vault.toBase58(),'config-binding');
  need((record.fee==='200'&&p.version===1)||(record.fee==='150'&&p.version>=2),'fee-version');
  candidates.push(p);
 }
 need(candidates.length<=1,'ambiguous-escrow');
 return candidates[0]||null;
}

export async function discover(input,rpc,{manifests=PROGRAMS}={}){
 const empty={...input,projection:{schema:'xmr20-public-replay-projection-v1',launches:[],receipts:[],holderSnapshots:[]}};
 validateInputs(empty);
 need(input.checkpoint?.height===input.scan.height&&/^[a-f0-9]{64}$/.test(input.checkpoint.hash),'checkpoint');
 need(await rpc('getGenesisHash')===GENESIS,'solana-network');
 // Deployments are provisional until the final ledger replay. No balance is
 // inferred here, and a null deposit verifier never creates a credit.
 const declarations=await replayMainnetEvents(input.scan.events,{
  ...input.policy,network:'mainnet-beta',v3ProgramId:null,launchByMint:null,
  solana:{async depositReceipt(){return null;}}
 });
 const plans=PROGRAMS.map(p=>({...p,programData:PublicKey.findProgramAddressSync([new PublicKey(p.programId).toBuffer()],LOADER)[0].toBase58()}));
 const programs=[];
 for(const p of plans){
  const r=await rpc('getMultipleAccounts',[[p.programId,p.programData],{encoding:'base64',commitment:'finalized'}]);
  need(Number.isSafeInteger(r?.context?.slot)&&r.context.slot>=0&&r?.value?.length===2,'program-coverage');
  programs.push({programId:p.programId,slot:r.context.slot,program:r.value[0],programData:r.value[1]});
 }
 verifyPrograms(programs,plans,manifests);
 const launches=[],unbound=[];
 for(const [txid,t] of declarations.tokens){
  const record=t.record,keys=[record.mint,...discoveryKeys(record.mint)];
  const r=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'finalized'}]);
  need(Number.isSafeInteger(r?.context?.slot)&&r.context.slot>=0&&r.value?.length===keys.length,'discovery-coverage');
  const selected=selectBinding(record,r.value.slice(1));
  const event=input.scan.events.find(e=>e.txid===txid);
  const row={id:txid,mint:record.mint,owner:record.creator,ticker:record.tick,name:record.tick,
   moneroNetwork:'mainnet',network:'mainnet-beta',moneroTxid:txid,metadataHash:record.meta,
   proofVerified:true,confirmations:event.confirmations,discoverySource:'chain',
   discoverySlot:r.context.slot,discoveryRecord:record,publicIndex:true};
  if(!selected){
   // A nonzero representation cannot be verified without its backing. Do not
   // quietly omit a credited token or substitute a zero balance.
   need(!input.scan.events.some(e=>e.envelope.record.op==='credit'&&e.envelope.record.token===txid),'credit-without-escrow');
   unbound.push({...row,state:'unbound',bridgeReady:false,solanaFinalized:false});continue;
  }
  need(r.value[0]!==null,'mint-missing');
  launches.push({...row,state:'discovered',solanaFinalized:true,bridgeReady:true,
   bridgeVersion:selected.version,bridgeProgramId:selected.version===1?null:selected.programId,
   escrowPolicy:selected.version===3?'platform-auto-v3':selected.version===2?'operator-v2':null,
   transferTaxBps:selected.version===1?0:150,platformFeeBps:selected.version===1?200:0});
 }
 return {launches,unbound};
}

export function recheckDiscovery(launch,infos){
 if(launch.discoverySource!=='chain')return;
 const keys=discoveryKeys(launch.mint);
 // infos are decoded account objects from the exact token-enumeration slot.
 const raw=keys.map(k=>{
  need(infos.has(k),'config-coverage');const x=infos.get(k);
  return x?{owner:x.owner.toBase58(),executable:x.executable,data:[x.data.toString('base64'),'base64'],lamports:x.lamports}:null;
 });
 const selected=selectBinding(launch.discoveryRecord,raw);
 need(selected?.version===launch.bridgeVersion,'binding-changed');
}
