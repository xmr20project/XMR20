// OPERATOR JOURNAL: the only stateful component in the bridge path. A corrupted or truncated journal must REFUSE to open
// (never silently reset to an empty state, which would forget paid payouts and consumed claims); a journal of another asset
// is refused; writes are atomic (temp file + fsync + rename) so a crash leaves either the old or the new file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Operator} from '../../privacy-integration-20261022/operator.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const asset='11'.repeat(32),other='22'.repeat(32);
test('corrupted operator journal refuses to open; atomic writes; asset binding',async()=>{
 const run=await mkdtemp(path.join(dir,'runs','operator-journal-'));const file=path.join(run,'operator.json');
 const op=await Operator.open({file,bridge:null,node:null,registry:null,asset});op.state.payouts['ab'.repeat(32)]={amount:'5',binding:'x',status:'paid'};await op.persist();
 const again=await Operator.open({file,bridge:null,node:null,registry:null,asset});assert.equal(again.state.payouts['ab'.repeat(32)].status,'paid','round trip keeps the paid payout');
 assert.equal((await readdir(run)).filter(f=>f.includes('.pending-')).length,0,'no temp file left behind');
 await assert.rejects(Operator.open({file,bridge:null,node:null,registry:null,asset:other}),/another asset/,'journal bound to its asset');
 const good=await readFile(file,'utf8');await writeFile(file,good.slice(0,Math.floor(good.length/2)));
 await assert.rejects(Operator.open({file,bridge:null,node:null,registry:null,asset}),/JSON|Unexpected|token/i,'truncated journal refuses to open (no silent reset)');
 await writeFile(file,'{"version":2,"asset":"'+asset+'","halted":false');await assert.rejects(Operator.open({file,bridge:null,node:null,registry:null,asset}));
 await writeFile(file,good);const back=await Operator.open({file,bridge:null,node:null,registry:null,asset});assert.equal(back.state.payouts['ab'.repeat(32)].status,'paid','restored backup opens');
});
