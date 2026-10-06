"""Independent, keyless public indexer. Only its own state directory is writable.

The scanner uses the existing pinned parsing, signatures, ordering and reorg
rules. Public launch metadata is discovered through the primary catalog; chain
events and balances are independently checked. There are no transaction APIs.
"""
import argparse,fcntl,hashlib,http.client,json,os,re,select,sqlite3,ssl,subprocess,sys,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from scanner import scanner

HERE=Path(__file__).resolve().parent
HASH=re.compile(r'^[a-f0-9]{64}$')
ID=re.compile(r'^[a-f0-9-]{36}$')
FIELDS=('id','mint','owner','ticker','name','image','network','moneroNetwork','moneroTxid','bridgeVersion','bridgeProgramId','escrowPolicy','transferTaxBps','platformFeeBps','solanaFinalized','bridgeReady','proofVerified','confirmations','publicIndex','hidden','halted','cancelledAt','createdAt','state','description','metadataHash','solanaSignature')

class Rejected(Exception):pass

def require(ok,category):
    if not ok:raise Rejected(category)

def compact(v):return json.dumps(v,separators=(',',':'),allow_nan=False)

class Store:
    def __init__(self,path):
        self.path=Path(path)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL)')
    def connect(self):
        db=sqlite3.connect(self.path,timeout=5);db.execute('PRAGMA busy_timeout=5000');return db
    def get(self,key,default=None):
        with self.connect() as db:
            row=db.execute('SELECT body FROM state WHERE key=?',(key,)).fetchone()
            return json.loads(row[0]) if row else default
    def put(self,**values):
        with self.connect() as db:
            for key,value in values.items():db.execute('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',(key,compact(value)))
    def snapshot(self):
        with self.connect() as db:
            return {k:json.loads(v) for k,v in db.execute('SELECT key,body FROM state')}

