import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {patchMarketWorker} from '../patch-market-worker.mjs';
const source=await readFile(new URL('../services/native-market/frontend/native-market-worker.js',import.meta.url),'utf8');
test('packaged market worker pins service origin and transport before runtime construction',()=>{
 const out=patchMarketWorker(source);
 assert(out.includes("const {createMarketFetch,MARKET_ORIGIN}=await import('./transport.js');"));
 assert(out.includes('createInstalledMarketRuntime({origin:MARKET_ORIGIN,fetchImpl:createMarketFetch(),'));
 assert(out.includes('data.args.seed ='));assert(out.includes('Only fixed product')||out.includes('Only fixed'));
});
test('market worker packaging rejects missing, ambiguous and already patched bootstraps',()=>{
 for(const value of ['',source+source,patchMarketWorker(source),null])assert.throws(()=>patchMarketWorker(value),/bootstrap changed/);
});
