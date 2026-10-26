// Builds the XMR20-PARAMS-1 trusted manifest for a parameter directory produced by the CEREMONY REHEARSAL tool (ceremony/).
// Same schema as the lab's manifests (the roles and the holder authenticate every file against it), plus a `ceremony` section
// that binds the manifest to the rehearsal attestation: R1CS digests, degrees, contribution hashes and the attestation's sha256.
// Usage: node ceremony/make-manifest.mjs <params dir> --network-kind offline-fakechain|stagenet [--start-height N] [--out file]
// The label and warning always say REHEARSAL/DISPOSABLE: this generator cannot produce a production manifest.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const argv=process.argv.slice(2);const flag=(k)=>{const i=argv.indexOf('--'+k);if(i<0)return null;const v=argv[i+1];argv.splice(i,2);return v;};
const kind=flag('network-kind')||'offline-fakechain';const startHeight=Number(flag('start-height')||0);const outFile=flag('out');
if(!['offline-fakechain','stagenet'].includes(kind))throw Error('--network-kind must be offline-fakechain or stagenet (never mainnet from this tool)');
const [dir]=argv;if(!dir)throw Error('usage: make-manifest.mjs <params dir> --network-kind …');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paramsJson=await readFile(path.join(dir,'parameters.json'));const config=JSON.parse(paramsJson);
const attestationBytes=await readFile(path.join(dir,'attestation.json'));const attestation=JSON.parse(attestationBytes);
if(!/REHEARSAL/.test(attestation.status||''))throw Error('attestation.json is not a rehearsal attestation');
if(attestation.parametersJson?.sha256!==sha(paramsJson))throw Error('attestation.json does not describe this parameters.json');
const files={};
for(const [name,circuit] of [['normal','XM3 private transfer: 3 Penumbra spends, 2 outputs (Groth16, BLS12-377)'],['boundary','XB3 boundary record: 3 spends, 1 output, public amount+asset (Groth16, BLS12-377)']]){
 const bytes=await readFile(path.join(dir,name+'.public-pk'));const c=attestation.circuits.find(x=>x.name===name);
 if(!c||c.output?.pk_sha256!==sha(bytes))throw Error(name+'.public-pk does not match the attestation');
 files[name]={path:name+'.public-pk',circuit,bytes:bytes.length,sha256:sha(bytes),vk:config[name+'_vk']};
}
const manifest={format:'XMR20-PARAMS-1',label:'CEREMONY REHEARSAL — DISPOSABLE PARAMETERS — NOT PRODUCTION',
 warning:'Groth16 parameters from the multi-party setup REHEARSAL (ceremony/): contributions by processes on one machine, zero independent participants. Same trust status as a single-party setup. Never for real funds.',
 protocol:{scheme:'XMR20-TKD1',domainLabel:'XMR20-MIGRATION-REHEARSAL-DOMAIN-v1',records:{transfer:{magic:'XM3',bytes:996,inputs:3,outputs:2},boundary:{magic:'XB3',bytes:925,inputs:3,outputs:1}}},
 network:{kind,genesis:config.chain,...(startHeight?{startHeight}:{})},ledgerDomain:config.domain,issuerVk:config.issuer_vk,config,
 parametersJson:{path:'parameters.json',bytes:paramsJson.length,sha256:sha(paramsJson)},files,
 ceremony:{attestation:{path:'attestation.json',bytes:attestationBytes.length,sha256:sha(attestationBytes)},status:attestation.status,independentParticipants:attestation.independentParticipants,
  circuits:attestation.circuits.map(c=>({name:c.name,degree:c.degree,constraints:c.constraints,r1csDigest:c.r1csDigest,phase1Contributions:c.phase1.contributions.length,phase1Last:c.phase1.contributions.at(-1)?.hash,phase2Contributions:c.phase2.contributions.length,phase2Last:c.phase2.contributions.at(-1)?.hash}))},
 generated:{at:(await stat(path.join(dir,'normal.public-pk'))).mtime.toISOString(),by:'ceremony/make-manifest.mjs over xmr20-params-ceremony finalize output',directory:path.basename(dir)}};
const target=outFile||path.join(dir,'manifest.json');await writeFile(target,JSON.stringify(manifest,null,1)+'\n');
console.log(JSON.stringify({dir,manifest:target,manifestSha256:sha(await readFile(target)),network:manifest.network,domain:config.domain,ceremony:manifest.ceremony.circuits}));
