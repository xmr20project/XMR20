import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {addresses,decodeReceipt} from './escrow.mjs';
import {planCheckpointReads,verifyPrograms,tokenEvidence,account,GENESIS} from './accounting.mjs';
import {replayMainnetEvents,reconcileSupply,moneroHolderRows} from './replay.mjs';
import {PROGRAMS} from './accounting.mjs';
import {discover,recheckDiscovery} from './discovery.mjs';
import {verificationReport} from './verification.mjs';
const need=(v,s)=>{if(!v)throw Error(s)};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const allowed=new Set(['getGenesisHash','getMultipleAccounts','getProgramAccounts']);
export function readClient(url,fetcher=fetch){
  const u=new URL(url);need((u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname))&&!u.username&&!u.password&&!u.hash,'rpc-url');
  let last=0,lastMethod=null,debt=0;
  return async(method,params=[])=>{
    need(allowed.has(method),'rpc-method');
    for(let attempt=0;attempt<3;attempt++){
      // Keep the overall RPC pace while reading an enumeration and its account
      // state together. Waiting between them makes an exact bank match unlikely.
      const paired=lastMethod==='getProgramAccounts'&&method==='getMultipleAccounts';
      await wait(Math.max(0,(paired?0:350+debt)-(Date.now()-last)));
      debt=paired?debt+350:0;last=Date.now();lastMethod=method;
      const res=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json','User-Agent':'XMR20-Read-Indexer/0.2'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(res.status===429&&attempt<2){await wait(15000*(attempt+1));continue;}
      need(res.ok,'solana-http-'+res.status);
      const text=await res.text();need(text.length<32*1024*1024,'rpc-size');
      const data=JSON.parse(text);
      need(data.error?.code!==-32016,'solana-context-unavailable');
      need(!data.error&&data.result!==undefined,'solana-rpc-rejected');return data.result;
    }
    throw Error('solana-rate-limit');
  };
}
export async function calculate(input,rpc,{manifests=PROGRAMS}={}){
  const plan=planCheckpointReads(input);
  need(await rpc('getGenesisHash')===GENESIS,'solana-network');
  const programEvidence=[];
  for(const p of plan.programs){
    const r=await rpc('getMultipleAccounts',[[p.programId,p.programData],{encoding:'base64',commitment:'finalized'}]);
    need(r?.value?.length===2,'program-coverage');
    programEvidence.push({programId:p.programId,slot:r.context.slot,program:r.value[0],programData:r.value[1]});
  }
  verifyPrograms(programEvidence,plan.programs,manifests);
  const evidence=new Map(),launches=new Map(input.projection.launches.map(r=>[r.id,r]));
  for(const p of plan.tokens){
    let accepted=null;
    for(let attempt=0;attempt<5;attempt++){
      const enumeration=await rpc(p.enumeration.method,p.enumeration.params),accountReads=[];
      need(Number.isSafeInteger(enumeration?.context?.slot),'enumeration-context');
      let changed=false;
      for(let i=0;i<p.accountKeys.length;i+=100){
        const keys=p.accountKeys.slice(i,i+100);
        let r;
        try{r=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'finalized',minContextSlot:enumeration.context.slot}]);}
        catch(e){if(e.message!=='solana-context-unavailable')throw e;changed=true;break;}
        if(r.context?.slot!==enumeration.context.slot){changed=true;break;}
        accountReads.push({...r,keys});
      }
      if(changed)continue;
      accepted=tokenEvidence(p,{mint:p.mint,enumeration,accountReads},launches.get(p.launchId));
      recheckDiscovery(launches.get(p.launchId),accepted.infos);break;
    }
    need(accepted,'solana-context-changing');evidence.set(p.mint,accepted);
  }
  const byMint=new Map(input.projection.launches.map(r=>[r.mint,r]));
  const solana={async depositReceipt(deploy,id){
    const e=evidence.get(deploy.mint);need(e&&!e.unissued&&e.infos.has(id),'receipt-coverage');
    const info=e.infos.get(id);if(!info)return null;
    need(info.owner.toBase58()===e.plan.programId&&!info.executable,'receipt-owner');
    if(deploy.bridgeVersion===3)need(deploy.bridgeProgramId===e.plan.programId&&deploy.escrowPolicy==='platform-auto-v3'&&e.plan.version===3,'receipt-binding');
    else need(e.plan.version!==3,'receipt-binding');
    const r=decodeReceipt(info.data,e.plan.version),a=addresses(e.plan.programId,deploy.mint);
    need(r.kind==='deposit'&&r.config===a.config.toBase58()&&a.receipt('deposit',Buffer.from(r.id,'hex')).toBase58()===id,'receipt-binding');return r;
  }};
  const ledger=await replayMainnetEvents(input.scan.events,{...input.policy,network:'mainnet-beta',solana,launchByMint:mint=>byMint.get(mint)||null});
  const snapshots=[];
  for(const [mint,e] of evidence){
    const r=launches.get(e.plan.launchId),token=ledger.tokens.get(r.moneroTxid);
    if(e.unissued){snapshots.push({id:r.id,mint,state:'unissued',holders:[],solanaSlot:e.slot});continue;}
    if(e.infos.get(addresses(e.plan.programId,mint).config.toBase58()))need(token?.record.mint===mint,'deployment-not-indexed');
    const moneroHolders=token?moneroHolderRows(token):[];
    const supply=reconcileSupply({...e,moneroOutstanding:token?.outstanding||0n,moneroHolders});
    snapshots.push({schema:'xmr20-holders-v1',id:r.id,mint,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',state:'verified',decimals:6,checkedAt:Date.now(),moneroHeight:input.scan.height,moneroBlockHash:input.checkpoint.hash,moneroConfirmations:10,solanaSlot:e.slot,escrowAddress:addresses(e.plan.programId,mint).vault.toBase58(),...supply});
  }
  return {snapshots,checkpoint:input.checkpoint,verification:verificationReport(input,ledger,snapshots),accepted:{deployments:ledger.tokens.size,credits:ledger.credits.size,transfers:ledger.transfers.size,burns:ledger.burns.size}};
}
export async function discoverAndCalculate(input,rpc,options={}){
  const found=await discover(input,rpc,options);
  const ids=[...found.launches,...found.unbound].map(r=>r.id).sort();
  const result=await calculate({...input,discoveryAdmissions:ids,projection:{schema:'xmr20-public-replay-projection-v1',launches:found.launches,receipts:[],holderSnapshots:[]}},rpc,options);
  // The provisional discovery pass must agree with the final balance-aware
  // replay; nonce conflicts or other admission differences cannot be hidden.
  need(JSON.stringify(ids)===JSON.stringify(result.verification.ledger.tokens.map(r=>r.deployment).sort()),'discovery-admission-mismatch');
  return {...result,catalog:[...found.launches,...found.unbound].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),unbound:found.unbound.map(r=>({id:r.id,mint:r.mint,state:'unbound',solanaSlot:r.discoverySlot})),discoverySource:'chain'};
}
if(['--calculate','--discover-calculate'].includes(process.argv[2])){
  try{
    const input=JSON.parse(readFileSync(0,'utf8'));
    const result=await (process.argv[2]==='--discover-calculate'?discoverAndCalculate:calculate)(input,readClient(input.solanaUrl));process.stdout.write(JSON.stringify(result)+'\n');
  }catch(e){
    const known=/^(accounting\.[a-z-]+|discovery\.[a-z-]+|discovery-admission-mismatch|solana-[a-z-]+|solana-http-\d{3}|receipt-[a-z-]+|deployment-not-indexed|rpc-[a-z-]+|program-coverage|enumeration-context)$/;
    process.stdout.write(JSON.stringify({error:known.test(e.message)?e.message:'ledger-validation-failed'})+'\n');process.exitCode=1;
  }
}
