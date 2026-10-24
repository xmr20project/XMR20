// Focused regression test for the loopback fault proxy (stagenet/lossy-proxy.mjs) against a scripted "daemon":
//   - drop-reply forwards the request, records the daemon's answer, then destroys the client connection
//   - drop-request destroys the connection before anything reaches the daemon
//   - unarmed requests pass through unchanged
//   - `history` keeps every fault and every send request for the whole run even when the per-case `events` view is cleared
//     (the fault-log file is written from `history`; the first version wrote `events` and lost the faults — fixed 24 Oct 2026)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startLossyProxy} from './stagenet/lossy-proxy.mjs';
async function daemon(){const seen=[];const s=http.createServer(async(req,res)=>{const c=[];for await(const x of req)c.push(x);seen.push({path:req.url,body:Buffer.concat(c).toString()});
 res.writeHead(200,{'content-type':'application/json'});res.end(req.url==='/send_raw_transaction'?JSON.stringify({status:'OK'}):JSON.stringify({result:{height:7}}));});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${s.address().port}`,seen,close:()=>new Promise(r=>s.close(r))};}
const post=(url,path,body)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
test('drop-reply: daemon answered, client connection destroyed, fault recorded with the daemon answer',async()=>{
 const d=await daemon();const p=await startLossyProxy({target:d.url});try{
  p.arm({mode:'drop-reply',count:1});await assert.rejects(post(p.url,'/send_raw_transaction',{tx_as_hex:'aa'}),/fetch failed/);
  assert.equal(d.seen.length,1,'the daemon received the send');assert.equal(p.faults().length,1);
  assert.equal(p.faults()[0].fault,'drop-reply');assert.equal(p.faults()[0].replyDroppedAfterDaemonAnswered,true);assert.equal(p.faults()[0].daemon.status,'OK');
  const r=await post(p.url,'/send_raw_transaction',{tx_as_hex:'aa'});assert.equal((await r.json()).status,'OK','disarmed after count: the next send passes');
  assert.equal(p.sends().length,2);}finally{await p.close();await d.close();}});
test('drop-request: nothing reaches the daemon',async()=>{
 const d=await daemon();const p=await startLossyProxy({target:d.url});try{
  p.arm({mode:'drop-request',count:1});await assert.rejects(post(p.url,'/send_raw_transaction',{tx_as_hex:'bb'}),/fetch failed/);
  assert.equal(d.seen.length,0);assert.equal(p.faults()[0].fault,'drop-request');assert.equal(p.faults()[0].forwarded,false);}finally{await p.close();await d.close();}});
test('pass-through is unchanged and history survives clearing the per-case events view',async()=>{
 const d=await daemon();const p=await startLossyProxy({target:d.url});try{
  const r=await post(p.url,'/json_rpc',{method:'get_info'});assert.deepEqual(await r.json(),{result:{height:7}});assert.equal(d.seen[0].body,JSON.stringify({method:'get_info'}));
  p.arm({mode:'drop-reply',count:1});await assert.rejects(post(p.url,'/send_raw_transaction',{tx_as_hex:'cc'}));await post(p.url,'/send_raw_transaction',{tx_as_hex:'cc'});
  p.events.length=0;assert.equal(p.faults().length,0,'per-case view cleared');
  assert.equal(p.history.length,2,'history keeps the fault and the send only (no pass-through noise)');assert.equal(p.history[0].fault,'drop-reply');assert.equal(p.history[1].fault,null);
  assert.ok(p.history.every(e=>e.path==='/send_raw_transaction'));}finally{await p.close();await d.close();}});
