// Journal unit test (Node, WebCrypto): encryption round trip, password binding,
// lost-update protection for concurrent writes in one window and across two
// journal instances sharing one store (two popups), reservation accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateJournal,reservedCommitments,JOURNAL_KEY} from './wallet-extension/src/private-journal.js';
const makeStore=()=>{const m=new Map();const tick=()=>new Promise(r=>setTimeout(r,Math.random()*3));return {async get(k){await tick();return m.has(k)?JSON.parse(JSON.stringify(m.get(k))):undefined;},async set(k,v){await tick();m.set(k,JSON.parse(JSON.stringify(v)));},map:m};};
test('journal: round trip, wrong password, concurrent writes keep every update',async()=>{
 const store=makeStore();const j=createPrivateJournal({store});await j.unlock('pw-one');
 const addr='penumbra1test';
 await j.write(x=>{j.account(x,addr).pending.op1={status:'selected',reserved:['aa'],created:1};});
 assert.equal((await j.read()).accounts[addr].pending.op1.status,'selected');
 assert.ok(!JSON.stringify(store.map.get(JOURNAL_KEY)).includes('selected'),'ciphertext does not expose the plaintext');
 // One window: heartbeat writes racing the 'built' write must not revert it.
 const beats=[];for(let i=0;i<5;i++)beats.push(j.write(x=>{const p=j.account(x,addr).pending.op1;if(p&&p.status==='selected')p.heartbeat=Date.now();}));
 const built=j.write(x=>{Object.assign(j.account(x,addr).pending.op1,{status:'built',wire:'ff'});});
 beats.push(j.write(x=>{const p=j.account(x,addr).pending.op1;if(p&&p.status==='selected')p.heartbeat=Date.now();}));
 await Promise.all([...beats,built]);
 const after=(await j.read()).accounts[addr].pending.op1;assert.equal(after.status,'built');assert.equal(after.wire,'ff');
 // Two instances (two popups) on the same store: interleaved writes keep both operations.
 const k=createPrivateJournal({store});await k.unlock('pw-one');
 await Promise.all([j.write(x=>{j.account(x,addr).pending.opA={status:'selected',reserved:['bb'],created:2};}),k.write(x=>{k.account(x,addr).pending.opB={status:'selected',reserved:['cc'],created:3};}),j.write(x=>{j.account(x,addr).pending.opC={status:'selected',reserved:['dd'],created:4};})]);
 const both=(await k.read()).accounts[addr].pending;assert.deepEqual(Object.keys(both).sort(),['op1','opA','opB','opC']);
 assert.deepEqual([...reservedCommitments({pending:both})].sort(),['aa','bb','cc','dd']);assert.deepEqual([...reservedCommitments({pending:both},'opB')].sort(),['aa','bb','dd']);
 // Wrong password cannot read; lock drops the key.
 const w=createPrivateJournal({store});await w.unlock('pw-two');await assert.rejects(w.read(),/could not be read/);
 j.lock();await assert.rejects(j.read(),/locked/);
});
