export const MONERO_NODES=[{name:'Cake Wallet',url:'https://xmr-node.cakewallet.com:18081'},{name:'Seth for Privacy',url:'https://node.sethforprivacy.com'}];
export async function nativeNodeHeight(node=MONERO_NODES[0].url){
 if(!MONERO_NODES.some(n=>n.url===node))throw Error('Choose a supported node.');
 const r=await fetch(node+'/get_info',{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Node unavailable');const d=await r.json();
 if(d.status!=='OK'||d.mainnet!==true||d.nettype!=='mainnet'||!Number.isSafeInteger(d.height)||d.height<=0||d.offline===true||d.synchronized===false)throw Error('Mainnet node is not ready.');return d.height;
}
// Capture before creating the keys. A small rewind covers the creation interval
// and shallow reorganizations; never use today's height for an existing wallet.
export async function captureNativeRestoreHeight({readHeight=creationNodeHeight}={}){
 // A missing height must not block offline key generation. Zero is conservative:
 // it scans all history, unlike a guessed recent height which could miss funds.
 try{return await Promise.any(MONERO_NODES.map(async node=>{
  const height=await readHeight(node.url);
  if(!Number.isSafeInteger(height)||height<=20)throw Error('Invalid height');
  return height-20;
 }));}catch{return 0;}
}
async function creationNodeHeight(node){
 const index=MONERO_NODES.findIndex(n=>n.url===node);
 if(index<0)throw Error('Choose a supported node.');
 const r=await fetch('/api/monero-height/'+index,{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error('Node unavailable');const d=await r.json();
 if(d.status!=='OK'||d.mainnet!==true||d.nettype!=='mainnet'||!Number.isSafeInteger(d.height)||d.height<=20||d.offline===true||d.synchronized===false)throw Error('Mainnet node is not ready.');
 return d.height;
}
export function nativeRestoreHeight(address){
 try{const raw=localStorage.getItem('xmr20-native-birth:'+address);if(!/^\d+$/.test(raw||''))return 0;const height=Number(raw);return Number.isSafeInteger(height)?height:0;}catch{return 0;}
}
export function saveNativeRestoreHeight(address,height){
 try{if(!Number.isSafeInteger(height)||height<0)return false;const key='xmr20-native-birth:'+address;localStorage.setItem(key,String(height));return localStorage.getItem(key)===String(height);}catch{return false;}
}
export function createNativeBalanceClient({workerFactory=()=>new Worker(new URL('../monero-native/balance.worker.js',location.href).pathname),onProgress=()=>{}}={}){
 const worker=workerFactory(),pending=new Map();let disposed=false;
 function dispose(){if(disposed)return;disposed=true;worker.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Monero wallet locked.'));}pending.clear();}
 worker.onerror=()=>dispose();
 worker.onmessage=({data})=>{const p=pending.get(data?.id);if(!p)return;if(data.progress){onProgress(data.progress);return;}clearTimeout(p.timer);pending.delete(data.id);if(data.error)p.reject(Error(data.error));else p.resolve(data.result);};
 function request(action,args={}){if(disposed||pending.size) return Promise.reject(Error('Monero wallet is locked or busy.'));return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>dispose(),action==='sync'?20*60*1000:60000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,action,...args});});}
 return {open:args=>request('open',args),sync:node=>request('sync',{node}),dispose};
}
