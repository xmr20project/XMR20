import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {existsSync,readFileSync,writeFileSync,copyFileSync,mkdirSync,cpSync} from 'node:fs';
const base=resolve(import.meta.dirname);
const modules=resolve(base,'node_modules');
const require=createRequire(resolve(modules,'esbuild/package.json'));const {build}=require('esbuild');
// Experimental UI is opt-in at build time; ordinary builds erase the test flow.
const jointPreview=process.env.XMR20_JOINT_ESCROW_PREVIEW==='local-svm';
const walletTest=process.env.XMR20_JOINT_PRIVATE_TEST==='all-tokens';
const privateTest=process.env.XMR20_JOINT_PRIVATE_TEST==='local'||walletTest;
const transferableReview=process.env.XMR20_JOINT_TRANSFERABLE_REVIEW==='local'||privateTest;
const mainnetReview=process.env.XMR20_JOINT_MAINNET_REVIEW==='local'||transferableReview;
if(jointPreview&&mainnetReview)throw Error('Build the synthetic and real-token reviews separately.');
const output=walletTest?'extension-bridge':privateTest?'extension-transferable-private-test':transferableReview?'extension-transferable-review':mainnetReview?'extension-joint-review':'extension';
if(mainnetReview){cpSync(resolve(base,'extension'),resolve(base,output),{recursive:true});const m=JSON.parse(readFileSync(resolve(base,output,'manifest.json'),'utf8'));m.name=walletTest?'XMR20 Wallet — Bridge testing':privateTest?'XMR20 Wallet — Private 1 XMR20 test':transferableReview?'XMR20 Wallet — Transferable bridge review':'XMR20 Wallet — Joint bridge review';m.version=walletTest?'0.1.26':privateTest?'0.1.19':transferableReview?'0.1.18':'0.1.17';m.content_security_policy.extension_pages=m.content_security_policy.extension_pages.replace("; worker-src",' http://127.0.0.1:8928'+(privateTest?' http://127.0.0.1:8933':'')+'; worker-src');if(privateTest)m.host_permissions=[...new Set([...(m.host_permissions||[]),'http://127.0.0.1:8933/*'])];writeFileSync(resolve(base,output,'manifest.json'),JSON.stringify(m,null,2));}
if(walletTest)writeFileSync(resolve(base,output,'INSTALL.txt'),'XMR20 Wallet — Bridge testing 0.1.26\n\nUpdate an existing wallet\nKeep the existing extension and its folder. Replace its installation files with\nthis build, then open chrome://extensions and click Reload on XMR20 Wallet.\nDo not uninstall: that can remove saved encrypted accounts and recovery receipts.\nReload locks the wallet. Unlock with your existing password; no key import is needed.\n\nFirst installation\nExtract into a folder you will keep. Open chrome://extensions, enable Developer\nmode, click Load unpacked, and select the folder containing manifest.json.\n\nBridge testing\nThis build supports any linked account and verified tokens launched through XMR20.\nUse Bridge, select the token, and follow the displayed account-link and bridge steps.\nThe recipient must register its linked wallets for that token before receiving it.\nBridge actions and balances connect to https://api.xmr20.org automatically.\nNo local connector or SSH forward is needed for this build.\nSee BRIDGE-TESTING.md and README.md at https://github.com/xmr20project/XMR20.\n\nThe program retains upgrade authority and is not independently audited.\nToken fees and network/account costs apply. Keep recovery material private.\nMonero transfers here are public XMR20 protocol records, not native private XMR.\n');
if(transferableReview)writeFileSync(resolve(base,output,'style.css'),readFileSync(resolve(base,'extension/style.css'),'utf8')+'\n'+readFileSync(resolve(base,'src/joint-transferable.css'),'utf8'));
const definitions={__XMR20_JOINT_PREVIEW__:String(jointPreview),__XMR20_JOINT_MAINNET_REVIEW__:String(mainnetReview),__XMR20_JOINT_TRANSFERABLE_REVIEW__:String(transferableReview),__XMR20_JOINT_PRIVATE_TEST__:String(privateTest),__XMR20_JOINT_WALLET_TEST__:String(walletTest)};
// Exclude the entire ABI-3 module graph from ordinary/fixed-owner packages.
// Top-level dependency initialization must not retain opt-in policy identities.
const bridgePlugins=transferableReview?[]:[{name:'exclude-transferable-review',setup(b){b.onLoad({filter:/[\\/]joint-transferable-ui\.js$/},()=>({contents:"export function createJointTransferableUI(){throw Error('Transferable review is not enabled in this build.');}",loader:'js'}));b.onLoad({filter:/[\\/]joint-holdings\.js$/},()=>({contents:"export function createJointHoldings(){return null;} export const isJointHolding=()=>false; export function replaceHoldingSource(rows,incoming,{network}){return [...rows.filter(r=>r.network!==network),...incoming];}",loader:'js'}));}}];
const result=await build({define:definitions,plugins:bridgePlugins,metafile:true,entryPoints:[resolve(base,'src/app.js')],outfile:resolve(base,output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',nodePaths:[modules],minify:true,legalComments:'eof',inject:[resolve(base,'src/polyfill.js')]});
await build({entryPoints:[resolve(base,'src/core.js')],outfile:resolve(base,'review/core.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')]});
console.log('Built '+output+'/app.js and test module.');
await build({entryPoints:[resolve(base,'server-patch/extension-auth.mjs')],outfile:resolve(base,'review/extension-auth.mjs'),bundle:true,format:'esm',platform:'node',target:'node22',nodePaths:[modules],banner:{js:"import {createRequire as nodeCreateRequire} from 'node:module'; const require=nodeCreateRequire(import.meta.url);"}});

// Bundle the license text of each dependency included in the distributed script.
const notices=new Map();
for(const input of Object.keys(result.metafile.inputs)){
 let dir=resolve(input,'..');
 while(dir!==resolve(dir,'..')){
  const pkg=resolve(dir,'package.json');
  if(existsSync(pkg)){const data=JSON.parse(readFileSync(pkg,'utf8'));if(data.name&&data.name!=='xmr20-wallet-extension'){
   let license='';for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENSE-MIT','COPYING']){if(existsSync(resolve(dir,file))){license=readFileSync(resolve(dir,file),'utf8');break;}}
   notices.set(data.name+'@'+data.version,(data.name+'@'+data.version+' — '+(data.license||'See upstream')+'\n'+license));
  }break;}dir=resolve(dir,'..');
 }
}
writeFileSync(resolve(base,output,'THIRD-PARTY-NOTICES.txt'),[...notices.values()].join('\n\n----------------------------------------\n\n'));

await build({define:definitions,entryPoints:[resolve(base,'src/background.js')],outfile:resolve(base,output,'background.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')],minify:true});

await build({entryPoints:[resolve(base,'src/approval.js')],outfile:resolve(base,output,'approval.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true});
if(mainnetReview)await build({entryPoints:[resolve(base,'src/joint-owner.worker.js')],outfile:resolve(base,output,'vendor/joint-owner.worker.js'),bundle:true,format:'iife',platform:'browser',target:'chrome120',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')],minify:true});
if(transferableReview)await build({entryPoints:[resolve(base,'src/joint-transferable.worker.js')],outfile:resolve(base,output,'vendor/joint-transferable.worker.js'),bundle:true,format:'iife',platform:'browser',target:'chrome120',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')],minify:true});

await build({entryPoints:[resolve(base,'src/bridge-review-entry.js')],outfile:resolve(base,'review/bridge.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')]});
