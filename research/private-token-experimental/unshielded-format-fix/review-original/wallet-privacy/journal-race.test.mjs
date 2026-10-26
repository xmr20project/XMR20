// Narrow review reproduction; imports the candidate unchanged. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateJournal,JOURNAL_KEY,SALT_KEY} from '../../wallet-extension/src/private-journal.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('two independent popups can both reserve the same note and lose one successful write',async()=>{
 const db=new Map([[SALT_KEY,Buffer.alloc(32,7).toString('base64')]]);
 const lock=JOURNAL_KEY+'-lease';
 const bothReadEmptyLease=deferred(),aReadJournal=deferred(),bReadJournal=deferred(),aWriteDone=deferred();
 let leaseReaders=0;
 const events=[];
 function storeFor(actor){let firstLease=true,firstJournal=true;return {
  async get(k){
   const snapshot=structuredClone(db.get(k));
   if(k===lock && firstLease){firstLease=false;events.push(`${actor}: lease initially empty`);if(++leaseReaders===2)bothReadEmptyLease.resolve();await bothReadEmptyLease.promise;return snapshot;}
   if(k===JOURNAL_KEY && firstJournal){firstJournal=false;events.push(`${actor}: read old journal`);if(actor==='A')aReadJournal.resolve();else bReadJournal.resolve();return snapshot;}
   return snapshot;
  },
  async set(k,v){
   if(k===lock && v && actor==='B')await aReadJournal.promise;
   if(k===JOURNAL_KEY){if(actor==='A')await bReadJournal.promise;else await aWriteDone.promise;events.push(`${actor}: write encrypted journal`);}
   db.set(k,structuredClone(v));
  }
 };}
 const opts=actor=>({store:storeFor(actor),subtle:webcrypto.subtle,random:b=>webcrypto.getRandomValues(b)});
 const a=createPrivateJournal(opts('A')),b=createPrivateJournal(opts('B'));
 await Promise.all([a.unlock('synthetic-review-password'),b.unlock('synthetic-review-password')]);
 function reserve(actor){return j=>{const acc=j.accounts.synthetic??={pending:{},claims:{},history:[]};
  assert.equal(Object.values(acc.pending).some(p=>p.reserved.includes('same-token-note')),false,`${actor} should reject an existing reservation`);
  acc.pending[actor]={status:'selected',reserved:['same-token-note']};events.push(`${actor}: reservation check passed`);return j;
 };}
 const pa=a.write(reserve('A')).then(x=>{events.push('A: write returned success');aWriteDone.resolve();return x;});
 const pb=b.write(reserve('B')).then(x=>{events.push('B: write returned success');return x;});
 const results=await Promise.allSettled([pa,pb]);
 assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled']);
 const final=await a.read();
 assert.deepEqual(Object.keys(final.accounts.synthetic.pending),['B']);
 console.log(JSON.stringify({bothReservationsReportedSuccess:true,remainingReservations:Object.keys(final.accounts.synthetic.pending),lostReservation:'A',events},null,2));
});
