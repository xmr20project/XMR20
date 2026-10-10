import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
const actions=new Set(['readiness','snapshot','prepare','authorize-registration','submit','publish','reconcile','retry','progress']);
const reads=new Set(['getGenesisHash','getAccountInfo','getMultipleAccounts','getEpochInfo','getLatestBlockhash','getTransaction','getSignatureStatuses','getBlockHeight','isBlockhashValid','getBalance','getTokenAccountBalance']);
const origins=new Set(['https://xmr20.org','chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla']),upstream='http://127.0.0.1:8934';
export function gatewayRoute(path){
 if(path==='/api/bridge-solana-read')return {path:'/api/solana-read',rpc:true};
 const m=path?.match(/^\/api\/joint-transferable\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([a-z-]+)$/);
 return m&&actions.has(m[2])?{path,action:m[2]}:null;
}
export function makeGateway({fetcher=fetch,now=Date.now}={}){
 const pending=new Map(),rates=new Map();let active=0;
 return createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(typeof value==='string'?value:JSON.stringify(value));};
  try{
   const route=gatewayRoute(req.url);
   if(!route||!origins.has(req.headers.origin))return reply(403,{error:'Use the bridge on xmr20.org or in the XMR20 wallet.'});
   res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
   if(req.method==='OPTIONS'){
    const requested=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
    if(req.headers['access-control-request-method']!=='POST'||requested.some(v=>v!=='content-type'))return reply(403,{error:'Only JSON bridge requests are available.'});
    res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});return res.end();
   }
   if(req.method!=='POST'||req.headers['content-type']!=='application/json')return reply(403,{error:'Only JSON bridge requests are available.'});
   const ip=req.headers['x-real-ip']||req.socket.remoteAddress,t=now();
   for(const [k,r] of rates)if(r.until<t)rates.delete(k);
   const rate=rates.get(ip)||{count:0,until:t+60000};rate.count++;rates.set(ip,rate);
   if(rate.count>120||rates.size>10000||active>=20)return reply(429,{error:'Bridge is busy. Keep your receipt and retry shortly.'});
   let size=0;const parts=[];for await(const b of req){size+=b.length;if(size>20000)return reply(413,{error:'Request too large.'});parts.push(b);}const input=JSON.parse(Buffer.concat(parts).toString());
   if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw Error();
   if(route.rpc&&(!reads.has(input.method)||input.jsonrpc!=='2.0'||!Array.isArray(input.params)||input.params.length>3||!['number','string'].includes(typeof input.id)||!Object.keys(input).every(k=>['id','jsonrpc','method','params'].includes(k))))return reply(403,{error:'Only public Solana reads are available.'});
   const shared=['snapshot','readiness'].includes(route.action)&&Object.keys(input).length===0;
   if(!route.rpc&&!['snapshot','readiness','progress'].includes(route.action))pending.clear();
   let task=shared?pending.get(req.url):null;
   if(!task){active++;task=(async()=>{
    try{const r=await fetcher(upstream+route.path,{method:'POST',headers:{'Content-Type':'application/json',Origin:upstream},body:JSON.stringify(input),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(120000)});
     let length=0,chunks=[];for await(const b of r.body){length+=b.length;if(length>2100000)throw Error();chunks.push(Buffer.from(b));}const body=Buffer.concat(chunks).toString();JSON.parse(body);return {status:r.status,body};
    }finally{active--;}
   })();if(shared){pending.set(req.url,task);const done=()=>{if(pending.get(req.url)===task)pending.delete(req.url);};task.then(done,done);}}
   const result=await task;reply(result.status,result.body);
  }catch{reply(503,{error:'Bridge connection unavailable. Your saved approvals are kept; check their status before approving again.'});}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url))makeGateway().listen(8935,'127.0.0.1');
