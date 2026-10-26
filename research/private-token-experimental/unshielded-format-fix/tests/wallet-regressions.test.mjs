// M2 + M3 + L2 REGRESSIONS against the fixed wallet modules. Deterministic, synthetic, no browser: the journal uses the actual
// module with real WebCrypto and an injected exclusive-lock implementation with Web Locks semantics (the extension uses
// navigator.locks); the reservation rules are exercised through the exported transition functions the popup now calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateJournal,JOURNAL_KEY,SALT_KEY} from '../wallet-extension/src/private-journal.js';
import {reservedTokens,reservedNative,carrierOutcomeTransition,canAbandon,needsCarrier} from '../wallet-extension/src/token-format.js';
import {xmr,xmrApprox} from '../wallet-extension/src/holder-carrier.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Web Locks semantics in memory: one exclusive holder per name; the next request waits for the previous callback to settle.
function memoryLocks(){const tails=new Map();const log=[];return {log,async request(name,opts,fn){if(typeof opts==='function'){fn=opts;}const prev=tails.get(name)||Promise.resolve();let release;const mine=new Promise(r=>{release=r;});tails.set(name,prev.then(()=>mine));await prev;log.push('acquire');try{return await fn({name,mode:'exclusive'});}finally{log.push('release');release();}}};}
const memStore=(db=new Map([[SALT_KEY,Buffer.alloc(32,7).toString('base64')]]))=>({db,async get(k){return structuredClone(db.get(k));},async set(k,v){db.set(k,structuredClone(v));}});
const opts=(store,locks)=>({store,subtle:webcrypto.subtle,random:b=>webcrypto.getRandomValues(b),locks});
const reserve=(actor,{delay=0,crash=false}={})=>async j=>{const acc=j.accounts.synthetic??={pending:{},claims:{},history:[]};if(delay)await sleep(delay);
 if(Object.values(acc.pending).some(p=>p.reserved.includes('same-token-note')))throw Error(actor+': note already reserved by another window');
 if(crash)throw Error(actor+': simulated crash inside the critical section');acc.pending[actor]={status:'selected',reserved:['same-token-note']};return j;};

test('M2: two contexts cannot both reserve the same note; the second sees the first write and is refused; nothing is lost',async()=>{
 const store=memStore();const locks=memoryLocks();
 const a=createPrivateJournal(opts(store,locks)),b=createPrivateJournal(opts(store,locks));
 assert.equal(a.exclusionMode,'web-locks');
 await Promise.all([a.unlock('synthetic-review-password'),b.unlock('synthetic-review-password')]);
 const pa=a.write(reserve('A',{delay:60}));await sleep(5);const pb=b.write(reserve('B'));
 const results=await Promise.allSettled([pa,pb]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/already reserved/);
 const final=await b.read();assert.deepEqual(Object.keys(final.accounts.synthetic.pending),['A']);
 assert.deepEqual(locks.log,['acquire','release','acquire','release'],'strictly serialized critical sections');
});
test('M2: a crash inside the critical section releases the lock; the other context proceeds; a reopened context reads the final state',async()=>{
 const store=memStore();const locks=memoryLocks();
 const a=createPrivateJournal(opts(store,locks)),b=createPrivateJournal(opts(store,locks));
 await Promise.all([a.unlock('pw'),b.unlock('pw')]);
 const pa=a.write(reserve('A',{delay:30,crash:true}));await sleep(5);const pb=b.write(reserve('B'));
 const r=await Promise.allSettled([pa,pb]);assert.equal(r[0].status,'rejected');assert.equal(r[1].status,'fulfilled');
 const c=createPrivateJournal(opts(store,locks));await c.unlock('pw');const j=await c.read();assert.deepEqual(Object.keys(j.accounts.synthetic.pending),['B']);
 // a slow holder: the waiter is delayed, not bypassed
 const t0=Date.now();const pc=c.write(async j=>{await sleep(120);j.accounts.synthetic.pending.B.status='quoted';return j;});await sleep(5);await a.write(j=>{assert.equal(j.accounts.synthetic.pending.B.status,'quoted','waiter saw the slow holder\'s write');return j;});await pc;assert.ok(Date.now()-t0>=120);
});
test('M2: without a lock implementation writes are refused; the lease fallback exists only by explicit opt-in',async()=>{
 const j=createPrivateJournal({...opts(memStore(),null),locks:null});assert.equal(j.exclusionMode,'refused');await j.unlock('pw');await assert.rejects(j.write(x=>x),/no cross-context exclusive lock/);
 const k=createPrivateJournal({...opts(memStore(),null),locks:null,allowLeaseFallback:true});assert.equal(k.exclusionMode,'lease-fallback');
});

const op=()=>({kind:'private',inputKind:'shielded',status:'partial',reserved:['shielded-note'],wires:['part-A','part-B'],recordIds:['A','B'],nativeInputs:['KI-A','KI-B'],carriers:[{status:'published',keyImage:'KI-A',blob:'a'},{status:'signed',keyImage:'KI-B',blob:'b'}]});
test('M3: refusal or conflict of the second carrier keeps the operation partial and reserved; it stays continuable, not abandonable',()=>{
 for(const pub of [{ok:false,reason:'fee too low'},{ok:false,doubleSpend:true},{ok:false,uncertain:true}]){
  const q=op();carrierOutcomeTransition(q,1,pub);const account={pending:{q}};
  assert.equal(q.status,'partial',JSON.stringify(pub));assert.equal(q.carriers[0].status,'published');
  assert.equal(reservedTokens(account).has('shielded-note'),true,'token reservation held');
  assert.equal(reservedNative(account).has('KI-A'),true);assert.equal(reservedNative(account).has('KI-B'),true);
  assert.equal(canAbandon(q),false,'A is on chain: cannot abandon');
  assert.equal(needsCarrier(q),!pub.uncertain,'refused/conflicted carriers can be replaced; an uncertain one is looked up first');
 }
 // when NO carrier is on chain, refusal makes the operation refused and abandonable (inputs released on abandonment)
 const q=op();q.carriers[0]={status:'signed',keyImage:'KI-A',blob:'a'};carrierOutcomeTransition(q,0,{ok:false,reason:'refused'});
 assert.equal(q.status,'refused');assert.equal(canAbandon(q),true);assert.equal(needsCarrier(q),true);
 // after a replacement carrier for B publishes, the operation is fully published
 const q2=op();carrierOutcomeTransition(q2,1,{ok:false,reason:'x'});carrierOutcomeTransition(q2,1,{ok:true});assert.equal(q2.status,'published');assert.equal(reservedTokens({pending:{q2}}).has('shielded-note'),true);
 // in flight: never abandonable
 const q3=op();q3.carriers[0].status='broadcasting';q3.status='signed';assert.equal(canAbandon(q3),false);
});
test('L2: approval amounts are exact piconero values; the compact display is marked approximate',()=>{
 assert.equal(xmr(49_520_000n),'0.00004952');assert.equal(xmr(49_520_000n+2_071_200_000n),'0.00212072');
 assert.equal(xmr(1n),'0.000000000001');assert.equal(xmr(1_000_000_000_000n),'1');assert.equal(xmr(0n),'0');
 const shownPiconero=BigInt(xmr(49_520_000n).replace('.','').padEnd(13,'0'));assert.equal(shownPiconero,49_520_000n,'display round-trips to the quote');
 assert.equal(xmrApprox(49_520_000n),'≈0.000049');assert.equal(xmrApprox(49_000_000n),'0.000049');
});
