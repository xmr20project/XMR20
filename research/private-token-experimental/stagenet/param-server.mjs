#!/usr/bin/env node
// Static parameter service for the stagenet rehearsal. Serves EXACTLY three files from one directory —
// /params/parameters.json, /params/normal.public-pk, /params/boundary.public-pk — plus an informational /params
// summary. Nothing else is reachable: no manifest (the client trusts only its own shipped manifest), no issuer
// secret, no wallet state, no journals, no directory listing, no path traversal. Serving is transport only: the
// client authenticates every file against its manifest before use, and this server never tells it what to trust.
//   node stagenet/param-server.mjs --dir params/stagenet-v0 [--port 8951] [--host 127.0.0.1]
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const SERVED=['parameters.json','normal.public-pk','boundary.public-pk'];
export async function startParamServer({dir,port=8951,host='127.0.0.1',log=()=>{}}){
 const root=path.resolve(dir);const info={};
 for(const name of SERVED){const p=path.join(root,name);const st=await stat(p);info[name]={bytes:st.size,sha256:createHash('sha256').update(await readFile(p)).digest('hex')};}
 const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://'+req.headers.host);const cors={'access-control-allow-origin':req.headers.origin||'*','access-control-allow-headers':'content-type','vary':'origin'};
   if(req.method==='OPTIONS'){res.writeHead(204,cors);return res.end();}
   if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,cors);return res.end();}
   if(url.pathname==='/params'){res.writeHead(200,{'content-type':'application/json',...cors});return res.end(JSON.stringify({files:info,note:'Transport only. Authenticate every file against YOUR shipped manifest; this server is not a trust anchor.'}));}
   const m=/^\/params\/([A-Za-z0-9.-]+)$/.exec(url.pathname);const name=m&&m[1];
   if(!name||!SERVED.includes(name)){log({refused:url.pathname});res.writeHead(404,cors);return res.end();}
   const file=path.join(root,name);const st=await stat(file);
   res.writeHead(200,{'content-type':name.endsWith('.json')?'application/json':'application/octet-stream','content-length':String(st.size),'cache-control':'no-store',...cors});
   if(req.method==='HEAD')return res.end();createReadStream(file).pipe(res);}
  catch(e){log({error:e.message});res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(port,host,r));
 return {url:`http://${host}:${port}`,files:info,close:()=>new Promise(r=>server.close(r))};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const a=process.argv.slice(2);const opt=(k,d)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
 const s=await startParamServer({dir:opt('dir','params/stagenet-v0'),port:Number(opt('port','8951')),host:opt('host','127.0.0.1'),log:x=>console.error(JSON.stringify(x))});
 console.log(JSON.stringify({ready:true,url:s.url,files:s.files,note:'serves parameters.json and the two proving keys only; stop with Ctrl-C'}));}
