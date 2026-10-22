import test from 'node:test';
import assert from 'node:assert/strict';
import {launchAvailability} from '../src/launch-availability.mjs';
test('known paused catalog retains the backend pause while allowing account recovery',()=>{
 const catalog={enabled:false,network:'mainnet-beta',oneApprovalEnabled:true};
 assert.equal(launchAvailability(catalog),false);assert.equal(catalog.enabled,false);
 assert.equal(launchAvailability({...catalog,enabled:true}),true);
});
test('untrusted, missing or wrong-network catalog cannot connect the financial bot',()=>{
 for(const catalog of [null,{}, {enabled:true,network:'devnet',oneApprovalEnabled:true},{enabled:false,network:'mainnet-beta',oneApprovalEnabled:false},{enabled:'true',network:'mainnet-beta',oneApprovalEnabled:true}])assert.throws(()=>launchAvailability(catalog),/LAUNCH_UNAVAILABLE/);
});
