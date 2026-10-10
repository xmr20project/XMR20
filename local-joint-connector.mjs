import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {protocolRoute} from './bridge/core-next/protocol-bridge.mjs';
import {PRIVATE_TEST_POLICY} from './bridge/core-transferable/private-test.mjs';
const manifest=JSON.parse(readFileSync(new URL('extension/manifest.json',import.meta.url),'utf8'));
export const extensionId=[...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest().subarray(0,16)].map(v=>String.fromCharCode(97+(v>>4),97+(v&15))).join('');
export const extensionOrigin='chrome-extension://'+extensionId;
const routes=new Set(['readiness','prepare-deposit','submit-deposit','deposit-status','deposit-outcome','publish','snapshot','prepare-return','release','reconcile','retry-return'].map(a=>'/api/joint-mainnet/'+a));routes.add('/api/solana-read');
const reads=new Set(['getGenesisHash','getAccountInfo','getMultipleAccounts','getEpochInfo','getLatestBlockhash','getTransaction','getSignatureStatuses','getBlockHeight','isBlockhashValid','getBalance','getTokenAccountBalance']);
// Explicit local review connector, no credentials, signer or arbitrary relay.
// The existing mainnet wallet verifies every submitted bridge request again.
export function makeExtensionConnector({fetcher=fetch,transferableOrigin,connectorPort=8928,solanaReadOrigin,walletTest=false}={}){const privateTest=connectorPort===8933;if(walletTest&&!privateTest)throw Error('Wallet testing requires the isolated connector.');if(privateTest){if(transferableOrigin!=='http://127.0.0.1:8934'||solanaReadOrigin!==transferableOrigin)throw Error('Exact isolated private test transports required.');}else if(connectorPort!==8928||solanaReadOrigin!==undefined||transferableOrigin!==undefined&&transferableOrigin!=='http://127.0.0.1:8931')throw Error('Explicit separate transferable review service required.');
 // Home, Bridge and the owner controller can request the same complete history
 // together. Share only an in-flight, empty-input snapshot. No completed cache,
 // no shared financial requests, and no sharing across a queued state change.
 const snapshots=new Map();
 return createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
  if(req.headers.host!=='127.0.0.1:'+connectorPort||req.headers.origin!==extensionOrigin)throw Error();
  res.setHeader('Access-Control-Allow-Origin',extensionOrigin);res.setHeader('Vary','Origin');
  const transferable=/^\/api\/joint-transferable\/[1-9A-HJ-NP-Za-km-z]{32,44}\/(readiness|snapshot|prepare|authorize-registration|submit|publish|reconcile|retry|progress)$/.test(req.url);
  if(privateTest&&req.url!=='/api/solana-read'&&(!transferable||!walletTest&&!req.url.startsWith('/api/joint-transferable/'+PRIVATE_TEST_POLICY.mint+'/')))throw Error();
  if(!routes.has(req.url)&&!protocolRoute(req.url)&&!transferable)throw Error();
  if(req.method==='OPTIONS'){if(req.headers['access-control-request-method']!=='POST'||(req.headers['access-control-request-headers']||'').toLowerCase()!=='content-type')throw Error();res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);res.end();return;}
  if(req.method!=='POST'||req.headers['content-type']!=='application/json')throw Error();
  let n=0,chunks=[];for await(const b of req){n+=b.length;if(n>20000)throw Error();chunks.push(b);}const bytes=Buffer.concat(chunks),input=JSON.parse(bytes.toString());
  if(req.url==='/api/solana-read'&&(!reads.has(input.method)||input.jsonrpc!=='2.0'||!Array.isArray(input.params)||input.params.length>3||!['number','string'].includes(typeof input.id)||!Object.keys(input).every(k=>['id','jsonrpc','method','params'].includes(k))))throw Error();
  if(transferable&&!transferableOrigin)throw Error();
  const target=transferable?transferableOrigin:solanaReadOrigin??'http://127.0.0.1:8925';
  const snapshot=transferable&&req.url.endsWith('/snapshot')&&input&&Object.getPrototypeOf(input)===Object.prototype&&Object.keys(input).length===0;
  if(transferable&&!/(?:snapshot|readiness|progress)$/.test(req.url))snapshots.clear();
  const forward=async()=>{
   const r=await fetcher(target+req.url,{method:'POST',headers:{'Content-Type':'application/json',Origin:target},body:bytes,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});
   if(!r.body)throw Error();let total=0,parts=[];for await(const p of r.body){total+=p.length;if(total>2100000)throw Error();parts.push(Buffer.from(p));}const text=Buffer.concat(parts).toString();JSON.parse(text);return {status:r.status,text};
  };
  let pending=snapshot?snapshots.get(req.url):null;
  if(!pending){pending=forward();if(snapshot){snapshots.set(req.url,pending);const forget=()=>{if(snapshots.get(req.url)===pending)snapshots.delete(req.url);};pending.then(forget,forget);}}
  const result=await pending;res.writeHead(result.status,{'Content-Type':'application/json'});res.end(result.text);
 }catch{json(503,{error:'Local extension connector unavailable. Keep your receipt and check readiness.'});}
 });}
export function connectorOptions(args){
 if(args.length===0)return {};
 if(args.length===1&&args[0]==='--transferable-review')return {transferableOrigin:'http://127.0.0.1:8931'};
 if(args.length===1&&args[0]==='--wallet-testing')return {connectorPort:8933,transferableOrigin:'http://127.0.0.1:8934',solanaReadOrigin:'http://127.0.0.1:8934',walletTest:true};
 if(args.length===1&&args[0]==='--private-one-xmr20')return {connectorPort:8933,transferableOrigin:'http://127.0.0.1:8934',solanaReadOrigin:'http://127.0.0.1:8934'};
 throw Error('Use the ordinary connector or the explicit transferable review mode.');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const options=connectorOptions(process.argv.slice(2)),port=options.connectorPort??8928;makeExtensionConnector(options).listen(port,'127.0.0.1',()=>console.log('Local XMR20 extension connector: 127.0.0.1:'+port+' · '+extensionId));}
