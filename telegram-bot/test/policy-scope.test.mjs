import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {policiesForCredential} from '../src/pilot-preflight.mjs';
import {matchesPolicySet} from '../src/registration.mjs';
const own={userId:'11111111-1111-4111-8111-111111111111',apiPublicKey:'02'+'11'.repeat(32)};
const other={userId:'22222222-2222-4222-8222-222222222222',apiPublicKey:'03'+'22'.repeat(32)};
const row=identity=>({effect:'EFFECT_ALLOW',consensus:`credentials.any(c, c.user_id == '${identity.userId}' && c.public_key == '${identity.apiPublicKey}')`,condition:"activity.type == 'ACTIVITY_TYPE_CREATE_WALLET'"});
test('unrelated exact credentials preserve original reviewed rows, order and digest',()=>{
 const a=row(own),b={...a,condition:'specific signing rule'},expected=[b,a],actual=[row(other),b,a];
 const filtered=policiesForCredential(actual,own);
 assert.deepEqual(filtered,expected);assert.equal(filtered[0],b);assert.equal(matchesPolicySet(filtered,expected),true);
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 assert.equal(hash(filtered),hash(expected));
});
test('overlapping identity or key is never ignored',()=>{
 for(const identity of [{...other,userId:own.userId},{...other,apiPublicKey:own.apiPublicKey}])assert.throws(()=>policiesForCredential([row(identity)],own),/PILOT_POLICY_SCOPE/);
});
test('broad, alternative and unfamiliar consensus predicates fail closed',()=>{
 for(const consensus of ['true',row(other).consensus+' || true',row(other).consensus.replace(' && ',' || '),'credentials.any(c, c.user_id != \'x\')',null])assert.throws(()=>policiesForCredential([{...row(other),consensus}],own),/PILOT_POLICY_SCOPE/);
});
test('extra, duplicate, timed or changed own policies still fail exact policy review',()=>{
 const a=row(own);
 for(const actual of [[a,{...a,condition:'true'}],[a,a],[{...a,time:'true'}],[{...a,effect:'EFFECT_DENY'}]])assert.equal(matchesPolicySet(policiesForCredential(actual,own),[a]),false);
});
