// Writes the shipped parameter manifest (format XMR20-PARAMS-1) for one
// parameter directory produced by `xmr20-integration-lab setup`.
//   node params/make-manifest.mjs params/test-v1 "DISPOSABLE TEST SETUP"
// The manifest is the holder-side TRUST ANCHOR for proving/verifying
// parameters: it is copied into the extension build (vendor/parameters-
// manifest.json) and its sha256 is compiled into the holder worker bundle.
// Every parameter file is authenticated against it before deserialization.
// A checksum served by the parameter server is never consulted.
//
// These are DISPOSABLE TEST parameters (unreviewed, single-party setup on this
// machine). Authenticating them makes the distribution path testable; it does
// not make the setup production-safe. See PARAMETERS.txt.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [dir,label='DISPOSABLE TEST SETUP — NOT PRODUCTION']=process.argv.slice(2);
if(!dir)throw Error('usage: make-manifest.mjs <params dir> [label]');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paramsJson=await readFile(path.join(dir,'parameters.json'));
const config=JSON.parse(paramsJson);
for(const k of ['chain','domain','normal_vk','boundary_vk','issuer_vk'])if(typeof config[k]!=='string')throw Error('parameters.json missing '+k);
const files={};
for(const [name,circuit] of [['normal','XM3 private transfer: 3 Penumbra spends, 2 outputs (Groth16, BLS12-377)'],['boundary','XB3 boundary record: 3 spends, 1 output, public amount+asset (Groth16, BLS12-377)']]){
 const file=path.join(dir,name+'.public-pk');const bytes=await readFile(file);
 files[name]={path:name+'.public-pk',circuit,bytes:bytes.length,sha256:sha(bytes),vk:config[name+'_vk']};
}
const manifest={
 format:'XMR20-PARAMS-1',
 label,
 warning:'Synthetic single-machine Groth16 setup for an offline test chain. Not reviewed, not a ceremony, never for real funds.',
 protocol:{scheme:'XMR20-TKD1',domainLabel:'XMR20-MIGRATION-REHEARSAL-DOMAIN-v1',records:{transfer:{magic:'XM3',bytes:996,inputs:3,outputs:2},boundary:{magic:'XB3',bytes:925,inputs:3,outputs:1}}},
 network:{kind:'offline-fakechain',genesis:config.chain},
 ledgerDomain:config.domain,
 issuerVk:config.issuer_vk,
 config,
 parametersJson:{path:'parameters.json',bytes:paramsJson.length,sha256:sha(paramsJson)},
 files,
 generated:{at:(await stat(path.join(dir,'normal.public-pk'))).mtime.toISOString(),by:'research/privacy-integration-20261022 xmr20-integration-lab setup (ark-groth16 generate_random_parameters, OsRng)',directory:path.basename(dir)},
};
await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,1)+'\n');
console.log(JSON.stringify({dir,manifestSha256:sha(await readFile(path.join(dir,'manifest.json'))),files:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,{bytes:v.bytes,sha256:v.sha256}])),domain:config.domain}));
