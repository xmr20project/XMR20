// CUTOFF BOUNDARIES AND ROLLBACKS AROUND THE CUTOVER on the ISOLATED copy of the shipping legacy indexer (stagenet-roles lab:
// legacy/cutover-indexer.mjs over the XN1 replay). Pure in-process replay, no chain, no network. Complements
// legacy-migration.test.mjs (claims, duplicates, late registrant, interrupted migration through the private pool) by pinning the
// legacy-side rules the successor relies on:
//   - rights are fixed at the checkpoint; a MOVE before it moves the right, a MOVE after it is visible but never honoured;
//   - a reorganisation BELOW the checkpoint is refused by the cutover indexer (it would require migration suspension and a full
//     reconciliation — the checkpoint cannot silently change); a reorganisation at or above it is processed normally;
//   - the rights snapshot (and therefore the registry id every claim is bound to) is unchanged by activity after the checkpoint.
// No cutoff height is chosen here; the fixture heights are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLegacy,legacyMove,claim,Registry,snapshotId} from '../../privacy-stagenet-roles-20261023-lab/migration.mjs';
import {syntheticWallet,HolderSigner,randomScalar} from '../../privacy-stagenet-roles-20261023-lab/signer.mjs';
import {CutoverIndexer} from '../../privacy-stagenet-roles-20261023-lab/legacy/cutover-indexer.mjs';
import {fixtureManifest} from '../../privacy-stagenet-roles-20261023-lab/legacy/xn1/test-fixtures.mjs';
import {EXPIRING_CREDIT_PROFILE} from '../../privacy-stagenet-roles-20261023-lab/legacy/xn1/records.mjs';
const ADDR='penumbra1'+'q'.repeat(20);
const manifest=()=>({...fixtureManifest(),cap:100000000000000000n,profile:EXPIRING_CREDIT_PROFILE,identity:0xfc});
function holders(){const a=new HolderSigner(syntheticWallet()),b=new HolderSigner(syntheticWallet()),c=new HolderSigner(syntheticWallet());const r=randomScalar();return {a,b,c,Pa:a.receive(r,0),Pb:b.receive(r,1),Pc:c.receive(r,2)};}
const x=(s,P)=>s.secretForTest(P);

test('rollback below the cutover checkpoint is refused; at/above it is processed; the rights snapshot id is stable',()=>{
 const h=holders(),ix=new CutoverIndexer(manifest());const legacy=buildLegacy([{pub:h.Pa,amount:500n},{pub:h.Pb,amount:300n}],{indexer:ix});
 const stateBefore=ix.index.snapshot();const checkpointHeight=Number(stateBefore.height);
 const snap=ix.cutover();const reg=new Registry(snap);const id=snapshotId(snap);
 assert.equal(ix.checkpoint.height,checkpointHeight);assert.equal(reg.unclaimed(),800n);
 // Below the checkpoint: refused with the documented reason (no silent re-pointing of the cutoff).
 assert.throws(()=>ix.rewind(checkpointHeight-1,'00'.repeat(32)),/migration suspension/);
 // The refusal changed nothing: same rights, same registry id.
 assert.equal(snapshotId(ix.rights),id);assert.equal(ix.index.snapshot().height,stateBefore.height);
 // Activity after the checkpoint (a MOVE by b) is accepted by the old replay and logged as post-cutoff, never honoured…
 const freshA=h.a.receive(randomScalar(),7);const post=legacyMove(legacy,legacy.credits.find(c=>c.P===h.Pb),x(h.b,h.Pb),freshA,41);
 assert.equal(post.status,'accepted');assert.equal(ix.postCutoffActivity.length,1);assert.equal(ix.postCutoffActivity[0].honoured,false);
 const afterPost=ix.index.snapshot();assert.ok(afterPost.height>stateBefore.height,'post-cutoff block applied above the checkpoint');
 // …and a rollback AT the checkpoint (removing the post-cutoff block; the ancestor is the checkpoint block itself) is processed normally.
 ix.rewind(stateBefore.height,stateBefore.blockHash);assert.equal(ix.index.snapshot().height,stateBefore.height);
 assert.equal(snapshotId(ix.rights),id,'rights snapshot unchanged by the rollback');assert.equal(reg.unclaimed(),800n);
 // b's right (300) is still claimable with b's key after the rollback; the moved-away live balance never affected the right.
 const row=snap.rows.find(r=>r.legacyOwner===h.Pb);const c=claim(snap,row,(m,P)=>h.b.sign(m,P),ADDR);assert.equal(reg.verify(c).amount,'300');
 reg.consume(c.body.claim,{});assert.throws(()=>reg.verify(c),/already consumed/,'no second claim of the same right');
 // a late registrant (fresh key after the checkpoint) owns nothing in the snapshot.
 assert.equal(snap.rows.some(r=>r.legacyOwner===freshA),false);
});

test('a second cutover cannot be declared and a claim bound to another snapshot id is refused',()=>{
 const h=holders(),ix=new CutoverIndexer(manifest());buildLegacy([{pub:h.Pa,amount:500n}],{indexer:ix});
 const snap=ix.cutover();assert.throws(()=>ix.cutover(),/already declared/);
 const h2=holders();const other=new CutoverIndexer(manifest());buildLegacy([{pub:h2.Pa,amount:500n}],{indexer:other});const snap2=other.cutover();
 assert.notEqual(snapshotId(snap2),snapshotId(snap),'different lots -> different snapshot ids');
 const reg=new Registry(snap);const c=claim(snap2,snap2.rows[0],(m,P)=>h2.a.sign(m,P),ADDR);
 assert.throws(()=>reg.verify(c),/snapshot|Unknown claim|signature/i,'a claim made against another snapshot is refused');
});
