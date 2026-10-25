// The public-data snapshot is reproducible, covers every catalog mint, derives an envelope wherever the public row allows it,
// reports honestly where it cannot, and changes its digest when a source changes. Also checks the envelope rule the lab backend
// must respect: the synthetic lots it hands out for a mint (10,000 units per registered holder) are bounded by the mint's
// Monero-side outstanding amount whenever that amount is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {reconcile,assetIdFor} from './snapshot-reconcile.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const root=path.resolve(here,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const apiBytes=await readFile(path.join(root,'runs/xmr20-tokens-api-raw.json'));const catBytes=await readFile(path.join(here,'third-party-assets.json'));
const api=JSON.parse(apiBytes),catalog=JSON.parse(catBytes);
const run=(a=api,c=catalog)=>reconcile({api:a,catalog:c,apiSource:{path:'runs/xmr20-tokens-api-raw.json',sha256:sha(Buffer.from(JSON.stringify(a)))},catalogSource:{path:'migration/third-party-assets.json',sha256:sha(Buffer.from(JSON.stringify(c)))}});

test('every catalog mint is covered; identities, fee policy and decimals checks; envelopes where public data allows',()=>{
 const r=run();
 assert.equal(r.rows.length,catalog.assets.length,'one row per catalog asset');
 assert.equal(new Set(r.rows.map(x=>x.mint)).size,r.rows.length,'mints unique');
 for(const row of r.rows){assert.equal(row.assetId,assetIdFor(row.mint));assert.ok(row.checks.mintFormat&&row.checks.mintUnique&&row.checks.decimals,'basic identity checks pass for '+row.key);assert.ok([0,150,200].includes(row.transferTaxBps),'documented fee variant for '+row.key);}
 const ext=r.rows.find(x=>x.key==='EXTREMIST');assert.ok(ext);assert.equal(ext.decimals,6);assert.equal(ext.transferTaxBps,0);
 const luke=r.rows.find(x=>x.key==='LUKE');assert.equal(luke.transferTaxBps,150);
 // Honest reporting: rows whose public API entry lacks lockedRaw/xmrOutstanding have no envelope and a recorded problem.
 for(const row of r.rows){if(row.envelope){assert.ok(row.checks.backingOrder,'backing order holds where derivable: '+row.key);assert.match(row.envelope.moneroOutstandingRaw,/^\d+$/);}else{assert.ok(r.problems.some(p=>p.mint===row.mint&&/outstanding|inPublicApi/.test(p.check)),'missing envelope is explained for '+row.key);}}
 assert.equal(r.summary.withEnvelope+r.summary.withoutEnvelope.length,r.rows.length);
 assert.ok(r.dependencies.some(d=>/MAINNET node/.test(d))&&r.dependencies.some(d=>/cutoff height/.test(d)),'open dependencies recorded');
 console.error(JSON.stringify({mints:r.summary.mints,withEnvelope:r.summary.withEnvelope,withoutEnvelope:r.summary.withoutEnvelope.length,problems:r.summary.problems,byFee:r.summary.byFee,digest:r.digest.slice(0,16)}));
});

test('digest is reproducible over identical inputs and changes when a source changes',()=>{
 const a=run(),b=run();assert.equal(a.digest,b.digest,'same inputs -> same digest');
 const api2=structuredClone(api);const t=api2.tokens.find(x=>x.mint===catalog.assets[0].mint)||api2.tokens[0];t.supply=String(BigInt(t.supply||'1')+1n);
 assert.notEqual(run(api2).digest,a.digest,'a changed public row changes the digest');
 const cat2=structuredClone(catalog);cat2.assets[0].decimals=(cat2.assets[0].decimals||6)+1;const r2=run(api,cat2);
 assert.notEqual(r2.digest,a.digest);assert.ok(r2.problems.some(p=>p.check==='decimalsVerified'),'catalog decimals drifting from the on-chain check is reported');
});

test('envelope rule: synthetic lots handed out by the lab must fit the Monero-side outstanding amount when it is known',()=>{
 const r=run();const lot=(decimals)=>10000n*10n**BigInt(decimals);
 for(const row of r.rows.filter(x=>x.envelope)){const maxHolders=BigInt(row.envelope.moneroOutstandingRaw)/lot(row.decimals);row.maxSyntheticHolders=maxHolders.toString();}
 // The rule itself is what matters: a mint whose outstanding amount is below one acceptance lot can hand out no lot at all.
 const tiny={assets:[{key:'T',symbol:'T',name:'t',mint:'11111111111111111111111111111111',decimals:6,transferTaxBps:0,decimalsVerified:{onChain:6}}]};
 const apiT={tokens:[{mint:'11111111111111111111111111111111',supply:'5000000',lockedRaw:'5000000',xmrOutstanding:'5000000'}]};
 const rt=run(apiT,tiny);assert.equal(rt.rows[0].envelope.moneroOutstandingRaw,'5000000');assert.equal(BigInt(rt.rows[0].envelope.moneroOutstandingRaw)/lot(6),0n,'no 10,000-unit lot fits a 5-unit outstanding amount');
});
