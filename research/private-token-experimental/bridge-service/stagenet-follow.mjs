// STAGENET FOLLOW CHECK: run the persistent indexer service against the isolated stagenet node with the stagenet-v1 manifest of
// the format candidate and verify that it reconstructs the six records of the 25–26 Oct rehearsal from a fresh state directory,
// then that a restart resumes from disk without re-fetching. Read-only on the node; nothing is published. Test funds only.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startIndexerService,createIndexerClient} from './bridge/indexer-service.mjs';
import {freeLoopbackPort} from '../token-format-unshielded-fix-20261026/backend/service.mjs';
const here=fileURLToPath(new URL('./',import.meta.url));const fmt=here+'../token-format-unshielded-fix-20261026/';
const BIN=fmt+'target/release/xmr20-indexer';const RPC='http://127.0.0.1:38091';const STATE=here+'runs/stagenet-follow-state';
// the rehearsal evidence (txids) lives in the REVIEWED candidate (read-only); binaries and parameters come from the fix candidate
const expected=JSON.parse(await readFile(here+'../token-format-unshielded-20261025/runs/stagenet-unshielded/results.json','utf8'));
await rm(STATE,{recursive:true,force:true});await mkdir(here+'runs',{recursive:true});
const t0=Date.now();const svc=await startIndexerService({bin:BIN,paramsDir:fmt+'params/stagenet-v1',trustedManifest:fmt+'params/stagenet-v1/manifest.json',rpcUrl:RPC,stateDir:STATE,httpPort:await freeLoopbackPort(),pollMs:3600_000,maxBlocks:200,log:x=>console.error(JSON.stringify(x).slice(0,200))});
const c=createIndexerClient(svc.url);
let h;for(let i=0;i<200;i++){const r=await svc.sync();h=await c.health();if(r.behind===0)break;}
const summary=await c.summary();const want=[];for(const s of expected.steps){if(s.txid&&s.step!=='fund')want.push(s.txid);if(s.a)want.push(s.a.txid,s.b.txid);}
const found={};for(const tx of want){const r=await c.tx(tx);found[tx]={found:r.found,record:r.record,kind:r.kind,confirmations:r.confirmations};}
const report={execution:'PUBLIC STAGENET (read-only follow)',firstSyncSeconds:(Date.now()-t0)/1000,health:h,state:summary.state,expectedTxids:want.length,found};
const ok=want.every(t=>found[t].found&&found[t].record==='accepted');
// restart from disk: kill the child, ask again; the state must come back without a reorganisation and with the same root
await svc.crashChild();const h2=await c.health();const s2=await c.summary();report.restart={restarts:svc.restarts,tip:h2.tip,sameRoot:s2.state.root===summary.state.root};
await svc.close();report.ok=ok&&report.restart.sameRoot&&summary.state.invariant.ok;
await writeFile(here+'runs/stagenet-follow-results.json',JSON.stringify(report,null,1));console.log(JSON.stringify({ok:report.ok,firstSyncSeconds:report.firstSyncSeconds,tip:h.tip,records:summary.state.accepted,completedOperations:summary.state.completedOperations,restart:report.restart}));
process.exit(report.ok?0:1);
