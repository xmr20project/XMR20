#!/usr/bin/env node
// JOURNALED HOLDER INSTALLATION — one operating-system process per "installation" of a private-token wallet, for the
// restart/recovery cases (stagenet/recovery-cases.mjs). It is the wallet library (wallet-lib) plus the encrypted
// pending-operation journal of the extension build (wallet-extension/src/private-journal.js) on a file-backed store.
//
// An installation is a directory: <install>/journal.json (AES-GCM box + salt + lease, exactly as chrome.storage would
// hold it) and <install>/events.jsonl (what the process printed). The recovery "phrase" is a synthetic 32-byte root in a
// separate 0600 file that is never logged. A FRESH installation is an empty directory with the same root file: it knows
// the chain, not the journal. Two installations with the same root are two directories.
//
// Commands (JSON lines on stdout; the last line has final:true; exit 0 = completed/released, 2 = pending/not completed,
// 1 = failed, rejected, conflicted or refused):
//   send   --op <id> --to <token address> --amount <n> --asset <hex> [--notes c1,c2] [--crash-at <phase>]
//   resume --op <id> [--crash-at <phase>]        continue a journaled operation after a restart (chain is consulted FIRST)
//   settle --op <id>                             one settlement pass: confirming / completed / rejected / re-sent after a rollback
//   status                                       chain view (balances, notes, records, native) + journal view (pending ops, history)
// Common: --install <dir> --root-file <path> --manifest <path> --params <url> --rpc <url> [--wasm <path>]
//         [--confirmations 10] [--password <journal password>]
// --crash-at simulates an abrupt termination (SIGKILL to itself) right after the named phase was journaled:
//   selected | quoted | built | signed | broadcasting (journaled, but NOT yet sent) | broadcast-uncertain (sent, reply lost,
//   killed before the wallet could ask the daemon). Nothing is cleaned up, exactly like a crash or power loss.
//
// What the journal can and cannot do (RECOVERY-CASES.txt): a proof or a signed carrier that was never published exists
// only here; a fresh installation cannot reconstruct it. A record is reported COMPLETED only when it is on chain with the
// required confirmations. Uncertain, conflicting or rejected operations are never reported as completed.
import {readFile,writeFile,mkdir,rename,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
import {createPrivateJournal,reservedCommitments,reservedKeyImages} from '../wallet-extension/src/private-journal.js';
import {closeFetch} from './roles.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const CANDIDATE=path.resolve(here,'..');
const a=process.argv.slice(2);const cmd=a[0];const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
const install=path.resolve(opt('install'));const CONF=Number(opt('confirmations','10'));const crashAt=opt('crash-at');
await mkdir(install,{recursive:true});
const emit=async(o)=>{const line=JSON.stringify({at:new Date().toISOString(),pid:process.pid,...o});console.log(line);await appendFile(path.join(install,'events.jsonl'),line+'\n');};
const crash=async(phase)=>{if(crashAt===phase){await emit({crash:phase,note:'simulated abrupt termination right after this phase was journaled'});process.kill(process.pid,'SIGKILL');await new Promise(()=>{});}};
// File-backed store with atomic writes (temp + rename): a crash during a write leaves the previous box intact.
function fileStore(file){let cache=null;const load=async()=>{if(cache)return cache;try{cache=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;cache={};}return cache;};
 return {async get(k){const m=await load();return m[k]===undefined?undefined:JSON.parse(JSON.stringify(m[k]));},async set(k,v){const m=await load();if(v===null||v===undefined)delete m[k];else m[k]=JSON.parse(JSON.stringify(v));const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(m));await rename(tmp,file);}};}
