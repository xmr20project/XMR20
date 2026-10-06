import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'build'))
from service import Store,Gateway,Rejected,catalog_projection,public_response
from scanner import scanner

class EmptyChain:
    def __init__(self):self.changed=False
    def header(self,h):return {'height':h,'hash':format(h+(1000 if self.changed and h>=112 else 0),'064x'),'prev_hash':format(h-1+(1000 if self.changed and h>112 else 0),'064x'),'orphan_status':False}
    def daemon(self,url,method,params=None,path='/json_rpc'):
        if method=='get_info':return {'status':'OK','nettype':'mainnet','mainnet':True,'synchronized':True,'offline':False,'height':115}
        if method=='get_block_header_by_height':return {'block_header':self.header(params['height'])}
        if method=='get_block':return {'block_header':self.header(params['height']),'tx_hashes':[]}
        raise AssertionError('Unexpected RPC')
    def wallet(self,*args):raise AssertionError('No events need verification')

class ServiceTests(unittest.TestCase):
    def test_scan_catchup_and_reorg_replaces_only_invalid_suffix(self):
        with tempfile.TemporaryDirectory() as temp:
            g=EmptyChain();engine=scanner(g);c={'network':'mainnet','address':'synthetic','bridgeStartHeight':100,'transferStartHeight':100,'daemonUrls':['a','b'],'dataDir':temp}
            with self.assertRaisesRegex(ValueError,'catching up'):engine['scan'](c)
            result=engine['scan'](c);self.assertEqual(result['height'],114)
            before=json.loads(engine['scan_cache_path'](c).read_text());g.changed=True
            engine['scan'](c);after=json.loads(engine['scan_cache_path'](c).read_text())
            self.assertEqual(before['111'],after['111']);self.assertNotEqual(before['112']['hash'],after['112']['hash'])
    def test_rpc_allowlist_rejects_mutation_before_network(self):
        g=Gateway({'daemonUrls':['https://example.invalid']})
        with patch.object(g,'request',side_effect=AssertionError('Network')):
            with self.assertRaises(Rejected):g.daemon('https://example.invalid',None,{},'/send_raw_transaction')
            with self.assertRaises(Rejected):g.wallet({},'transfer',{})
    def test_no_partial_balances_or_fake_pending(self):
        q={'address':['4'+'A'*94]}
        self.assertEqual(public_response('/api/wallet-holdings',q,{},1000)[0],503)
        self.assertEqual(public_response('/api/xmr20/pending',q,{},1000)[0],501)
        self.assertFalse(public_response('/health',{}, {'status':{'state':'syncing'}},1000)[1]['ready'])
    def test_snapshot_stale_and_revision(self):
        pub={'checkedAt':1000,'revision':1000,'catalogCheckedAt':1000,'snapshots':[],'catalog':[]}
        state={'published':pub,'status':{'state':'ready'}};q={'address':['4'+'A'*94]}
        self.assertTrue(public_response('/api/wallet-holdings',q,state,1100)[1]['complete'])
        self.assertFalse(public_response('/api/wallet-holdings',q,state,200000)[1]['complete'])
        state['status']['state']='syncing';self.assertFalse(public_response('/api/wallet-holdings',q,state,1100)[1]['complete'])
        q.update(after=['11111111-1111-4111-8111-111111111111'],revision=['999'])
        self.assertEqual(public_response('/api/wallet-holdings',q,state,1100)[0],409)
    def test_sqlite_atomic_restart_and_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'indexer.sqlite';s=Store(path);s.put(published={'revision':1},status={'state':'ready'})
            with self.assertRaises(ValueError):s.put(published={'revision':2},status=float('nan'))
            self.assertEqual(Store(path).get('published')['revision'],1)
            import sqlite3
            with s.connect() as source,sqlite3.connect(Path(temp)/'backup.sqlite') as dest:source.backup(dest)
            self.assertEqual(Store(Path(temp)/'backup.sqlite').get('published')['revision'],1)
    def test_catalog_only_known_public_fields_and_no_duplicate_ids(self):
        row={'id':'11111111-1111-4111-8111-111111111111','network':'mainnet-beta','moneroNetwork':'mainnet','unrecognized':'discard'}
        data={'schema':'xmr20-launches-v1','moneroNetwork':'mainnet','solanaNetwork':'mainnet-beta','tokens':[row]}
        self.assertNotIn('unrecognized',catalog_projection(data)[0]);data['tokens'].append(row)
        with self.assertRaises(Rejected):catalog_projection(data)

if __name__=='__main__':unittest.main()
