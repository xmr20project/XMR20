// LOSSY LOOPBACK PROXY — a controlled network fault between a test wallet and its Monero daemon.
//
// Every request is forwarded to the daemon unchanged. When ARMED for a path (normally /send_raw_transaction), the proxy
// injects exactly one of two faults for the next `count` matching requests:
//   drop-reply    the request IS forwarded, the daemon's answer IS received by the proxy and logged (evidence that the
//                 transaction reached the daemon), and then the CLIENT connection is destroyed without any response: the
//                 wallet sees a transport error ("fetch failed" / ECONNRESET) and must treat the outcome as UNKNOWN.
//   drop-request  the client connection is destroyed BEFORE anything is forwarded: the daemon never saw the request.
// Everything else (fee estimates, decoys, pool and chain queries, the lookup that recovery relies on) passes through.
// The fault log is the evidence that distinguishes an actual lost reply from the ordinary "same blob re-sent" case.
//
// Loopback only. Nothing here touches mainnet; it is a test fixture for the recovery cases (stagenet/recovery-cases.mjs).
import http from 'node:http';
export async function startLossyProxy({target,port=0,host='127.0.0.1',log=()=>{}}){
 const base=target.replace(/\/$/,'');const events=[];let rule=null;   // {path, mode:'drop-reply'|'drop-request', count}
 // `events` is the per-case view (callers may clear it between cases); `history` keeps EVERY fault, every /send_raw_transaction
 // and every upstream error for the whole run and is never cleared: it is what the written fault log must contain.
 const history=[];const keep=ev=>{if(ev.fault||ev.path==='/send_raw_transaction'||ev.upstreamError)history.push(ev);};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
  const path=req.url;const armed=rule&&rule.count>0&&path===rule.path;
  const ev={at:new Date().toISOString(),path,bytes:body.length,fault:null};
  if(armed&&rule.mode==='drop-request'){rule.count--;ev.fault='drop-request';ev.forwarded=false;events.push(ev);keep(ev);log(ev);req.socket.destroy();return;}
  let upstream;try{upstream=await fetch(base+path,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json',connection:'close'},body:req.method==='GET'||req.method==='HEAD'?undefined:body,signal:AbortSignal.timeout(120000)});}
  catch(e){ev.upstreamError=String(e.cause?.code||e.message).slice(0,120);events.push(ev);keep(ev);log(ev);res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({status:'proxy upstream error',error:ev.upstreamError}));return;}
  const text=await upstream.text();ev.forwarded=true;ev.upstreamStatus=upstream.status;
  if(path==='/send_raw_transaction'){try{const j=JSON.parse(text);ev.daemon={status:j.status,reason:j.reason||null,double_spend:j.double_spend||false,not_relayed:j.not_relayed||false};}catch{ev.daemon={unparsed:text.slice(0,80)};}}
  if(armed&&rule.mode==='drop-reply'){rule.count--;ev.fault='drop-reply';ev.replyDroppedAfterDaemonAnswered=true;events.push(ev);keep(ev);log(ev);req.socket.destroy();return;}
  events.push(ev);keep(ev);if(ev.daemon)log(ev);
  res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json',connection:'close'});res.end(text);});
 await new Promise((ok,err)=>{server.once('error',err);server.listen(port,host,ok);});
 const url=`http://${host}:${server.address().port}`;
 return {url,target:base,events,history,
  arm(r){rule={path:'/send_raw_transaction',count:1,...r};return rule;},
  disarm(){rule=null;},
  faults(){return events.filter(e=>e.fault);},
  sends(){return events.filter(e=>e.path==='/send_raw_transaction');},
  async close(){await new Promise(r=>server.close(r));},
 };
}
if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())){const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
 const p=await startLossyProxy({target:opt('target','http://127.0.0.1:38091'),port:Number(opt('port','0')),log:e=>console.error(JSON.stringify(e))});console.log(p.url);}
