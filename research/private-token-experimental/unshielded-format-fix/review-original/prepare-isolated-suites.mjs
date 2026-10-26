// Copies official suites under review/, altering only module location, endpoints,
// and test extension location. Test statements/assertions are preserved.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
function once(s,a,b){if(s.split(a).length!==2)throw Error('Expected exactly one '+a);return s.replace(a,b);}
for(const name of ['parts-rollback','browser-flow']){
 let s=await readFile(root+name+'.test.mjs','utf8');
 s=once(s,"from './backend/service.mjs'","from '../../backend/service.mjs'");
 if(name==='parts-rollback'){
  s=once(s,"from './wallet-lib/token-wallet.mjs'","from '../../wallet-lib/token-wallet.mjs'");
  s=once(s,"new URL('./',import.meta.url)","new URL('../../',import.meta.url)");
  s=once(s,'rpcPort:30131,p2pPort:30130,httpPort:8991','rpcPort:31131,p2pPort:31130,httpPort:18991');
 }else{
  s=once(s,"from './browser-harness.mjs'","from '../../browser-harness.mjs'");
  s=once(s,"harness('verified-popup-unshielded')",`harness('review-popup-unshielded',{extensionDir:${JSON.stringify(root+'review/reproduction/extension')},backendUrl:'http://127.0.0.1:18940/',rpcUrl:'http://127.0.0.1:31041/'})`);
  s=once(s,'startBackend({log:','startBackend({rpcPort:31041,p2pPort:31040,httpPort:18940,log:');
 }
 await writeFile(new URL(name+'.isolated.test.mjs',import.meta.url),s);
}
