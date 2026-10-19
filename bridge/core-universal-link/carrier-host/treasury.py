"""Staged transferable J3 carrier broker; configuration is injected; no live settings are loaded here.

Shares the existing lock and durable input reservations with token/NFT workers.
Never imports an owner key or exposes a generic wallet/daemon operation.
"""
import contextlib,fcntl,hashlib,json,re,sys,time,ssl,socket,urllib.request
from pathlib import Path
from urllib.parse import urlsplit

OWN_NODE='http://127.0.0.1:18082'
INDEPENDENT_NODE='https://node.monero.fail:443'
MAGIC=b'XMR20J3'
IDENTITY_MAGIC=b'XMR20I1'
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
IDENTITY_VERIFIER='G3SQSCg3UiQpyFz23jRT4LZG87kkzjYGpBikG2xa2qkc'
PROGRAM='8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB'
FIELDS={'link':{'p','v','net','op','owner','to','mint','program','nonce'},'credit':{'p','v','net','op','owner','by','mint','program','nonce','amount','into'},'transfer':{'p','v','net','op','owner','to','mint','program','nonce','amount','from','into'},'burn':{'p','v','net','op','owner','to','mint','program','nonce','amount','from'}}
PROBE=(MAGIC+b'{"probe":"native-joint-carrier-v3","relay":false}').ljust(960,b' ')
def need(v,m='Joint operator check failed'):
    if not v:raise ValueError(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def ordered(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True)
def exact(p,keys):need(type(p) is dict and set(p)==set(keys),'Unexpected operator fields')
def verified_leaf(url):
    u=urlsplit(url)
    need(u.scheme=='https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in ('','/'))
    context=ssl.create_default_context();context.minimum_version=ssl.TLSVersion.TLSv1_2
    need(context.check_hostname and context.verify_mode==ssl.CERT_REQUIRED)
    with socket.create_connection((u.hostname,u.port or 443),timeout=8) as connection:
        with context.wrap_socket(connection,server_hostname=u.hostname) as secure:
            certificate=secure.getpeercert(binary_form=True);need(certificate)
            return sha(certificate)

class Broker:
    def __init__(self,c,launch,nft,leaf_verifier=verified_leaf,own_node=False):
        need(type(own_node) is bool)
        self.own_node=own_node
        self.c=c;self.launch=launch;self.carrier=launch.carrier;self.nft=nft
        self.phase='startup'
        self.leaf_verifier=leaf_verifier
        self.root=Path(c['dataDir'])
        need(self.root.is_dir() and not self.root.is_symlink())
        need(len(c['daemonUrls'])==2 and c['daemonUrls'][0]!=c['daemonUrls'][1])
        need(type(c['feeCapAtomic']) is int and 0<c['feeCapAtomic']<=1_000_000_000)
    def publication_nodes(self):
        if not self.own_node:return self.c['daemonUrls']
        # Keep legacy node identities/policy unchanged. Only operational wallet
        # syncing and relay use this fixed private SSH tunnel plus public peer.
        need([sha(u.encode())[:16] for u in self.c['daemonUrls']]==['3c8b79f97bd57845','1ea57d8886f53b49'],'Configured peers changed')
        return [OWN_NODE,INDEPENDENT_NODE]
    def publication_daemon(self,url,method,params=None,path='/json_rpc'):
        if url!=OWN_NODE:return self.carrier.daemon(url,method,params,path)
        need(self.own_node and (path=='/json_rpc' and method in ('get_info','get_block_header_by_height') or path=='/send_raw_transaction' and method is None),'Fixed own-node operation required')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):raise ValueError('Own node redirect refused')
        body={'jsonrpc':'2.0','id':'carrier','method':method,'params':params or {}} if method else params
        request=urllib.request.Request(OWN_NODE+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        # This loopback endpoint is the pre-existing authenticated SSH tunnel;
        # never permit redirects, ambient proxies or arbitrary cleartext URLs.
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open(request,timeout=10) as response:
            need(response.status==200);raw=response.read(2_000_001);need(len(raw)<=2_000_000)
        data=json.loads(raw);need(type(data) is dict and 'error' not in data,'Own node rejected operation')
        return data.get('result',data)
    def publication_chain(self):
        if not self.own_node:return self.carrier.chain(self.c)
        urls=self.publication_nodes();rows=[self.publication_daemon(u,'get_info') for u in urls]
        need(all(r.get('status')=='OK' and r.get('untrusted') is False and r.get('mainnet') is True and r.get('nettype')=='mainnet' and r.get('synchronized') is True and r.get('offline') is False and type(r.get('height')) is int and r['height']>0 for r in rows),'Synchronized publication peers required')
        need(abs(rows[0]['height']-rows[1]['height'])<=2,'Publication heights disagree')
        height=min(r['height'] for r in rows)-1
        headers=[self.publication_daemon(u,'get_block_header_by_height',{'height':height}) for u in urls]
        need(all(r.get('status')=='OK' and r.get('untrusted') is False and r.get('block_header',{}).get('height')==height and r['block_header'].get('orphan_status') is False and re.fullmatch('[a-f0-9]{64}',r['block_header'].get('hash','')) for r in headers) and headers[0]['block_header']['hash']==headers[1]['block_header']['hash'],'Publication checkpoints disagree')
        return rows[0]['height']
    def connect_node(self,url):
        if url==OWN_NODE:
            need(self.own_node,'Explicit own-node transport required')
            options=dict(ssl_support='disabled',ssl_allowed_fingerprints=[])
        else:
            u=urlsplit(url);need(u.scheme=='https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in ('','/'))
            self.phase='daemon-tls-verification';fingerprint=self.leaf_verifier(url)
            need(type(fingerprint) is str and re.fullmatch('[a-f0-9]{64}',fingerprint))
            options=dict(ssl_support='enabled',ssl_allowed_fingerprints=[fingerprint])
        self.carrier.wallet(self.c,'set_daemon',dict(address=url,username='',password='',trusted=False,ssl_private_key_path='',ssl_certificate_path='',ssl_ca_file='',ssl_allow_any_cert=False,proxy='',**options))
    @contextlib.contextmanager
    def locked(self):
        path=self.root/'treasury.lock';need(not path.is_symlink())
        with path.open('a') as f:fcntl.flock(f,fcntl.LOCK_EX);yield
    def capabilities(self):
        self.nft.capabilities()
        v=self.carrier.wallet(self.c,'get_version')
        need(all(v.get(k)==x for k,x in dict(xmr20_joint_carrier_version=2,xmr20_joint_transferable_version=3,xmr20_joint_payload_limit=960,xmr20_joint_extra_limit=1060,xmr20_joint_fragment_size=240).items()))
        return dict(profile='joint-carrier-v3',identityVersion=v.get('xmr20_wallet_identity_version',0),payloadLimit=960,extraLimit=1060,fragmentSize=240,sharedTreasuryLock=True,durableInputReservations=True)
    def node(self,p):
        exact(p,['index','method','params']);i=p['index'];method=p['method'];params=p['params']
        need(type(i) is int and i in (0,1) and type(params) is dict)
        if method=='get_info':exact(params,[])
        elif method in ('get_block','get_block_header_by_height'):
            exact(params,['height']);need(type(params['height']) is int and 0<=params['height']<100_000_000)
        elif method=='get_block_headers_range':
            exact(params,['start_height','end_height']);a=params['start_height'];b=params['end_height']
            need(type(a) is int and type(b) is int and 0<=a<=b<100_000_000 and b-a<16)
        elif method=='get_transactions':
            exact(params,['txs_hashes','decode_as_json','prune']);ids=params['txs_hashes']
            need(type(params['prune']) is bool and type(ids) is list and 0<len(ids)<=(64 if params['prune'] else 16) and len(ids)==len(set(ids)) and all(type(x) is str and re.fullmatch('[0-9a-f]{64}',x) for x in ids) and params['decode_as_json'] is True)
        else:raise ValueError('Read-only node method required')
        return self.carrier.daemon(self.c['daemonUrls'][i],None if method=='get_transactions' else method,params,'/get_transactions' if method=='get_transactions' else '/json_rpc')
    def verify_signature(self,p):
        exact(p,['message','address','signature'])
        need(type(p['message']) is str and len(p['message'])<=2000 and type(p['address']) is str and len(p['address'])==95 and type(p['signature']) is str and len(p['signature'])<=120)
        r=self.carrier.wallet(self.c,'verify',dict(data=p['message'],address=p['address'],signature=p['signature']))
        return dict(good=r.get('good') is True and r.get('old') is False and r.get('version')==2 and r.get('signature_type')=='spend')
    def funding_status(self,p):
        exact(p,[]);self.capabilities()
        with self.locked():
            outputs=self.carrier.wallet(self.c,'incoming_transfers',{'transfer_type':'available','account_index':0}).get('transfers',[])
            balance=self.carrier.wallet(self.c,'get_balance',{'account_index':0})
            try:self.launch.launch_inputs(self.c,outputs)
            except ValueError:return dict(ready=False,reason='dedicated-funding-slots-unavailable')
            return dict(ready=balance.get('unlocked_balance',0)>self.c['feeCapAtomic']+1_000_000,reason='funding-available' if balance.get('unlocked_balance',0)>self.c['feeCapAtomic']+1_000_000 else 'unlocked-funding-unavailable')
    def sync_status(self,p,*,force_refresh=False,preserve_daemon=False):
        exact(p,[]);self.capabilities()
        need(type(force_refresh) is bool and type(preserve_daemon) is bool)
        with self.locked():
            before=self.carrier.wallet(self.c,'get_height').get('height')
            need(type(before) is int and before>=0,'Valid public wallet height required')
            if not force_refresh:
                # A current wallet needs only a fresh agreed daemon height.
                # Repeated bridge reads must not force a treasury rescan while
                # still using the same synchronization threshold as below.
                height=self.publication_chain()
                need(type(height) is int and height>0,'Valid public chain height required')
                if before>=height-2:return dict(synced=True,walletHeight=before)
            if self.own_node and not preserve_daemon:self.connect_node(self.publication_nodes()[0])
            try:self.carrier.wallet(self.c,'refresh')
            except Exception as e:
                result=dict(synced=False,kind='wallet-rpc-rejected' if type(getattr(e,'code',None)) is int else 'wallet-transport-unavailable',walletHeight=before)
                if type(getattr(e,'code',None)) is int and -1000<=e.code<0:result['walletRpcCode']=e.code
                return result
            after=self.carrier.wallet(self.c,'get_height').get('height');height=self.publication_chain()
            need(type(after) is int and after>=0 and type(height) is int and height>0,'Valid public synchronization heights required')
            return dict(synced=after>=height-2,walletHeight=after)
    def reconnect(self,p):
        # Restore the native wallet's connection to an EXISTING independently
        # checked daemon. Certificate verification stays enabled; no keys move.
        exact(p,[]);self.capabilities()
        urls=self.publication_nodes()
        for url in urls:
            u=urlsplit(url)
            need(self.own_node and url==OWN_NODE or u.scheme=='https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment and u.path in ('','/'))
        for index,url in enumerate(urls):
            with self.locked():self.connect_node(url)
            result=self.sync_status({},force_refresh=True,preserve_daemon=True)
            if result.get('synced') is True or result.get('walletRpcCode')!=-38:
                return {**result,'configuredNodeIndex':index}
        return {**result,'configuredNodeIndex':index}
    def identity_envelope(self,data):
        need(type(data) is bytes and 10<=len(data)<=960 and data.startswith(IDENTITY_MAGIC))
        e=json.loads(data[7:]);exact(e,['record','signature']);r=e['record']
        exact(r,['p','v','net','op','owner','to','registry','verifier','nonce'])
        need(r['p']=='xmr20-identity' and type(r['v']) is int and r['v']==1 and r['net']=='mainnet' and r['op']=='link' and r['registry']==PROGRAM and r['verifier']==IDENTITY_VERIFIER)
        need(data==IDENTITY_MAGIC+json.dumps(e,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())
        need(type(r['owner']) is str and len(r['owner'])==95 and all(x in B58 for x in r['owner']))
        need(type(r['nonce']) is str and re.fullmatch('[a-f0-9]{64}',r['nonce']) and r['nonce']!='0'*64)
        for name in ['to','registry','verifier']:need(type(r[name]) is str and 32<=len(r[name])<=44 and all(x in B58 for x in r[name]))
        need(r['to']!=r['verifier'] and type(e['signature']) is str and re.fullmatch('SigV2[1-9A-HJ-NP-Za-km-z]{80,110}',e['signature']))
        message='XMR20-WALLET-IDENTITY-MAINNET-V1\n'+json.dumps(r,sort_keys=True,separators=(',',':'),ensure_ascii=False)
        result=self.carrier.wallet(self.c,'verify',dict(data=message,address=r['owner'],signature=e['signature']))
        need(result.get('good') is True and result.get('old') is False and result.get('version')==2 and result.get('signature_type')=='spend','Native identity ownership signature required')
        return e
    def envelope(self,data):
        if data.startswith(IDENTITY_MAGIC):return self.identity_envelope(data)
        need(data.startswith(MAGIC) and len(data)<=960)
        e=json.loads(data[len(MAGIC):]);r=e.get('record')
        need(type(r) is dict and r.get('op') in FIELDS)
        exact(e,['record'] if r['op']=='credit' else ['record','signature']);exact(r,FIELDS[r['op']])
        need(r['p']=='xmr20-joint' and r['v']==3 and r['net']=='mainnet' and r['program']==PROGRAM)
        alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        def public_key(value):
            need(type(value) is str and 32<=len(value)<=44 and all(c in alphabet for c in value))
            n=0
            for c in value:n=n*58+alphabet.index(c)
            size=(len(value)-len(value.lstrip('1')))+(n.bit_length()+7)//8
            need(size==32)
        public_key(r['mint'])
        for key in ('by','from','into'):
            if key in r:public_key(r[key])
        if r['op'] in ('link','burn'):public_key(r['to'])
        if r['op']=='transfer':need(type(r['to']) is str and len(r['to'])==95 and r['to']!=r['owner'])
        need(type(r['owner']) is str and len(r['owner'])==95)
        need(type(r['nonce']) is str and re.fullmatch('[a-f0-9]{64}',r['nonce']) and int(r['nonce'],16)>0)
        if r['op']!='link':need(type(r['amount']) is str and re.fullmatch('[1-9][0-9]{0,13}',r['amount']) and int(r['amount'])<=50_000_000_000_000)
        need(data==MAGIC+ordered(e).encode(),'Noncanonical public envelope')
        if r['op']!='credit':
            need(type(e['signature']) is str and re.fullmatch('SigV2[1-9A-HJ-NP-Za-km-z]{80,110}',e['signature']))
            domain='XMR20-JOINT-MAINNET-'+r['op'].upper()+'-V3\n'
            need(self.verify_signature(dict(message=domain+ordered(r),address=r['owner'],signature=e['signature']))['good'],'Owner spend signature required')
        # Credits need finalized backing and recipient proofs in the verified
        # service before construction; an invented carrier cannot pass replay.
        return e
    def extract(self,blob):
        # Existing parser validates native transaction prefix/key inputs. Joint
        # complete transaction hash and Bulletproof+ framing are checked in JS.
        extra=self.carrier.signed_extra(blob);r=self.carrier.Reader(bytes(extra));parts=[]
        while r.at<len(r.b):
            tag=r.byte()
            if tag==0:need(all(x==0 for x in r.take(len(r.b)-r.at)))
            elif tag==1:r.take(32)
            elif tag==4:r.take(32*r.varint(16))
            elif tag==2:
                s=r.take(r.varint(255))
                if s.startswith((b'XM3',b'XMI')):parts.append(s)
            else:raise ValueError('Unknown carrier tag')
        need(0<len(parts)<=4)
        for i,s in enumerate(parts):need(5<len(s)<=245 and s[3]==i and s[4]==len(parts) and (i==len(parts)-1 or len(s)==245))
        data=b''.join(s[5:] for s in parts);need(data.startswith((MAGIC,IDENTITY_MAGIC)) and len(data)<=960 and len(extra)<=1060)
        need(all(p[:3]==(b'XMI' if data.startswith(IDENTITY_MAGIC) else b'XM3') for p in parts))
        return data
    def path(self,data):return self.root/('transfer-joint-v3-'+sha(data)+'.json')
    def verify_saved(self,j,data):
        need(j['blobSha256']==sha(bytes.fromhex(j['blob'])) and self.extract(j['blob'])==data and self.launch.input_images(j['blob'])==j['spentKeyImages'])
        need(type(j['feeAtomic']) is int and 0<j['feeAtomic']<=min(j['feeCapAtomic'],self.c['feeCapAtomic']))
        if not j.get('probe'):self.envelope(data)
    def construct(self,p,probe=False):
        if probe:exact(p,[]);data=PROBE;cap=self.c['feeCapAtomic']
        else:
            keys=['destinations','account_index','priority','ring_size','unlock_time','do_not_relay','get_tx_hex','get_tx_key','get_tx_metadata','xmr20_joint_payload_hex','xmr20_joint_fee_cap_atomic'];exact(p,keys)
            need(p['destinations']==[dict(address=self.c['address'],amount=1_000_000)] and p['account_index']==0 and p['priority']==2 and p['ring_size']==0 and p['unlock_time']==0 and p['do_not_relay'] is True and p['get_tx_hex'] is True and p['get_tx_key'] is False and p['get_tx_metadata'] is False)
            need(type(p['xmr20_joint_payload_hex']) is str and re.fullmatch('[a-f0-9]+',p['xmr20_joint_payload_hex']) and len(p['xmr20_joint_payload_hex'])<=1920)
            data=bytes.fromhex(p['xmr20_joint_payload_hex']);self.envelope(data);cap=p['xmr20_joint_fee_cap_atomic'];need(type(cap) is int and 0<cap<=1_000_000_000);cap=min(cap,self.c['feeCapAtomic'])
        self.phase='capabilities';capabilities=self.capabilities();path=self.path(data)
        if data.startswith(IDENTITY_MAGIC):need(capabilities.get('identityVersion')==1,'Identity carrier capability required')
        with self.locked():
            if path.exists():
                need(not path.is_symlink());j=json.loads(path.read_text());self.verify_saved(j,data);self.launch.reserve_signed_inputs(self.c,self.root)
            else:
                marker=path.with_suffix('.constructing.json');need(not marker.exists(),'Construction outcome unknown; recover before retrying')
                self.phase='existing-input-reservations';self.launch.reserve_signed_inputs(self.c,self.root)
                if self.own_node:self.connect_node(self.publication_nodes()[0])
                self.phase='wallet-refresh';self.carrier.wallet(self.c,'refresh')
                self.phase='funding-status'
                outputs=self.carrier.wallet(self.c,'incoming_transfers',{'transfer_type':'available','account_index':0}).get('transfers',[])
                self.phase='funding-slots';selection=self.launch.launch_inputs(self.c,outputs)
                self.phase='fee-policy';plan=self.nft.fee_plan(len(data));cap=min(cap,plan['feeCapAtomic']);need(plan['estimatedFeeAtomic']<=cap)
                request=dict(**selection,destinations=[dict(address=self.c['address'],amount=1_000_000)],account_index=0,priority=plan['priority'],ring_size=0,unlock_time=0,do_not_relay=True,get_tx_hex=True,get_tx_key=False,get_tx_metadata=False,xmr20_joint_payload_hex=data.hex(),xmr20_joint_fee_cap_atomic=cap)
                # The marker precedes construction. The durable blob precedes
                # every later validation, so failed checks cannot free inputs.
                self.phase='native-construction';self.launch.atomic(marker,dict(startedAt=int(time.time()),payloadSha256=sha(data),probe=probe))
                tx=self.carrier.wallet(self.c,'transfer',request)
                j=dict(txid=tx['tx_hash'],blob=tx['tx_blob'],blobSha256=sha(bytes.fromhex(tx['tx_blob'])),feeAtomic=tx['fee'],feeCapAtomic=cap,payloadHex=data.hex(),spentKeyImages=self.launch.input_images(tx['tx_blob']),probe=probe,feePolicy=plan,attempts=[])
                self.phase='reservation';self.launch.atomic(path,j);self.launch.reserve_signed_inputs(self.c,self.root);self.verify_saved(j,data)
            return dict(tx_hash=j['txid'],tx_blob=j['blob'],fee=j['feeAtomic'])
    def relay(self,p):
        exact(p,['tx_as_hex','do_not_relay']);need(p['do_not_relay'] is False and type(p['tx_as_hex']) is str and len(p['tx_as_hex'])<=200000)
        data=self.extract(p['tx_as_hex']);path=self.path(data);need(path.exists() and not path.is_symlink())
        self.capabilities()
        with self.locked():
            j=json.loads(path.read_text());need(j.get('probe') is False and j['blob']==p['tx_as_hex']);self.verify_saved(j,data)
            need(len(j['attempts'])<3,'Saved relay retry limit reached')
            self.nft.fees.relay_budget(self.c,j)
            j['attempts'].append(dict(at=int(time.time()),outcome='unknown'));self.launch.atomic(path,j)
            result=self.publication_daemon(self.publication_nodes()[(len(j['attempts'])-1)%2],None,p,'/send_raw_transaction')
            if result.get('status')=='OK' and not result.get('not_relayed'):j['attempts'][-1]['outcome']='accepted';self.launch.atomic(path,j)
            return result
    def call(self,method,p):
        if method=='joint-capabilities':exact(p,[]);return self.capabilities()
        if method=='carrier-address':exact(p,[]);self.carrier.identity(self.c);return self.c['address']
        if method=='node-identities':exact(p,[]);return [sha(u.encode())[:16] for u in self.c['daemonUrls']]
        if method=='node':return self.node(p)
        if method=='verify':return self.verify_signature(p)
        if method=='funding-status':return self.funding_status(p)
        if method=='sync-status':
            result=self.sync_status(p)
            # A lost daemon connection must not strand an already-approved
            # publication. Reconnect only for this specific RPC error, using
            # the existing configured peers and verified TLS certificates.
            # reconnect calls sync_status directly, so this cannot recurse.
            if result.get('walletRpcCode')==-38:return self.reconnect({})
            return result
        if method=='reconnect-configured-daemon':return self.reconnect(p)
        if method=='transfer':return self.construct(p)
        if method=='probe':return self.construct(p,probe=True)
        if method=='send_raw_transaction':return self.relay(p)
        raise ValueError('Operator method is not permitted')