export const DISPLAY={selected:'Preparing (nothing sent, no fee)',quoted:'Fee quoted (nothing sent, no fee)',built:'Proved; awaiting carrier fee approval (nothing sent, no fee)',signed:'Signed; not yet broadcast',broadcasting:'Broadcast outcome UNKNOWN',published:'Sent to the network; awaiting inclusion',confirming:'Confirming',completed:'Completed',rejected:'Rejected by the token pool (carrier fee paid)',conflicted:'Conflicted: not re-sent (these notes were spent by another installation)',released:'Cancelled (nothing sent, no fee)',refused:'Refused by the daemon (no carrier fee paid)',uncertain:'Broadcast outcome UNKNOWN (daemon unreachable)'};
const displayOf=p=>p.status==='confirming'?`Confirming (${p.confirmations}/${CONF})`:(DISPLAY[p.status]||p.status);
async function main(){
 const manifest=JSON.parse(await readFile(opt('manifest'),'utf8'));const root=(await readFile(opt('root-file'),'utf8')).trim();if(!/^[0-9a-f]{64}$/.test(root))throw Error('bad root file');
 const wasm=await WebAssembly.compile(await readFile(opt('wasm')||path.join(CANDIDATE,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')));
 const journal=createPrivateJournal({store:fileStore(path.join(install,'journal.json'))});await journal.unlock(opt('password','synthetic-journal-password'));
 const lib=await openPrivateWallet({wasm,manifest,daemonRpc:opt('rpc'),parameterServer:opt('params'),cache:memoryCache(),fetch:closeFetch,root});
 const addr=lib.address();const acc=j=>journal.account(j,addr);
 const sync=async()=>{const s=await lib.sync();return {tip:s.tip};};
 const pendingOf=async(op)=>{const j=await journal.read();return acc(j).pending[op]||null;};
 const setOp=async(op,patch)=>{let out;await journal.write(j=>{const p=acc(j).pending[op]||(acc(j).pending[op]={created:Date.now(),attempts:[]});Object.assign(p,patch);out=JSON.parse(JSON.stringify(p));});await emit({op,state:out.status,display:displayOf(out),txid:out.carrier?.txid||null,recordId:out.recordId||null,...(patch.note?{note:patch.note}:{})});return out;};
 const finish=async(op,status,extra={})=>{let out;await journal.write(j=>{const A=acc(j);const p={...(A.pending[op]||{}),...extra,status,finished:Date.now()};if(status!=='completed'){delete p.wire;if(p.carrier)delete p.carrier.blob;}A.history.push({op,...p});delete A.pending[op];out=p;});await emit({op,state:status,display:displayOf({status,...extra}),final:true,...extra});return status;};
 const nativeTotal=()=>{const n=lib.native();return (BigInt(n.unlocked)+BigInt(n.locked)+BigInt(n.reserved||0)).toString();};
 const chainView=()=>{const st=lib.status();const n=lib.native();return {balances:st.balances,notes:st.notes.map(x=>({commitment:x.commitment,amount:x.amount,asset:x.asset})),records:Object.fromEntries(Object.entries(st.records).map(([id,r])=>[id,{txid:r.txid,status:r.status,height:r.height,confirmations:r.confirmations}])),native:{unlocked:n.unlocked,locked:n.locked,outputs:n.outputs.length,total:nativeTotal()},tip:st.tip};};
 const exitWith=async(code,o)=>{await emit({final:true,exit:code,...o});lib.close();process.exit(code);};
 // ---- phases ------------------------------------------------------------------------------------------------------
 const quoteSignPublish=async(op,p)=>{// from 'built' (wire present): quote -> sign -> publish. From 'signed'/'broadcasting': publish only.
  if(p.status==='built'){await sync();const v=lib.verify(p.wire).record;if(v!=='accepted')return finish(op,'conflicted',{reason:'saved record fails local admission after replay; no carrier is built, no fee paid',feePaid:'0'});
   const j=await journal.read();const q=await lib.quoteCarrier({kind:'send',excludeKeyImages:[...reservedKeyImages(acc(j),op)]});p=await setOp(op,{status:'quoted',nativeInput:q.keyImage,quotedFee:q.fee,quoteId:undefined});await crash('quoted');
   const c=lib.signCarrier(q.quoteId,p.wire);p=await setOp(op,{status:'signed',carrier:{txid:c.txid,blob:c.blob,fee:String(c.fee),keyImage:c.keyImage,extraBytes:c.extraBytes,nativeBytes:c.nativeBytes},note:'carrier signed; the saved blob is the ONLY thing that will ever be sent for this operation'});await crash('signed');}
  const txid=p.carrier.txid;
  // Chain first: a 'signed' or 'broadcasting' entry may already be known to the daemon (lost reply, crash after send).
  const known=await lib.lookup(txid);await emit({op,lookup:known,note:'asked the daemon BEFORE any (re)send'});
  if(known.known){p=await setOp(op,{status:'published',recovered:true,via:'lookup',lookup:known,note:'the daemon already holds this carrier: nothing is re-sent'});return p;}
  if(p.status==='broadcasting'||p.status==='signed'){await sync();const v=lib.verify(p.wire).record;if(v!=='accepted')return finish(op,'conflicted',{reason:'the daemon does not know the carrier and the record now fails local admission (notes spent elsewhere): the stale carrier is NOT sent, its fee is not paid',feePaid:'0',txid});}
  const r=await lib.publishWithRecovery(p.carrier.blob,txid,{attempts:3,onAttempt:async({attempt,action})=>{if(action==='send'){p=await setOp(op,{status:'broadcasting',attempts:[...(p.attempts||[]),{attempt,at:Date.now()}]});await crash('broadcasting');}
    if(action==='lookup'){await crash('broadcast-uncertain');}}});
  await emit({op,publish:{ok:r.ok,status:r.status,recovered:r.recovered,resends:r.resends,trail:r.trail}});
  if(r.ok)return setOp(op,{status:'published',recovered:r.recovered,resends:r.resends,trail:r.trail,publishStatus:r.status});
  if(r.uncertain)return setOp(op,{status:'uncertain',trail:r.trail,note:r.reason});
  return finish(op,'refused',{reason:r.reason,doubleSpend:r.doubleSpend||false,feePaid:'0',txid});};
 const settle=async(op)=>{let p=await pendingOf(op);
  if(!p){const j=await journal.read();const h=acc(j).history.find(x=>x.op===op);if(!h)return exitWith(0,{op,note:'unknown operation in this installation'});
   if(h.status!=='completed')return exitWith(h.status==='released'?0:1,{op,state:h.status,display:displayOf(h),note:'final (history)'});
   await sync();const rec=lib.status().records[h.recordId];if(rec&&rec.status==='accepted')return exitWith(0,{op,state:'completed',confirmations:rec.confirmations,note:'still on chain',chain:chainView()});
   if(rec&&rec.status==='rejected'){return exitWith(1,{op,state:'rejected',note:'the chain now rejects this record',chain:chainView()});}
   // The record is gone (rollback): the completed entry is reinstated; the SAME signed carrier is re-sent after re-checking admission.
   await emit({op,note:'a COMPLETED record is no longer on chain (rollback): reinstating it from history; nothing new is signed'});
   await journal.write(j2=>{const A=acc(j2);const i=A.history.findIndex(x=>x.op===op);const e=A.history.splice(i,1)[0];A.pending[op]={...e,status:'signed',reverted:true,previousHeight:e.height};});
   p=await pendingOf(op);const r=await quoteSignPublish(op,p);return exitWith(typeof r==='string'?1:2,{op,state:typeof r==='string'?r:r.status,republished:true,chain:chainView()});}
  if(['selected','quoted','built','signed','broadcasting','uncertain'].includes(p.status))return exitWith(2,{op,state:p.status,display:displayOf(p),note:'not published yet: run resume'});
  await sync();const rec=lib.status().records[p.recordId];const known=await lib.lookup(p.carrier.txid);
  if(rec&&rec.status==='accepted'){const c=Number(rec.confirmations||0);if(c>=CONF){await finish(op,'completed',{confirmations:c,height:rec.height,txid:p.carrier.txid,fee:p.carrier.fee});return exitWith(0,{op,state:'completed',chain:chainView()});}
   p=await setOp(op,{status:'confirming',confirmations:c,height:rec.height});return exitWith(2,{op,state:'confirming',confirmations:c,chain:chainView()});}
  if(rec&&rec.status==='rejected'){await finish(op,'rejected',{height:rec.height,txid:p.carrier.txid,feePaid:p.carrier.fee});return exitWith(1,{op,state:'rejected',chain:chainView()});}
  if(known.known){p=await setOp(op,{status:'published',lookup:known});return exitWith(2,{op,state:'published',inPool:known.inPool,chain:chainView()});}
  // Not on chain, not in the pool, no record: the carrier disappeared (rollback, pool eviction). Same procedure as a restart: chain first, then the SAME blob.
  await emit({op,note:'carrier no longer known to the daemon (rollback or eviction): re-sending the SAME signed carrier after re-checking admission'});
  p=await setOp(op,{status:'signed',reverted:true});const r=await quoteSignPublish(op,p);
  return exitWith(typeof r==='string'?1:2,{op,state:typeof r==='string'?r:r.status,republished:true,chain:chainView()});};
 if(cmd==='status'){const t=await sync();const j=await journal.read();const A=acc(j);const pending=Object.fromEntries(Object.entries(A.pending).map(([k,p])=>[k,{status:p.status,display:displayOf(p),txid:p.carrier?.txid||null,recordId:p.recordId||null,reserved:p.reserved||[]}]));
  return exitWith(0,{status:true,tip:t.tip,chain:chainView(),journal:{pending,history:A.history.map(h=>({op:h.op,status:h.status,display:displayOf(h),txid:h.carrier?.txid||h.txid||null,feePaid:h.feePaid??h.fee??null}))},reservedCommitments:[...reservedCommitments(A)]});}
 if(cmd==='send'){const op=opt('op');const to=opt('to');const amount=String(opt('amount'));const asset=opt('asset');if(!op||!to||!asset)throw Error('send needs --op --to --amount --asset');
  await sync();const j0=await journal.read();const reserved=reservedCommitments(acc(j0));const st=lib.status();
  let notes;if(opt('notes')){notes=opt('notes').split(',');const have=new Set(st.notes.map(n=>n.commitment));for(const c of notes){if(!have.has(c))throw Error('note not owned/unspent on chain: '+c.slice(0,16));if(reserved.has(c))throw Error('note reserved by another pending operation in this installation: '+c.slice(0,16));}}
  else{const s=lib.select({asset,amount,exclude:[...reserved]});notes=s.notes;}
  const total=notes.reduce((n,c)=>n+BigInt(st.notes.find(x=>x.commitment===c).amount),0n);if(total<BigInt(amount))throw Error('insufficient notes');
  await emit({op,chainBefore:chainView()});
  let p=await setOp(op,{status:'selected',reserved:notes,to,amount,asset,change:(total-BigInt(amount)).toString()});await crash('selected');
  const q=await lib.quoteCarrier({kind:'send',excludeKeyImages:[...reservedKeyImages(acc(j0))]});p=await setOp(op,{status:'quoted',nativeInput:q.keyImage,quotedFee:q.fee,quotedWeight:q.weight});await crash('quoted');
  const t=Date.now();const built=await lib.prove({kind:'send',to,amount,notes});p=await setOp(op,{status:'built',wire:built.wire,recordId:built.recordId,recordBytes:built.bytes,provingMs:Date.now()-t});await crash('built');
  const c=lib.signCarrier(q.quoteId,built.wire);p=await setOp(op,{status:'signed',carrier:{txid:c.txid,blob:c.blob,fee:String(c.fee),keyImage:c.keyImage,extraBytes:c.extraBytes,nativeBytes:c.nativeBytes}});await crash('signed');
  const r=await quoteSignPublish(op,p);return exitWith(typeof r==='string'?(r==='released'?0:1):2,{op,state:typeof r==='string'?r:r.status,txid:p.carrier.txid,fee:p.carrier.fee,recordId:built.recordId,chain:chainView()});}
 if(cmd==='resume'){const op=opt('op');let p=await pendingOf(op);if(!p)return exitWith(0,{op,note:'nothing pending for this operation in this installation (see history)'});
  await sync();await emit({op,resumeFrom:p.status,display:displayOf(p),note:'restarted from the journal; the chain is consulted before anything is sent'});
  if(p.status==='selected'||p.status==='quoted'){await finish(op,'released',{reason:'the quote cannot survive a restart; nothing was proved or sent; no fee',feePaid:'0'});return exitWith(0,{op,state:'released',chain:chainView()});}
  if(['confirming','published','uncertain'].includes(p.status)){if(p.status==='uncertain')p=await setOp(op,{status:'broadcasting'});else return settle(op);}
  const r=await quoteSignPublish(op,p);return exitWith(typeof r==='string'?1:2,{op,state:typeof r==='string'?r:r.status,txid:(await pendingOf(op))?.carrier?.txid||null,chain:chainView()});}
 if(cmd==='settle')return settle(opt('op'));
 throw Error('unknown command '+cmd);
}
main().catch(async e=>{await emit({error:e.message,stack:(e.stack||'').split('\n').slice(0,4).join(' | '),final:true,exit:1});process.exit(1);});
