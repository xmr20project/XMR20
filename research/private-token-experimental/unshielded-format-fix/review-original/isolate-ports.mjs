// Review-only runtime adaptation. Production/candidate sources and test assertions
// remain byte-for-byte unchanged. Only loopback endpoints and build output differ.
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const extension=root+'review/reproduction/extension';
function once(source,from,to){if(source.split(from).length!==2)throw Error('Expected one isolation substitution: '+from);return source.replace(from,to);}
registerHooks({load(url,context,next){const r=next(url,context);if(!url.startsWith('file:'))return r;const path=fileURLToPath(url);let s;
 if(path===root+'wallet-extension/build.mjs'){
  s=String(r.source);s=once(s,"stagenetTest?'8961':'8940'","stagenetTest?'8961':'18940'");s=once(s,"stagenetTest?'38091':'30041'","stagenetTest?'38091':'31041'");
 }else if(path===root+'browser-flow.test.mjs'){
  s=String(r.source);s=once(s,"harness('verified-popup-unshielded')",`harness('review-popup-unshielded',{extensionDir:${JSON.stringify(extension)},backendUrl:'http://127.0.0.1:18940/',rpcUrl:'http://127.0.0.1:31041/'})`);
  s=once(s,'startBackend({log:','startBackend({rpcPort:31041,p2pPort:31040,httpPort:18940,log:');
 }else if(path===root+'parts-rollback.test.mjs'){
  s=once(String(r.source),'rpcPort:30131,p2pPort:30130,httpPort:8991','rpcPort:31131,p2pPort:31130,httpPort:18991');
 }
 return s===undefined?r:{...r,source:s};
}});
