import test from 'node:test';
import assert from 'node:assert/strict';
import {jointService,bridgeConnectionMessage} from '../src/joint-service.js';
test('installable bridge profile uses hosted HTTPS for actions and finalized reads',()=>{
 assert.deepEqual(jointService({walletTest:true,privateTest:true}),{endpoint:'https://api.xmr20.org',rpcEndpoint:'https://api.xmr20.org/api/bridge-solana-read'});
});
test('private and local reviews retain their explicit local services',()=>{
 assert.equal(jointService({privateTest:true}).endpoint,'http://127.0.0.1:8933');
 assert.equal(jointService().rpcEndpoint,'http://127.0.0.1:8928/api/solana-read');
});
test('website adapter retains its explicit same-origin endpoint',()=>{
 assert.equal(jointService({walletTest:true,endpoint:''}).endpoint,'');
});
test('network errors explain recovery without hiding protocol validation failures',()=>{
 assert.match(bridgeConnectionMessage(new TypeError('Failed to fetch')),/saved approvals are kept/);
 assert.equal(bridgeConnectionMessage(new Error('Changed bridge deployment.')),'Changed bridge deployment.');
});
