// MAINNET PILOT SETUP (owner decision 26 Oct 2026, experimental, no independent review).
// Creates the mainnet issuer key OUTSIDE the repository, the public parameter directory params/mainnet-v1 (parameters.json +
// symlinked Penumbra proving keys) and the trusted manifest. Prints PUBLIC data only (issuer verifying key, issuer XMR address,
// ledger domain, manifest hash). The secret file is written once by the roles binary with mode 0600 into the secure directory
// and is never read, printed or copied by this tool.
//   node tools/mainnet-setup.mjs --start-height <H> [--secure-dir ~/.xmr20/mainnet-issuer-v1] [--force-new-key]
import {mkdir,readFile,writeFile,symlink,copyFile,stat,rm,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const dir=fileURLToPath(new URL('../',import.meta.url));
const argv=process.argv.slice(2);const flag=k=>{const i=argv.indexOf('--'+k);if(i<0)return null;return argv[i+1]??true;};
const startHeight=Number(flag('start-height'));if(!(startHeight>0))throw Error('--start-height <H> required: a mainnet height BELOW the first credit (pick a height a little in the future; records before it are ignored by every holder and indexer)');
const secure=path.resolve((flag('secure-dir')||path.join(os.homedir(),'.xmr20','mainnet-issuer-v1')).replace(/^~/,os.homedir()));
const MAINNET_GENESIS='418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';
const BIN=dir+'target/release/xmr20-unshielded-lab';const PENUMBRA=dir+'params/penumbra-2.1.1';const OUT=dir+'params/mainnet-v1';
// The roles binary refuses to start without the lab gate variable (a legacy name; it only marks a process started on purpose by
// our own tooling). Setup touches no daemon and no network.
const run=(cmd,args)=>new Promise((res,rej)=>execFile(cmd,args,{maxBuffer:1<<20,env:{...process.env,XMR20_INTEGRATION_LAB:'offline-synthetic-only'}},(e,so,se)=>e?rej(Error(se||e.message)):res(so)));
const sha=b=>createHash('sha256').update(b).digest('hex');
await access(BIN);await access(PENUMBRA+'/spend_pk.bin');
const exists=await stat(secure).then(()=>true,()=>false);
if(exists&&flag('force-new-key')!==true){console.error('Secure directory exists; reusing its key (pass --force-new-key to make a new one — the ledger domain changes with the issuer key).');}
else{
 if(exists)throw Error('Refusing to overwrite an existing issuer secret directory: move it aside by hand first.');
 await mkdir(path.dirname(secure),{recursive:true,mode:0o700});
 // the roles binary creates the directory itself (it refuses an existing one): parameters.json, issuer.secret.json (0600) and key copies
 const out=await run(BIN,['setup',secure,MAINNET_GENESIS,PENUMBRA]);const ready=JSON.parse(out.trim().split('\n').pop());
 if(ready.ready!==true)throw Error('setup did not report ready');
 await run('chmod',['700',secure]);
 // the proving keys were copied into the secure dir by setup (29 MB): replace them with symlinks to the shared public copies
 for(const f of ['spend_pk.bin','output_pk.bin']){await rm(path.join(secure,f));await symlink(path.join(PENUMBRA,f),path.join(secure,f));}
 await writeFile(path.join(secure,'README.txt'),`XMR20 mainnet pilot issuer key (created ${new Date().toISOString()}).\nissuer.secret.json holds the issuer SIGNING key and the issuer's XMR SPEND/VIEW keys (carrier-fee wallet). Mode 0600. Back it up offline.\nNever copy it into a repository, a chat or a log. The public parameters live in the candidate's params/mainnet-v1.\nIssuer XMR address (fund with a small amount for credit carrier fees): ${ready.issuerNativeAddress}\n`);
}
// public parameter directory inside the candidate: parameters.json copied, proving keys symlinked, NO secret
await rm(OUT,{recursive:true,force:true});await mkdir(OUT,{recursive:true});
await copyFile(path.join(secure,'parameters.json'),path.join(OUT,'parameters.json'));
for(const f of ['spend_pk.bin','output_pk.bin'])await symlink(path.join(PENUMBRA,f),path.join(OUT,f));
const manifestOut=await run(process.execPath,[dir+'params/make-manifest.mjs',OUT,'--network-kind','mainnet','--start-height',String(startHeight),'--mainnet-acknowledged','EXPERIMENTAL-PILOT']);
const m=JSON.parse(await readFile(path.join(OUT,'manifest.json'),'utf8'));
const config=JSON.parse(await readFile(path.join(OUT,'parameters.json'),'utf8'));
const issuerReadme=await readFile(path.join(secure,'README.txt'),'utf8');const issuerXmr=(issuerReadme.match(/Issuer XMR address[^:]*: (\S+)/)||[])[1]||null;
const summary={secureDir:secure,secretFile:path.join(secure,'issuer.secret.json'),secretCopiedOrPrinted:false,paramsDir:OUT,manifest:path.join(OUT,'manifest.json'),manifestSha256:sha(await readFile(path.join(OUT,'manifest.json'))),label:m.label,network:m.network,ledgerDomain:config.domain,issuerVk:config.issuer_vk,issuerXmrAddress:issuerXmr,note:'Fund the issuer XMR address with a small amount for credit carrier fees. The roles binary accepts a mainnet daemon only with XMR20_MAINNET_PILOT=I-UNDERSTAND; the bridge service only with XMR20_BRIDGE_MAINNET=I-UNDERSTAND.'};
await writeFile(path.join(OUT,'SETUP-SUMMARY.json'),JSON.stringify(summary,null,1)+'\n');
console.log(JSON.stringify(summary,null,1));
