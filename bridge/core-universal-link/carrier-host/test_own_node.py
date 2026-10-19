import unittest,json,types,tempfile
from pathlib import Path
from unittest.mock import patch
import test_treasury as fixtures
m=fixtures.m

class OwnNodeTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.BrokerTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.f.c['daemonUrls']=['https://xmr.triplebit.org:443',m.INDEPENDENT_NODE]
        self.b=m.Broker(self.f.c,self.f.launch,self.f.nft,leaf_verifier=lambda url:'b'*64,own_node=True)
        self.calls=[]
        def daemon(url,method,params=None,path='/json_rpc'):
            self.calls.append((url,method,params,path))
            if method=='get_info':return dict(status='OK',untrusted=False,mainnet=True,nettype='mainnet',synchronized=True,offline=False,height=123)
            if method=='get_block_header_by_height':return dict(status='OK',untrusted=False,block_header=dict(height=params['height'],hash='a'*64,orphan_status=False))
            return {'status':'OK'}
        self.daemon=daemon
    def test_policy_identities_do_not_change(self):
        before=json.dumps(self.f.c,sort_keys=True)
        self.assertEqual(self.b.publication_nodes(),[m.OWN_NODE,m.INDEPENDENT_NODE])
        self.assertEqual(self.b.call('node-identities',{}),['3c8b79f97bd57845','1ea57d8886f53b49'])
        self.assertEqual(json.dumps(self.f.c,sort_keys=True),before)
        self.f.c['daemonUrls'][0]='https://unknown.invalid'
        self.assertRaises(ValueError,self.b.publication_nodes)
    def test_primary_and_independent_checkpoint_must_agree(self):
        self.b.publication_daemon=self.daemon
        self.assertEqual(self.b.publication_chain(),123)
        self.assertEqual([r[0] for r in self.calls],[m.OWN_NODE,m.INDEPENDENT_NODE]*2)
        for change in ['hash','height','synchronized','untrusted']:
            def bad(url,method,params=None,path='/json_rpc'):
                r=self.daemon(url,method,params,path)
                if url==m.INDEPENDENT_NODE:
                    if change=='hash' and method=='get_block_header_by_height':r['block_header']['hash']='b'*64
                    if change=='height' and method=='get_info':r['height']=127
                    if change=='synchronized' and method=='get_info':r['synchronized']=False
                    if change=='untrusted' and method=='get_info':r['untrusted']=True
                return r
            self.b.publication_daemon=bad
            with self.subTest(change=change):self.assertRaises(ValueError,self.b.publication_chain)
    def test_sync_refresh_selects_own_tunnel_and_keeps_untrusted(self):
        self.b.publication_daemon=self.daemon
        r=self.b.call('sync-status',{})
        self.assertFalse(r['synced']) # Fixture wallet stays behind; no fake success.
        methods=[method for method,p in self.f.calls]
        self.assertLess(methods.index('set_daemon'),methods.index('refresh'))
        request=next(p for method,p in self.f.calls if method=='set_daemon')
        self.assertEqual(request['address'],m.OWN_NODE);self.assertEqual(request['ssl_support'],'disabled')
        self.assertIs(request['trusted'],False);self.assertIs(request['ssl_allow_any_cert'],False)
        self.assertFalse(any(method in ('transfer','sign','query_key') for method in methods))
    def test_reconnect_primary_then_verified_independent_fallback(self):
        self.b.publication_daemon=self.daemon;original=self.f.launch.carrier.wallet;connections=[]
        def wallet(c,method,p=None):
            if method=='set_daemon':connections.append(p)
            if method=='refresh' and connections[-1]['address']==m.OWN_NODE:
                e=ValueError('SYNTHETIC_UNAVAILABLE');e.code=-38;raise e
            if method=='get_height':return {'height':123}
            return original(c,method,p)
        self.f.launch.carrier.wallet=wallet
        r=self.b.call('reconnect-configured-daemon',{})
        self.assertTrue(r['synced']);self.assertEqual(r['configuredNodeIndex'],1)
        self.assertEqual([p['address'] for p in connections],[m.OWN_NODE,m.INDEPENDENT_NODE])
        self.assertEqual(connections[1]['ssl_support'],'enabled');self.assertEqual(connections[1]['ssl_allowed_fingerprints'],['b'*64])
        self.assertTrue(all(p['trusted'] is False and p['ssl_allow_any_cert'] is False for p in connections))
    def test_only_fixed_loopback_can_disable_tls(self):
        for bad in ['http://evil.invalid','http://127.0.0.1:18083','http://localhost:18082','http://127.0.0.1:18082/','https://user:pass@evil.invalid']:
            self.assertRaises(ValueError,self.b.connect_node,bad)
        self.assertEqual(self.f.calls,[])
    def test_exact_saved_relay_uses_own_node_then_fallback_without_new_construction(self):
        data=b'SYNTHETIC_PUBLIC_APPROVAL';blob='02aa';self.b.extract=lambda raw:data;self.b.verify_saved=lambda j,d:None
        j=dict(blob=blob,probe=False,attempts=[]);path=self.b.path(data);path.write_text(json.dumps(j));self.b.publication_daemon=self.daemon
        for i in range(3):self.b.call('send_raw_transaction',dict(tx_as_hex=blob,do_not_relay=False))
        self.assertEqual([r[0] for r in self.calls],[m.OWN_NODE,m.INDEPENDENT_NODE,m.OWN_NODE])
        self.assertTrue(all(r[2]==dict(tx_as_hex=blob,do_not_relay=False) and r[3]=='/send_raw_transaction' for r in self.calls))
        self.assertRaises(ValueError,self.b.call,'send_raw_transaction',dict(tx_as_hex=blob,do_not_relay=False))
        self.assertFalse(any(method=='transfer' for method,p in self.f.calls))
    def test_own_http_transport_rejects_redirects_and_ignores_proxies(self):
        response=types.SimpleNamespace(status=200,read=lambda n:b'{"result":{"status":"OK"}}')
        response.__enter__=lambda s:s
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return b'{"result":{"status":"OK"}}'
        opener=types.SimpleNamespace(open=lambda req,timeout:Response())
        with patch.object(m.urllib.request,'build_opener',return_value=opener) as build:
            self.assertEqual(self.b.publication_daemon(m.OWN_NODE,'get_info'),{'status':'OK'})
            handlers=build.call_args.args;self.assertEqual(handlers[0].proxies,{})
            self.assertRaises(ValueError,handlers[1].redirect_request,None,None,None,None,None,None)
        self.assertRaises(ValueError,self.b.publication_daemon,m.OWN_NODE,'query_key')
        self.assertRaises(ValueError,self.b.publication_daemon,m.OWN_NODE,None,{},'/admin')

if __name__=='__main__':unittest.main()
