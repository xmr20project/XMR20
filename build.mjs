import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {existsSync,readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
const base=resolve(import.meta.dirname), modules=resolve(base,'node_modules');
const require=createRequire(resolve(modules,'esbuild/package.json'));const {build}=require('esbuild');
const result=await build({metafile:true,entryPoints:[resolve(base,'src/app.js')],outfile:resolve(base,'extension/app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',nodePaths:[modules],minify:true,legalComments:'eof',inject:[resolve(base,'src/polyfill.js')]});
await build({entryPoints:[resolve(base,'src/core.js')],outfile:resolve(base,'review/core.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')]});
console.log('Built extension/app.js and test module. Load the extension/ folder in Chrome.');
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
writeFileSync(resolve(base,'extension/THIRD-PARTY-NOTICES.txt'),[...notices.values()].join('\n\n----------------------------------------\n\n'));

await build({entryPoints:[resolve(base,'src/background.js')],outfile:resolve(base,'extension/background.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')],minify:true});

await build({entryPoints:[resolve(base,'src/approval.js')],outfile:resolve(base,'extension/approval.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true});

await build({entryPoints:[resolve(base,'src/bridge-review-entry.js')],outfile:resolve(base,'review/bridge.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],inject:[resolve(base,'src/polyfill.js')]});