class Gateway:
    def __init__(self,config):
        self.config=config;self.connections={};self.last=0;self.requests=0;self.verifier=None
    def request(self,url,path,body=None):
        u=urlsplit(url);require(u.scheme=='https' and not u.username and not u.password and not u.query and not u.fragment,'endpoint')
        time.sleep(max(0,0.2-(time.monotonic()-self.last)));self.last=time.monotonic()
        for attempt in range(2):
            conn=self.connections.setdefault(url,http.client.HTTPSConnection(u.hostname,u.port or 443,timeout=25,context=ssl.create_default_context()))
            try:
                self.requests+=1
                conn.request('GET' if body is None else 'POST',u.path.rstrip('/')+path,body=None if body is None else compact(body).encode(),headers={'Content-Type':'application/json','User-Agent':'XMR20-Read-Indexer/0.1'})
                r=conn.getresponse();raw=r.read(32*1024*1024+1)
                require(r.status==200,'upstream-http-'+str(r.status));require(len(raw)<=32*1024*1024,'upstream-size')
                data=json.loads(raw);require(type(data) is dict and 'error' not in data,'upstream-response');return data
            except (OSError,http.client.HTTPException):
                conn.close();self.connections.pop(url,None)
                if attempt:raise Rejected('upstream-connection') from None
    def daemon(self,url,method,params=None,path='/json_rpc'):
        require(url in self.config['daemonUrls'],'daemon-endpoint')
        require((path=='/json_rpc' and method in ('get_info','get_block_header_by_height','get_block')) or (path=='/get_transactions' and method is None),'daemon-method')
        data=self.request(url,path,{'jsonrpc':'2.0','id':1,'method':method,'params':params or {}} if method else params)
        return data.get('result',data)
    def _line(self,timeout):
        ready,_,_=select.select([self.verifier.stdout],[],[],timeout)
        require(bool(ready),'verifier-timeout')
        line=self.verifier.stdout.readline(16384);require(bool(line),'verifier-exit');return json.loads(line)
    def wallet(self,config,method,params):
        require(method in ('verify','validate_address'),'verifier-method')
        if not self.verifier:
            self.verifier=subprocess.Popen([self.config['node'],str(HERE/'verifier.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0,env={'PATH':'/usr/bin:/bin','HOME':str(self.config['dataDir'])})
            require(self._line(60).get('ready') is True,'verifier-start')
        try:
            self.verifier.stdin.write((compact({'method':method,'params':params})+'\n').encode())
            data=self._line(30);require('error' not in data and type(data.get('result')) is dict,'verifier-request');return data['result']
        except Exception:
            self.verifier.kill();self.verifier.wait();self.verifier=None;raise

def catalog_projection(data):
    require(data.get('schema')=='xmr20-launches-v1' and data.get('moneroNetwork')=='mainnet' and data.get('solanaNetwork')=='mainnet-beta','catalog-network')
    rows=data.get('tokens');require(type(rows) is list and 0<len(rows)<=20000,'catalog-size')
    seen=set();mints=set();out=[]
    for source in rows:
        require(type(source) is dict,'catalog-row')
        row={k:source[k] for k in FIELDS if k in source}
        require(ID.fullmatch(row.get('id','')) and row['id'] not in seen,'catalog-id');seen.add(row['id'])
        mint=row.get('mint')
        if mint:require(re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}',mint) and mint not in mints,'catalog-mint');mints.add(mint)
        require(row.get('network')=='mainnet-beta' and row.get('moneroNetwork')=='mainnet','catalog-network')
        require(len(compact(row))<16384,'catalog-row-size');out.append(row)
    return out

def checkpoint(gateway,c,height):
    headers=[gateway.daemon(u,'get_block_header_by_height',{'height':height})['block_header'] for u in c['daemonUrls']]
    require(all(h.get('height')==height and h.get('orphan_status') is False and HASH.fullmatch(h.get('hash','')) for h in headers),'checkpoint-shape')
    require(headers[0]['hash']==headers[1]['hash'],'checkpoint-disagreement')
    return {'height':height,'hash':headers[0]['hash']}

def worker(config,store,stop):
    gateway=Gateway(config);engine=scanner(gateway);cache=engine['scan_cache_path'](config)
    last_catalog=0;catalog=store.get('catalog',[])
    while not stop.is_set():
        try:
            if time.time()-last_catalog>180:
                try:
                    fresh=catalog_projection(gateway.request(config['catalogUrl'],''))
                    old={r['id']:r for r in catalog}
                    for r in fresh:
                        prev=old.get(r['id'])
                        if prev:
                            for key in ('mint','owner','moneroTxid','bridgeVersion','bridgeProgramId','escrowPolicy'):
                                require(not prev.get(key) or prev[key]==r.get(key),'catalog-identity-changed')
                    catalog=fresh;last_catalog=time.time();store.put(catalog=catalog,catalogCheckedAt=int(time.time()*1000))
                except Exception:
                    if not catalog:raise
                    # A saved catalog allows already known tokens to keep indexing.
                    # Its age remains visible; no claim of complete discovery.
            try:scan=engine['scan'](config)
            except ValueError as error:
                if str(error)!='Monero mainnet index is catching up. Retry shortly.':raise
                blocks=json.loads(cache.read_text());height=max(map(int,blocks),default=config['bridgeStartHeight']-1)
                store.put(status={'state':'syncing','indexedHeight':height,'startHeight':config['bridgeStartHeight'],'requests':gateway.requests,'updatedAt':int(time.time()*1000)})
                continue
            cp=checkpoint(gateway,config,scan['height'])
            previous=store.get('published')
            if previous:
                oldcp=checkpoint(gateway,config,previous['checkpoint']['height'])
                if oldcp!=previous['checkpoint']:store.put(published=None)
            store.put(status={'state':'validating','indexedHeight':scan['height'],'blockHash':cp['hash'],'requests':gateway.requests,'updatedAt':int(time.time()*1000)})
            launches=[r for r in catalog if r.get('mint') and r.get('moneroTxid') and not r.get('hidden') and not r.get('halted') and not r.get('cancelledAt')]
            payload={'schemaVersion':1,'policy':config['policy'],'scan':scan,'checkpoint':cp,'projection':{'schema':'xmr20-public-replay-projection-v1','launches':launches,'receipts':[],'holderSnapshots':[]},'solanaUrl':config['solanaUrl']}
            proc=subprocess.run([config['node'],str(HERE/'ledger.mjs'),'--calculate'],input=compact(payload).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=600,env={'PATH':'/usr/bin:/bin','HOME':config['dataDir']})
            require(len(proc.stdout)<32*1024*1024,'ledger-output')
            result=json.loads(proc.stdout)
            if proc.returncode or 'error' in result:raise Rejected(result.get('error','ledger-failed'))
            require(checkpoint(gateway,config,scan['height'])==cp,'checkpoint-changed')
            now=int(time.time()*1000)
            publication={**result,'catalog':catalog,'revision':now,'checkedAt':now,'catalogCheckedAt':store.get('catalogCheckedAt',0)}
            store.put(published=publication,status={'state':'ready','indexedHeight':scan['height'],'blockHash':cp['hash'],'requests':gateway.requests,'updatedAt':now,'accepted':result['accepted']})
            stop.wait(30)
        except Exception as error:
            category=error.args[0] if isinstance(error,Rejected) else 'scanner-or-validation-unavailable'
            if not isinstance(category,str) or not re.fullmatch(r'[a-z0-9.-]{1,100}',category):category='validation-unavailable'
            old=store.get('status',{})
            store.put(status={**old,'state':'delayed','reason':category,'requests':gateway.requests,'updatedAt':int(time.time()*1000)})
            print(compact({'event':'indexer-delayed','category':category}),flush=True);stop.wait(30)

def public_response(path,query,state,now):
    status=state.get('status',{'state':'starting'});publication=state.get('published')
    fresh=bool(publication and now-publication['checkedAt']<=180000 and status.get('state') in ('ready','validating'))
    if path in ('/','/health','/healthz'):
        return 200 if path=='/' or fresh else 503,{'schema':'xmr20-indexer-health-v1','service':'XMR20 independent read indexer','readOnly':True,'ready':fresh,'pendingSupported':False,'catalogSource':'primary-public-catalog','catalogCheckedAt':state.get('catalogCheckedAt',0),'lastVerifiedAt':publication.get('checkedAt') if publication else None,**status}
    if path=='/api/xmr20/pending':return 501,{'error':'Pending receipts are served by the primary service.'}
    if path=='/api/xmr20/tokens':
        return 200,{'schema':'xmr20-launches-v1','moneroNetwork':'mainnet','solanaNetwork':'mainnet-beta','confirmations':10,'tokens':state.get('catalog',[]),'complete':fresh,'catalogSource':'primary-public-catalog','checkedAt':state.get('catalogCheckedAt',0)}
    match=re.fullmatch(r'/api/xmr20/tokens/([a-f0-9-]{36})/holders',path)
    if match:
        id=match[1]
        if not any(r['id']==id for r in state.get('catalog',[])):return 404,{'error':'Not found'}
        snap=next((s for s in (publication or {}).get('snapshots',[]) if s['id']==id),None)
        if not snap:return 200,{'schema':'xmr20-holders-v1','id':id,'moneroNetwork':'mainnet','solanaNetwork':'mainnet-beta','state':'syncing','message':'Independent history validation is not complete.'}
        return 200,{**snap,'stale':not fresh}
    if path in ('/api/wallet-holdings','/api/xmr20/wallet-holdings'):
        if set(query)-{'address','network','after','revision'} or any(len(v)!=1 for v in query.values()):return 400,{'error':'Invalid query'}
        address=query.get('address',[''])[0];network=query.get('network',['monero'])[0]
        if network not in ('monero','solana') or not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{95}' if network=='monero' else r'[1-9A-HJ-NP-Za-km-z]{32,44}',address):return 400,{'error':'Invalid address'}
        if not publication:return 503,{'error':'Independent index is syncing. Balances unavailable.'}
        revision=publication['revision'];after=query.get('after',[''])[0]
        if after and (not ID.fullmatch(after) or query.get('revision',[''])[0]!=str(revision)):return 409,{'error':'Index changed; restart pagination.'}
        rows=[];catalog={r['id']:r for r in publication['catalog']}
        for s in publication['snapshots']:
            r=catalog[s['id']]
            for h in s.get('holders',[]):
                if h['network']!=network or h['address']!=address:continue
                row={'id':s['id'],'mint':s['mint'],'ticker':r.get('ticker',''),'name':r.get('name',''),'image':r.get('image'),'deployment':r['moneroTxid'],'listed':True,'amountRaw':h['amountRaw'],'checkedAt':publication['checkedAt'],'stale':not fresh}
                last=h.get('lastIncoming')
                if network=='monero' and last and last.get('confirmations',0)>=10:
                    row['receipt']={'url':'https://xmrchain.net/tx/'+last['txid'],'label':'Latest bridge credit' if last['operation']=='credit' else 'Latest incoming transfer','confirmations':last['confirmations']}
                rows.append(row)
        rows=sorted((r for r in rows if r['id']>after),key=lambda r:r['id']);page=rows[:100]
        return 200,{'schema':'xmr20-wallet-holdings-v1','address':address,'network':network,'moneroNetwork':'mainnet','solanaNetwork':'mainnet-beta','rows':page,'complete':fresh and now-publication['catalogCheckedAt']<=300000,'checked':publication['checkedAt'],'revision':revision,'nextCursor':page[-1]['id'] if len(rows)>100 else None}
    return 404,{'error':'Not found'}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    config=json.loads(Path(args.config).read_text());root=Path(config['dataDir']);root.mkdir(parents=True,exist_ok=True)
    lock=open(root/'writer.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    store=Store(root/'indexer.sqlite');store.put(status={'state':'starting','updatedAt':int(time.time()*1000)})
    stop=threading.Event()
    threading.Thread(target=worker,args=(config,store,stop),daemon=True).start()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            try:
                if len(self.path)>2048:raise ValueError()
                u=urlsplit(self.path);code,result=public_response(u.path,parse_qs(u.query,keep_blank_values=True),store.snapshot(),int(time.time()*1000))
            except Exception:code,result=400,{'error':'Invalid request'}
            data=compact(result).encode();self.send_response(code)
            for key,value in {'Content-Type':'application/json','Content-Length':str(len(data)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*'}.items():self.send_header(key,value)
            self.end_headers();self.wfile.write(data)
        def do_POST(self):self.send_error(405)
        def do_OPTIONS(self):self.send_response(204);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','GET, OPTIONS');self.end_headers()
    server=ThreadingHTTPServer(('127.0.0.1',config.get('port',8792)),Handler)
    try:server.serve_forever()
    finally:stop.set();server.server_close()

if __name__=='__main__':main()
