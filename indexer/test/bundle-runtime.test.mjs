import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('bundled ledger preserves an RPC exception stack in a fresh Node process',()=>{
 const entry=new URL('../build/ledger.mjs',import.meta.url).href;
 const code=`const {readClient}=await import(${JSON.stringify(entry)});try{await readClient('https://example.invalid',async()=>{throw Error('synthetic-network-failure');})('getGenesisHash');}catch(e){if(!e.stack.includes('synthetic-network-failure'))process.exit(2);console.log('exception-preserved');}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:20000});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'exception-preserved');
});
