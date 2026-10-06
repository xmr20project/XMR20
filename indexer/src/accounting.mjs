// Read-only public account validation extracted from the second indexer.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {unpackMint,unpackAccount,getTransferFeeAmount,getTransferFeeConfig,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {checkMoneroAddress} from './address.js';
import {addresses,decodeConfig} from './escrow.mjs';
import {FUND} from './fund-policy.mjs';
const LAUNCHPAD_AUTHORITY=new PublicKey('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh');
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const HASH=/^[a-f0-9]{64}$/, AMOUNT=/^(0|[1-9][0-9]{0,29})$/;
const MAX_EVENTS=100000, MAX_ACCOUNTS=20000, MAX_BYTES=64*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
export const PROGRAMS=Object.freeze([
 {version:1,programId:'G4Cedy1wgpCnAAn3N7NmczwqFHdUrrnSbBV2UnbvzKNp',binaryHash:'97be66a050423b9b4cffc9510838096da7d3e8a2d9b3d2c21b7d3220d53b452a',binarySize:104712},
 {version:2,programId:'9ZySdqL8A326EfQkU2T8AckeYWCVUeeNyFy42oyVqL4R',binaryHash:'b7ae31cd24cfe568da34fef4be7e08ffb44989a63a959a865402d64b31cc1f60',binarySize:114400},
 {version:3,programId:'2wEBASzbdj13KJtmjK7UFhug38oGaWsfvMGhQ3umr265',binaryHash:'b1a668062893ef18d908caad946d1c63d28508462cd590b118bc70ceb0acaeb7',binarySize:157136}
]);
export class AccountingRejected extends Error{constructor(category){super('accounting.'+category);this.category='accounting.'+category;}}
const need=(ok,category)=>{if(!ok)throw new AccountingRejected(category);};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const pubkey=s=>{try{const p=new PublicKey(s);need(typeof s==='string'&&p.toBase58()===s,'public-key');return p;}catch{throw new AccountingRejected('public-key');}};
const stable=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function inputs(input){
 need(input&&input.schemaVersion===1,'schema');
 const {policy,scan,projection}=input;
 need(policy&&checkMoneroAddress(policy.operatorAddress,'mainnet').kind==='standard'&&
  (policy.transferStartHeight===null||integer(policy.transferStartHeight))&&Array.isArray(policy.abandonedLaunches)&&policy.abandonedLaunches.length<=1000,'policy');
 need(policy.v3ProgramId===null||policy.v3ProgramId===PROGRAMS[2].programId,'program-policy');
 need(scan&&scan.network==='mainnet'&&integer(scan.height)&&Array.isArray(scan.events)&&scan.events.length<=MAX_EVENTS,'scan');
 need(projection?.schema==='xmr20-public-replay-projection-v1'&&Array.isArray(projection.launches)&&projection.launches.length<=20000&&Array.isArray(projection.receipts)&&Array.isArray(projection.holderSnapshots),'projection');
 const launches=new Map(),byMint=new Map();
 for(const row of projection.launches){need(row&&typeof row.id==='string'&&!launches.has(row.id),'launch-identity');launches.set(row.id,row);if(row.mint){pubkey(row.mint);need(!byMint.has(row.mint),'duplicate-mint');byMint.set(row.mint,row);}}
 let previous=-1,index=-1;const txids=new Set();
 for(const event of scan.events){need(event&&HASH.test(event.txid)&&integer(event.height)&&event.height<=scan.height&&integer(event.confirmations)&&event.confirmations===scan.height-event.height+1&&event.confirmations>=10&&event.envelope?.record,'event-checkpoint');need(!txids.has(event.txid),'duplicate-event');txids.add(event.txid);
  const ix=event.index??0;need(integer(ix)&&(event.height>previous||event.height===previous&&ix>index),'event-order');previous=event.height;index=ix;}
 return {policy,scan,projection,launches,byMint};
}
function binding(row){
 const version=row.bridgeVersion||1,manifest=PROGRAMS.find(p=>p.version===version);need(manifest,'bridge-binding');
 if(version===1)need(!row.escrowPolicy&&!row.bridgeProgramId,'bridge-binding');
 if(version===2)need(!row.escrowPolicy&&!row.bridgeProgramId||row.escrowPolicy==='operator-v2'&&row.bridgeProgramId===manifest.programId,'bridge-binding');
 if(version===3)need(row.escrowPolicy==='platform-auto-v3'&&row.bridgeProgramId===manifest.programId&&row.transferTaxBps===150&&row.platformFeeBps===0,'bridge-binding');
 return manifest;
}
const eligible=r=>r.moneroNetwork==='mainnet'&&r.network==='mainnet-beta'&&!r.hidden&&!r.halted&&!r.cancelledAt&&!r.publicIndexExcluded;
export function planCheckpointReads(input){
 const {scan,projection,byMint}=inputs(input),tokens=new Map(),programs=new Map();
 for(const row of projection.launches.filter(eligible))if(row.mint)tokens.set(row.mint,{mint:row.mint,launchId:row.id,deployment:row.moneroTxid,manifest:binding(row),deposits:new Set()});
 // Every credit read by either ledger requires the original receipt account,
 // including otherwise non-public ledger deployments. Nothing is top-N sampled.
 const admitted=input.discoveryAdmissions?new Set(input.discoveryAdmissions):null;
 const deployments=new Map();for(const e of scan.events)if(e.envelope.record.op==='deploy'&&(!admitted||admitted.has(e.txid)))deployments.set(e.txid,e.envelope.record);
 for(const e of scan.events){const r=e.envelope.record;if(r.op!=='credit')continue;const deploy=deployments.get(r.token);if(!deploy)continue;
  const row=byMint.get(deploy.mint);need(row,'unbound-credited-mint');
  if(!tokens.has(row.mint))tokens.set(row.mint,{mint:row.mint,launchId:row.id,deployment:r.token,manifest:binding(row),deposits:new Set()});
  pubkey(r.deposit);tokens.get(row.mint).deposits.add(r.deposit);}
 for(const receipt of projection.receipts){const row=projection.launches.find(r=>r.id===receipt.launchId);if(!row||!eligible(row)||!row.mint)continue;
  const token=tokens.get(row.mint);if(receipt.direction==='sol-to-xmr'&&receipt.sourceId){pubkey(receipt.sourceId);token.deposits.add(receipt.sourceId);}
  if(receipt.direction==='xmr-to-sol'&&HASH.test(receipt.sourceTxid||''))token.deposits.add(addresses(token.manifest.programId,row.mint).receipt('withdraw',Buffer.from(receipt.sourceTxid,'hex')).toBase58());}
 const plans=[...tokens.values()].sort((a,b)=>a.mint.localeCompare(b.mint)).map(t=>{
  const a=addresses(t.manifest.programId,t.mint);programs.set(t.manifest.programId,t.manifest);
  const discovery=projection.launches.find(r=>r.id===t.launchId)?.discoverySource==='chain';
  const keys=[...new Set([t.mint,a.config.toBase58(),a.vault.toBase58(),...[...t.deposits].sort(),...(discovery?PROGRAMS.map(p=>addresses(p.programId,t.mint).config.toBase58()):[])])];need(keys.length<=MAX_ACCOUNTS,'account-limit');
  return {mint:t.mint,launchId:t.launchId,deployment:t.deployment,programId:t.manifest.programId,version:t.manifest.version,
   enumeration:{method:'getProgramAccounts',params:[TOKEN_2022_PROGRAM_ID.toBase58(),{encoding:'base64',commitment:'finalized',withContext:true,filters:[{memcmp:{offset:0,bytes:t.mint}}]}]},
   accountKeys:keys,accountMethod:'getMultipleAccounts',accountOptions:{encoding:'base64',commitment:'finalized'},
   contextRule:'Set minContextSlot to enumeration context.slot; accept only EXACT equality for every account response. Never mix attempts.'};});
 return {schema:'xmr20-checkpoint-read-plan-v1',programs:[...programs.values()].map(p=>({...p,programData:PublicKey.findProgramAddressSync([pubkey(p.programId).toBuffer()],LOADER)[0].toBase58()})),tokens:plans,
  allowedMethods:['getGenesisHash','getProgramAccounts','getMultipleAccounts'],maxAccountsPerRequest:100,
  note:'Each token can use a different finalized slot; all reads within one token must match exactly. All chain requests count toward the launcher budget.'};
}
function account(raw){
 if(raw===null)return null;
 need(raw&&typeof raw.executable==='boolean'&&Array.isArray(raw.data)&&raw.data.length===2&&raw.data[1]==='base64'&&typeof raw.data[0]==='string'&&raw.data[0].length<=24*1024*1024,'account-shape');
 const bytes=Buffer.from(raw.data[0],'base64');need(bytes.toString('base64')===raw.data[0],'account-encoding');
 return {owner:pubkey(raw.owner),executable:raw.executable,data:bytes,lamports:integer(raw.lamports)?raw.lamports:0,rentEpoch:0};
}
function verifyPrograms(evidence,plans,manifests){
 need(Array.isArray(evidence),'program-evidence');const seen=new Set();
 for(const plan of plans){const p=manifests.find(p=>p.programId===plan.programId);need(p,'program-policy');const rows=evidence.filter(r=>r.programId===p.programId);need(rows.length===1,'program-evidence');const row=rows[0];need(integer(row.slot),'program-context');
  const program=account(row.program),data=account(row.programData),address=PublicKey.findProgramAddressSync([pubkey(p.programId).toBuffer()],LOADER)[0];
  need(program?.executable&&program.owner.equals(LOADER)&&program.data.length===36&&program.data.readUInt32LE(0)===2&&new PublicKey(program.data.subarray(4)).equals(address),'program-account');
  need(data&&!data.executable&&data.owner.equals(LOADER)&&data.data.length>=45+p.binarySize&&data.data.readUInt32LE(0)===3&&data.data[12]===0,'program-immutable');
  need(hash(data.data.subarray(45,45+p.binarySize))===p.binaryHash&&!data.data.subarray(45+p.binarySize).some(v=>v!==0),'program-binary');seen.add(p.programId);}
 return seen;
}
function tax(mint,version){
 const t=getTransferFeeConfig(mint);if(!t){need(version===1,'mint-tax');return;}
 need(version>=2&&t.withdrawWithheldAuthority.equals(FUND.state)&&(t.transferFeeConfigAuthority.equals(FUND.state)||t.transferFeeConfigAuthority.equals(LAUNCHPAD_AUTHORITY))&&[t.olderTransferFee,t.newerTransferFee].every(f=>f.transferFeeBasisPoints===150&&f.maximumFee===1000000000000000n),'mint-tax');
}
function tokenEvidence(plan,row,launch){
 need(row&&row.mint===plan.mint&&integer(row.enumeration?.context?.slot)&&Array.isArray(row.enumeration?.value)&&row.enumeration.value.length<=MAX_ACCOUNTS&&Array.isArray(row.accountReads),'token-evidence');
 const slot=row.enumeration.context.slot, infos=new Map();
 for(const read of row.accountReads){need(read?.context?.slot===slot&&Array.isArray(read.keys)&&Array.isArray(read.value)&&read.keys.length===read.value.length&&read.keys.length>0&&read.keys.length<=100,'context-mismatch');
  for(let i=0;i<read.keys.length;i++){const key=read.keys[i];pubkey(key);need(plan.accountKeys.includes(key)&&!infos.has(key),'account-coverage');infos.set(key,account(read.value[i]));}}
 need(infos.size===plan.accountKeys.length&&plan.accountKeys.every(k=>infos.has(k)),'account-coverage');
 const mintKey=pubkey(plan.mint),program=pubkey(plan.programId),a=addresses(program,plan.mint),mintInfo=infos.get(plan.mint),configInfo=infos.get(a.config.toBase58()),vaultInfo=infos.get(a.vault.toBase58());
 if(!mintInfo){need(!launch.solanaFinalized&&!launch.bridgeReady&&!configInfo&&!vaultInfo&&row.enumeration.value.length===0,'mint-unavailable');return {slot,unissued:true,infos,plan};}
 need(launch.solanaFinalized===true&&mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)&&!mintInfo.executable,'mint-policy');
 const mint=unpackMint(mintKey,mintInfo,TOKEN_2022_PROGRAM_ID);need(mint.isInitialized&&mint.decimals===6&&!mint.mintAuthority&&!mint.freezeAuthority,'mint-policy');tax(mint,plan.version);
 let locked=0n,attestor=null;
 if(configInfo){need(configInfo.owner.equals(program)&&!configInfo.executable,'escrow-owner');const s=decodeConfig(configInfo.data,plan.version);
  need(s.mint===plan.mint&&s.vault===a.vault.toBase58()&&s.moneroTxid===plan.deployment,'escrow-binding');locked=BigInt(s.lockedRaw);attestor=s.attestor;
  need(vaultInfo,'vault-unavailable');const v=unpackAccount(a.vault,vaultInfo,TOKEN_2022_PROGRAM_ID);
  need(v.mint.equals(mintKey)&&v.owner.equals(a.config)&&!v.delegate&&!v.closeAuthority&&!v.isFrozen&&v.amount>=locked,'vault-policy');
 }else need(!launch.bridgeReady,'escrow-unavailable');
 const seen=new Set(),balances=new Map();let total=0n,vault=0n,withheld=getTransferFeeConfig(mint)?.withheldAmount||0n;
 for(const item of row.enumeration.value){pubkey(item.pubkey);need(!seen.has(item.pubkey),'duplicate-token-account');seen.add(item.pubkey);const info=account(item.account);
  need(info&&!info.executable&&info.owner.equals(TOKEN_2022_PROGRAM_ID),'token-account');const token=unpackAccount(pubkey(item.pubkey),info,TOKEN_2022_PROGRAM_ID);
  need(token.mint.equals(mintKey)&&token.isInitialized,'token-account');withheld+=getTransferFeeAmount(token)?.withheldAmount||0n;total+=token.amount;
  if(item.pubkey===a.vault.toBase58()){vault+=token.amount;need(vaultInfo&&info.data.equals(vaultInfo.data),'vault-enumeration');}else if(token.amount)balances.set(token.owner.toBase58(),(balances.get(token.owner.toBase58())||0n)+token.amount);}
 const currentVault=vaultInfo?unpackAccount(a.vault,vaultInfo,TOKEN_2022_PROGRAM_ID).amount:0n;
 need(total+withheld===mint.supply&&vault===currentVault,'enumeration-incomplete');
 return {slot,unissued:false,infos,plan,mintSupply:mint.supply,vaultBalance:vault,lockedRaw:locked,withheldRaw:withheld,solanaHolders:[...balances].sort().map(([address,n])=>({address,amountRaw:n.toString()})),attestor};
}

export {verifyPrograms,tokenEvidence,account,GENESIS,inputs as validateInputs};
