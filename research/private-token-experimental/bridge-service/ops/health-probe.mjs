// Health probe for monitoring: exit 0 when indexer and bridge are healthy, 1 otherwise; prints one JSON line.
//   node ops/health-probe.mjs ops/config.json [--max-behind 2]
import {loadConfig} from '../bridge/bridge-service.mjs';
const file=process.argv[2];if(!file){console.error('usage: node ops/health-probe.mjs <config.json> [--max-behind n]');process.exit(2);}
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};const maxBehind=Number(arg('--max-behind',2));
const cfg=await loadConfig(file);const get=async(u,h={})=>{try{const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json()};}catch(e){return {status:0,error:e.message};}};
const idx=await get(cfg.indexerUrl.replace(/\/$/,'')+'/health',cfg.indexerToken?{authorization:'Bearer '+cfg.indexerToken}:{});
const br=await get(`http://${cfg.listen||'127.0.0.1'}:${cfg.httpPort||8975}/health`,cfg.adminToken?{authorization:'Bearer '+cfg.adminToken}:{});
const indexerOk=idx.status===200&&idx.body.ok&&idx.body.invariant&&(idx.body.behind===null||idx.body.behind<=maxBehind)&&!idx.body.lastError;
const bridgeOk=br.status===200&&br.body.ok&&Object.values(br.body.assets||{}).every(a=>!a.halted);
const paused=Object.entries(br.body?.assets||{}).filter(([,a])=>a.paused).map(([s])=>s);
console.log(JSON.stringify({ok:indexerOk&&bridgeOk,indexer:{ok:indexerOk,tip:idx.body?.tip,behind:idx.body?.behind,restarts:idx.body?.restarts,lastError:idx.body?.lastError||idx.error||null},bridge:{ok:bridgeOk,paused,loop:br.body?.loop||null,error:br.error||br.body?.error||null}}));
process.exit(indexerOk&&bridgeOk?0:1);
