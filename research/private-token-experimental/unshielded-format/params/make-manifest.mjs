// Builds the XMR20-PARAMS-2 trusted manifest for a parameter directory produced by `xmr20-unshielded-lab setup`.
// The proving keys are Penumbra's PUBLISHED spend/output keys: the manifest pins their exact bytes (sha256 = the git-lfs
// object ids in penumbra-sdk-proof-params 2.1.1), compressed verifying keys and Penumbra key ids, plus parameters.json,
// the ledger domain and the single lab issuer key. A `provenance` section states where the keys come from and what was NOT
// verified (Penumbra's ceremony transcript). Usage: node params/make-manifest.mjs <params dir> --network-kind offline-fakechain|stagenet [--start-height N] [--label text]
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const argv=process.argv.slice(2);const flag=(k)=>{const i=argv.indexOf('--'+k);if(i<0)return null;const v=argv[i+1];argv.splice(i,2);return v;};
const kind=flag('network-kind')||'offline-fakechain';const startHeight=Number(flag('start-height')||0);const label=flag('label');const outFile=flag('out');
if(!['offline-fakechain','stagenet'].includes(kind))throw Error('--network-kind must be offline-fakechain or stagenet (never mainnet from this tool)');
const [dir]=argv;if(!dir)throw Error('usage: make-manifest.mjs <params dir> --network-kind …');
const sha=b=>createHash('sha256').update(b).digest('hex');
const PENUMBRA={
 spend:{bytes:21673392,sha256:'87eca85bef562803fb9684c56c0a6db84aa6d0791b1c00b909e6f2a5c2cff452',keyId:'groth16pk1ke43yax8cg78h69y0pn6kvjcktdakwq9m4c58nyam8hffweramfqxr94fh',vkId:'groth16vk1zu2ks8er6fcj65y7w735wqzj9nx4fd5rsf2483lqyn0jqtlts2hssw2nfh',circuit:'Penumbra SpendCircuit (penumbra-sdk-shielded-pool 2.1.1; Groth16, BLS12-377)'},
 output:{bytes:7257360,sha256:'c9e97866edd6c815a7bcb2f3b5493713794369692bb96e5a2e682613c330e4a8',keyId:'groth16pk1rkpwdlcaw56gvyqpt0lm7lvj8q9mx93gqpz85dl9l3u677k75reqcnuq7d',vkId:'groth16vk1lnuw3xdngtwsq42wa5g4ceq3c3zyn6j2c0e57xzde43lznzuvf2sxmsdcc',circuit:'Penumbra OutputCircuit (penumbra-sdk-shielded-pool 2.1.1; Groth16, BLS12-377)'},
};
const paramsJson=await readFile(path.join(dir,'parameters.json'));const config=JSON.parse(paramsJson);
const files={};
for(const name of ['spend','output']){const bytes=await readFile(path.join(dir,name+'_pk.bin'));const p=PENUMBRA[name];
 if(bytes.length!==p.bytes||sha(bytes)!==p.sha256)throw Error(name+'_pk.bin is not Penumbra\'s published proving key (bytes/sha256 differ)');
 files[name]={path:name+'_pk.bin',circuit:p.circuit,bytes:bytes.length,sha256:sha(bytes),vk:config[name+'_vk'],keyId:p.keyId,verifyingKeyId:p.vkId};}
const manifest={format:'XMR20-PARAMS-2',label:label||(kind==='stagenet'?'UNSHIELDED FORMAT TEST — STAGENET — PENUMBRA KEYS — TEST FUNDS ONLY':'UNSHIELDED FORMAT TEST — OFFLINE FAKECHAIN — PENUMBRA KEYS'),
 warning:'Experimental XMR20 token format v0.2 (public by default, optional shielded transfers). Proofs use Penumbra\'s unchanged circuits and PUBLISHED ceremony keys; XMR20 ran no setup. Not reviewed; never for real funds.',
 protocol:{version:'XMR20-UNSHIELDED-v0.2-experimental',scheme:'XMR20-TKD1',domainLabel:'XMR20-UNSHIELDED-DOMAIN-v1',records:{public:{magic:'XP1',bytes:'110..390'},credit:{magic:'XC1',bytes:'173'},burn:{magic:'XR1',bytes:'213..309'},shield:{magic:'XS1',bytes:'637..733'},unshield:{magic:'XU1',bytes:'924'},privateA:{magic:'XMA',bytes:'932'},privateB:{magic:'XMB',bytes:'900'}}},
 network:{kind,genesis:config.chain,...(startHeight?{startHeight}:{})},ledgerDomain:config.domain,issuerVk:config.issuer_vk,config,
 parametersJson:{path:'parameters.json',bytes:paramsJson.length,sha256:sha(paramsJson)},files,
 provenance:{provingKeys:'penumbra-sdk-proof-params 2.1.1 src/gen/spend_pk.bin and output_pk.bin, fetched 25 Oct 2026 as git-lfs objects from github.com/penumbra-zone/penumbra (batch API) and verified against the crate\'s pointer hashes',
  verifyingKeys:'penumbra-sdk-proof-params 2.1.1 src/gen/spend_vk.param and output_vk.param (crate contents), compressed here; key ids checked against the crate\'s *_id.rs constants',
  ceremony:'Penumbra summoning ceremony (phase 1 2023, >15,000 contributors; phase 2 2024). Trust statement: at least one honest participant per phase destroyed their secret.',
  notVerifiedHere:'Penumbra\'s ceremony transcript (not located in their published spec; their crate pins key ids only). XMR20 ran no setup of its own for these circuits.',
  xmr20Setup:'none'},
 generated:{at:(await stat(path.join(dir,'parameters.json'))).mtime.toISOString(),by:'params/make-manifest.mjs over xmr20-unshielded-lab setup output',directory:path.basename(dir)}};
const target=outFile||path.join(dir,'manifest.json');await writeFile(target,JSON.stringify(manifest,null,1)+'\n');
console.log(JSON.stringify({dir,manifest:target,manifestSha256:sha(await readFile(target)),network:manifest.network,domain:config.domain}));
