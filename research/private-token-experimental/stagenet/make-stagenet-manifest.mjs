// Builds a STAGENET-anchored parameter manifest (format XMR20-PARAMS-1, network.kind "stagenet") from a parameter
// directory produced by the lab `setup` for the stagenet genesis. Stagenet genesis block hash (public constant):
//   76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb
// Usage: node stagenet/make-stagenet-manifest.mjs <params dir generated with that genesis> [label]
// The resulting parameters are STILL a disposable single-party setup; this only binds the ledger domain to stagenet.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const STAGENET_GENESIS='76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb';
const [dir,label='DISPOSABLE TEST SETUP — STAGENET REHEARSAL — NOT PRODUCTION']=process.argv.slice(2);
if(!dir)throw Error('usage: make-stagenet-manifest.mjs <params dir> [label]');
const sha=b=>createHash('sha256').update(b).digest('hex');
const paramsJson=await readFile(path.join(dir,'parameters.json'));const config=JSON.parse(paramsJson);
if(config.chain!==STAGENET_GENESIS)throw Error('parameters.json was generated for genesis '+config.chain+', not the stagenet genesis; regenerate with the lab setup and the stagenet genesis hash');
const files={};
for(const [name,circuit] of [['normal','XM3 private transfer: 3 Penumbra spends, 2 outputs (Groth16, BLS12-377)'],['boundary','XB3 boundary record: 3 spends, 1 output, public amount+asset (Groth16, BLS12-377)']]){const bytes=await readFile(path.join(dir,name+'.public-pk'));files[name]={path:name+'.public-pk',circuit,bytes:bytes.length,sha256:sha(bytes),vk:config[name+'_vk']};}
const manifest={format:'XMR20-PARAMS-1',label,warning:'Disposable single-party Groth16 setup bound to the Monero STAGENET genesis. Rehearsal only; never for real funds.',protocol:{scheme:'XMR20-TKD1',domainLabel:'XMR20-MIGRATION-REHEARSAL-DOMAIN-v1',records:{transfer:{magic:'XM3',bytes:996,inputs:3,outputs:2},boundary:{magic:'XB3',bytes:925,inputs:3,outputs:1}}},network:{kind:'stagenet',genesis:config.chain},ledgerDomain:config.domain,issuerVk:config.issuer_vk,config,parametersJson:{path:'parameters.json',bytes:paramsJson.length,sha256:sha(paramsJson)},files,generated:{at:(await stat(path.join(dir,'normal.public-pk'))).mtime.toISOString(),by:'xmr20-integration-lab setup (stagenet genesis)',directory:path.basename(dir)}};
await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,1)+'\n');
console.log(JSON.stringify({dir,manifestSha256:sha(await readFile(path.join(dir,'manifest.json'))),network:manifest.network,domain:config.domain}));
