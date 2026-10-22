import test from 'node:test';import assert from 'node:assert/strict';
import {MONERO_NODES,DEFAULT_MONERO_NODE,normalizeMoneroNode,preferredMoneroNode,moneroNodeLabel,moneroNodeHost,scanProgress,scanEtaLabel} from '../src/monero-node.js';
import {normalizePreferences,MONERO_NODE_POLICY_VERSION} from '../src/preferences.js';
import {readFileSync} from 'node:fs';
test('only the fixed nodes can be selected and they match the worker allowlist and manifest policy',()=>{
 assert.equal(normalizeMoneroNode(undefined),DEFAULT_MONERO_NODE);assert.equal(normalizeMoneroNode('https://evil.example'),DEFAULT_MONERO_NODE);
 for(const n of MONERO_NODES)assert.equal(normalizeMoneroNode(n.url),n.url);
 const worker=readFileSync(new URL('../extension/vendor/native.worker.js',import.meta.url),'utf8');
 const allow=worker.match(/const NODES=\[([^\]]*)\]/)[1].match(/'[^']+'/g).map(s=>s.slice(1,-1));
 assert.deepEqual([...allow].sort(),MONERO_NODES.map(n=>n.url).sort());
 const manifest=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
 for(const n of MONERO_NODES){assert.ok(manifest.content_security_policy.extension_pages.includes(new URL(n.url).origin),n.url+' connect-src');assert.ok(manifest.host_permissions.some(p=>p.startsWith('https://'+new URL(n.url).hostname+'/')),n.url+' host permission');}
 assert.equal(DEFAULT_MONERO_NODE,'https://api.xmr20.org/monero');assert.equal(moneroNodeLabel(DEFAULT_MONERO_NODE),'XMR20 node');assert.equal(moneroNodeHost('https://xmr-node.cakewallet.com:18081'),'xmr-node.cakewallet.com:18081');
});
test('current preference wins over previous checkpoint node and missing preferences use our node',()=>{
 assert.equal(preferredMoneroNode({}),DEFAULT_MONERO_NODE);
 for(const n of MONERO_NODES)assert.equal(preferredMoneroNode({moneroNode:n.url,scanNode:MONERO_NODES.at(-1).url}),n.url);
 const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
 assert.match(app,/const nodeFor=\(\)=>preferredMoneroNode\(preferences\)/);
 assert.match(app,/restoreHeight:a.height,node:nodeFor\(\),cache:saved\?\.cache/);
});
test('preferences carry the node choice alongside auto-lock and never drop either',()=>{
 const p=normalizePreferences({autoLockMinutes:30,moneroNode:MONERO_NODES[1].url,moneroNodePolicy:MONERO_NODE_POLICY_VERSION});
 assert.deepEqual(p,{autoLockMinutes:30,moneroNode:MONERO_NODES[1].url,moneroNodePolicy:MONERO_NODE_POLICY_VERSION});
 assert.deepEqual(normalizePreferences({autoLockMinutes:30}),{autoLockMinutes:30,moneroNode:DEFAULT_MONERO_NODE,moneroNodePolicy:MONERO_NODE_POLICY_VERSION});
 assert.deepEqual(normalizePreferences({...p,autoLockMinutes:5}),{autoLockMinutes:5,moneroNode:MONERO_NODES[1].url,moneroNodePolicy:MONERO_NODE_POLICY_VERSION});
});
test('old unversioned node settings migrate to own node once and later public selections survive reopening',()=>{
 for(const oldNode of MONERO_NODES.slice(1)){
  const migrated=normalizePreferences({autoLockMinutes:60,moneroNode:oldNode.url});
  assert.equal(migrated.moneroNode,DEFAULT_MONERO_NODE);assert.equal(migrated.autoLockMinutes,60);
  const chosen=normalizePreferences({...migrated,moneroNode:oldNode.url});
  assert.equal(normalizePreferences(JSON.parse(JSON.stringify(chosen))).moneroNode,oldNode.url);
 }
});
test('scan progress reports exact percentages, blocks left and a rate-based estimate',()=>{
 const started=1000;
 assert.deepEqual(scanProgress({height:150,target:200,start:100,startedAt:started,now:started+10000}),{percent:50,left:50,done:50,total:100,eta:10});
 assert.equal(scanProgress({height:200,target:200,start:100,startedAt:started,now:started+5000}).percent,100);
 assert.equal(scanProgress({height:100,target:200,start:100,startedAt:started,now:started+500}).eta,null);
 assert.equal(scanProgress({height:'x',target:200}),null);
 // Without a known scan start nothing can be counted as done yet.
 assert.deepEqual(scanProgress({height:150,target:200,start:undefined,startedAt:started,now:started+1000}),{percent:0,left:50,done:0,total:50,eta:null});
 // Heights below the start (hash-list phase) count as nothing done and the full range left.
 assert.deepEqual(scanProgress({height:1,target:200,start:100,startedAt:started,now:started+1000}),{percent:0,left:100,done:0,total:100,eta:null});
 assert.equal(scanEtaLabel(30),'under a minute');assert.equal(scanEtaLabel(61),'about 2 min');assert.equal(scanEtaLabel(3700),'about 1 h 2 min');assert.equal(scanEtaLabel(-1),'');
});
