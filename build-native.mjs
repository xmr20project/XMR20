// Reproduce the installed XMR20 Wallet 0.1.95 native-market package from this repository.
// Output: extension-native/ (git-ignored). Built scripts are compared with the hashes the
// owner's installed package had; the engine files (native-package/market/native-wallet) are
// shipped as pinned artifacts because their signer is built from a separate Rust crate.
import {createRequire} from 'node:module';
import {resolve,join,dirname} from 'node:path';
import {cpSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {operatorConfigurationPlugin} from './build-tools/operator-configuration.mjs';
const base=resolve(import.meta.dirname),require=createRequire(resolve(base,'package.json')),{build}=require('esbuild');
const out=resolve(base,'extension-native'),pkg=resolve(base,'native-package');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
mkdirSync(out,{recursive:true});
cpSync(resolve(base,'extension'),out,{recursive:true});
for(const name of ['manifest.json','market-entry.css','market.html','market/market.css','market/navigation.css','site-theme.css','inscriptions/site-shell.css','rewards/site-header.css','INSTALL.txt','MARKET-CANDIDATE.txt',
 'market/native-wallet/build-hashes.json','market/native-wallet/worker.js','market/native-wallet/runtime.js','market/native-wallet/transport.js','market/native-wallet/monero-0.11.16.js','market/native-wallet/xmr20_native_market_signer.js','market/native-wallet/xmr20_native_market_signer_bg.wasm']){
 mkdirSync(dirname(join(out,name)),{recursive:true});copyFileSync(join(pkg,name),join(out,name));
}
// Same flags as the installed 0.1.95 package (operator-native, coin swaps, spend protection).
const define={__XMR20_NATIVE_COIN_SWAPS__:'true',__XMR20_OPERATOR_NATIVE__:'true',__XMR20_NATIVE_MARKET__:'true',__XMR20_NATIVE_SPEND_PROTECTION__:'true',
 __XMR20_FAST_SEND__:'true',__XMR20_UNIVERSAL_LINK__:'true',__XMR20_JOINT_PREVIEW__:'false',__XMR20_JOINT_MAINNET_REVIEW__:'true',
 __XMR20_JOINT_TRANSFERABLE_REVIEW__:'true',__XMR20_JOINT_PRIVATE_TEST__:'true',__XMR20_JOINT_WALLET_TEST__:'true'};
const options={bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,nodePaths:[resolve(base,'node_modules')],inject:[resolve(base,'src/polyfill.js')],plugins:[operatorConfigurationPlugin(true)],define};
await build({...options,entryPoints:[resolve(base,'src/app.js')],outfile:join(out,'app.js')});
await build({...options,entryPoints:[resolve(base,'src/background.js')],outfile:join(out,'background.js')});
await build({...options,entryPoints:[resolve(base,'src/approval.js')],outfile:join(out,'approval.js')});
await build({...options,entryPoints:[resolve(base,'src/market-entry.js')],outfile:join(out,'market-entry.js')});
await build({...options,format:'iife',entryPoints:[resolve(base,'src/ordinary-spend-guard.js')],outfile:join(out,'vendor/market-ordinary-guard.js')});
await build({...options,format:'iife',entryPoints:[resolve(base,'src/native-carrier-transaction.js')],outfile:join(out,'vendor/native-carrier-transaction.js')});
const expected=JSON.parse(readFileSync(join(pkg,'installed-hashes.json'),'utf8'));
const report={version:expected.version,outputs:{}};
for(const [name,hash] of Object.entries(expected.builtOutputs)){const actual=sha(join(out,name));report.outputs[name]={reproduced:actual===hash,sha256:actual,installedSha256:hash};}
for(const [name,hash] of Object.entries(expected.files)){report.outputs['native-package/'+name]={reproduced:sha(join(out,name))===hash,sha256:hash};}
writeFileSync(join(out,'REPRODUCTION.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output:out,reproduced:Object.fromEntries(Object.entries(report.outputs).filter(([k])=>!k.startsWith('native-package/')).map(([k,v])=>[k,v.reproduced]))}));
