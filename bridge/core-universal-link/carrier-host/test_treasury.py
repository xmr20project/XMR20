"""Synthetic treasury reservation/recovery checks; no keys, services or network."""
import unittest,tempfile,types,json,importlib.util
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('broker',Path(__file__).with_name('treasury.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class BrokerTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.calls=[];self.data=m.PROBE;self.fail=False;self.bad_payload=False;self.reserved=set();self.image='d'*64
        self.c=dict(dataDir=str(self.root),address='4'+'a'*94,daemonUrls=['https://a.invalid','https://b.invalid'],feeCapAtomic=1000000)
        self.nft=types.SimpleNamespace(capabilities=lambda:None,fee_plan=lambda size:dict(feeCapAtomic=500000,estimatedFeeAtomic=10,priority=2),fees=types.SimpleNamespace(relay_budget=lambda c,j:None))
        def atomic(path,value):Path(path).write_text(json.dumps(value))
        def reserve(c,root):
            for p in root.glob('transfer-*.json'):
                j=json.loads(p.read_text())
                if j.get('blob'):self.reserved.update(j['spentKeyImages'])
        self.launch=types.SimpleNamespace(carrier=types.SimpleNamespace(wallet=self.wallet,daemon=self.daemon,identity=lambda c:None),atomic=atomic,reserve_signed_inputs=reserve,input_images=lambda blob:[self.image],launch_inputs=lambda c,o:{'subaddr_indices':[5]})
        self.broker=m.Broker(self.c,self.launch,self.nft,leaf_verifier=lambda url:'a'*64)
        self.extract=patch.object(self.broker,'extract',side_effect=lambda blob:self.data if not self.bad_payload else b'WRONG');self.extract.start();self.addCleanup(self.extract.stop)
    def wallet(self,c,method,p=None):
        self.calls.append((method,p))
        if method=='get_version':return dict(xmr20_joint_carrier_version=2,xmr20_joint_transferable_version=3,xmr20_joint_payload_limit=960,xmr20_joint_extra_limit=1060,xmr20_joint_fragment_size=240)
        if method=='refresh':return {}
        if method=='set_daemon':return {}
        if method=='get_height':return {'height':120}
        if method=='incoming_transfers':return {'transfers':[]}
        if method=='get_balance':return {'unlocked_balance':2_000_000_000,'balance':2_000_000_000}
        if method=='verify':return dict(good=True,old=False,version=2,signature_type='spend')
        if method=='transfer':
            if self.fail:raise RuntimeError('SYNTHETIC_LOST_REPLY')
            return dict(tx_hash='a'*64,tx_blob='02aa',fee=100)
        raise AssertionError('Unapproved wallet method '+method)
    def daemon(self,*args):self.calls.append(('daemon',args));return {'status':'OK'}
    def test_reserves_legacy_and_new_signed_inputs_before_returning(self):
        (self.root/'transfer-legacy.json').write_text(json.dumps(dict(blob='LEGACY_FAKE',spentKeyImages=['e'*64])))
        r=self.broker.call('probe',{});self.assertEqual(r['fee'],100)
        self.assertEqual(self.reserved,{'d'*64,'e'*64})
        request=next(p for method,p in self.calls if method=='transfer')
        self.assertIs(request['do_not_relay'],True);self.assertEqual(request['subaddr_indices'],[5]);self.assertEqual(len(bytes.fromhex(request['xmr20_joint_payload_hex'])),960)
        self.assertLessEqual(request['xmr20_joint_fee_cap_atomic'],self.c['feeCapAtomic'])
        self.assertFalse(any(method in ('sign','query_key') for method,p in self.calls))
    def test_saved_probe_recovers_same_bytes_without_second_construction(self):
        first=self.broker.call('probe',{});self.assertEqual(first,self.broker.call('probe',{}));self.assertEqual(sum(method=='transfer' for method,p in self.calls),1)
    def test_lost_construction_reply_blocks_replacement(self):
        self.fail=True
        with self.assertRaises(RuntimeError):self.broker.call('probe',{})
        self.fail=False
        with self.assertRaisesRegex(ValueError,'outcome unknown'):self.broker.call('probe',{})
        self.assertEqual(sum(method=='transfer' for method,p in self.calls),1)
    def test_bad_payload_keeps_durable_inputs_reserved(self):
        self.bad_payload=True
        with self.assertRaises(ValueError):self.broker.call('probe',{})
        self.assertIn(self.image,self.reserved);self.assertTrue(self.broker.path(m.PROBE).exists())
    def test_probe_cannot_relay_even_if_its_blob_is_valid(self):
        r=self.broker.call('probe',{})
        with self.assertRaises(ValueError):self.broker.call('send_raw_transaction',dict(tx_as_hex=r['tx_blob'],do_not_relay=False))
        self.assertFalse(any(method=='daemon' for method,p in self.calls))
    def test_changed_saved_blob_blocks_recovery(self):
        self.broker.call('probe',{});path=self.broker.path(m.PROBE);j=json.loads(path.read_text());j['blob']='ffff';path.write_text(json.dumps(j))
        with self.assertRaises(ValueError):self.broker.call('probe',{})
    def test_strict_public_read_allowlist(self):
        for method in ('query_key','sign','sweep_all','export_key_images'):
            with self.assertRaises(ValueError):self.broker.call(method,{})
        with self.assertRaises(ValueError):self.broker.call('node',dict(index=0,method='send_raw_transaction',params={}))
        with self.assertRaises(ValueError):self.broker.call('node',dict(index=0,method='get_info',params={'config':True}))
        self.assertEqual(self.calls,[])
    def test_owner_signature_required_before_any_construction(self):
        self.assertRaises(ValueError,self.broker.construct,{'privateKey':'must-never-import'})
        self.assertFalse(any(method=='transfer' for method,p in self.calls))
    def test_funding_status_returns_flags_without_balance_or_inputs(self):
        r=self.broker.call('funding-status',{});self.assertEqual(r,{'ready':True,'reason':'funding-available'})
        self.assertNotIn('balance',json.dumps(r));self.assertEqual(self.reserved,set());self.assertFalse(any(method in ('transfer','freeze','refresh') for method,p in self.calls))
    def test_unavailable_slots_do_not_start_construction(self):
        self.launch.launch_inputs=lambda c,o:(_ for _ in ()).throw(ValueError('Slots not ready'))
        self.assertEqual(self.broker.call('funding-status',{}),{'ready':False,'reason':'dedicated-funding-slots-unavailable'})
        self.assertFalse(any(method=='transfer' for method,p in self.calls))
    def test_sync_status_exposes_only_public_height_and_status(self):
        self.carrier=self.launch.carrier;self.carrier.chain=lambda c:121
        self.assertEqual(self.broker.call('sync-status',{}),{'synced':True,'walletHeight':120})
        self.assertFalse(any(method in ('transfer','refresh') for method,p in self.calls))
    def test_current_sync_observation_is_fresh_each_time_and_keeps_threshold(self):
        heights=iter([122,123,123]);self.launch.carrier.chain=lambda c:next(heights)
        self.assertEqual(self.broker.call('sync-status',{}),{'synced':True,'walletHeight':120})
        self.assertFalse(any(method=='refresh' for method,p in self.calls))
        self.assertEqual(self.broker.call('sync-status',{}),{'synced':False,'walletHeight':120})
        self.assertEqual(sum(method=='refresh' for method,p in self.calls),1)
    def test_lagging_wallet_refreshes_then_rechecks_new_chain_height(self):
        heights=iter([124,130]);self.launch.carrier.chain=lambda c:next(heights)
        original=self.launch.carrier.wallet;observations=iter([120,125])
        def wallet(c,method,p=None):
            if method=='get_height':return {'height':next(observations)}
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        self.assertEqual(self.broker.call('sync-status',{}),{'synced':False,'walletHeight':125})
        self.assertEqual(sum(method=='refresh' for method,p in self.calls),1)
    def test_lagging_wallet_can_become_ready_after_one_refresh(self):
        self.launch.carrier.chain=lambda c:130
        original=self.launch.carrier.wallet;observations=iter([120,129])
        def wallet(c,method,p=None):
            if method=='get_height':return {'height':next(observations)}
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        self.assertEqual(self.broker.call('sync-status',{}),{'synced':True,'walletHeight':129})
        self.assertEqual(sum(method=='refresh' for method,p in self.calls),1)
    def test_invalid_sync_observation_never_passes_or_refreshes(self):
        original=self.launch.carrier.wallet
        for bad in (None,True,False,'120',-1,120.5):
            with self.subTest(walletHeight=bad):
                self.launch.carrier.wallet=lambda c,method,p=None: {'height':bad} if method=='get_height' else original(c,method,p)
                self.launch.carrier.chain=lambda c:121
                self.assertRaises(ValueError,self.broker.call,'sync-status',{})
        self.launch.carrier.wallet=original
        for bad in (None,True,False,'121',0,-1,121.5):
            with self.subTest(chainHeight=bad):
                self.launch.carrier.chain=lambda c:bad
                self.assertRaises(ValueError,self.broker.call,'sync-status',{})
        self.assertFalse(any(method in ('refresh','transfer') for method,p in self.calls))
    def test_public_sync_cannot_supply_refresh_flags(self):
        self.assertRaises(ValueError,self.broker.call,'sync-status',{'force_refresh':False})
        self.assertEqual(self.calls,[])
    def test_internal_reconnect_check_still_refreshes_a_current_wallet(self):
        self.launch.carrier.chain=lambda c:121
        self.assertEqual(self.broker.sync_status({},force_refresh=True),{'synced':True,'walletHeight':120})
        self.assertEqual(sum(method=='refresh' for method,p in self.calls),1)
    def test_invalid_post_refresh_heights_never_report_ready(self):
        original=self.launch.carrier.wallet
        for bad in (None,True,'130',-1):
            with self.subTest(walletHeight=bad):
                observations=iter([120,bad]);self.launch.carrier.chain=lambda c:130
                self.launch.carrier.wallet=lambda c,method,p=None: {'height':next(observations)} if method=='get_height' else original(c,method,p)
                self.assertRaises(ValueError,self.broker.call,'sync-status',{})
        self.launch.carrier.wallet=original
        heights=iter([130,True]);self.launch.carrier.chain=lambda c:next(heights)
        self.assertRaises(ValueError,self.broker.call,'sync-status',{})
    def test_sync_observation_rejects_disagreeing_chain_evidence_without_refresh(self):
        self.launch.carrier.chain=lambda c:(_ for _ in ()).throw(ValueError('Synthetic nodes disagree'))
        self.assertRaises(ValueError,self.broker.call,'sync-status',{})
        self.assertFalse(any(method=='refresh' for method,p in self.calls))
    def test_sync_failure_does_not_expose_provider_diagnostic(self):
        self.launch.carrier.chain=lambda c:130
        original=self.launch.carrier.wallet
        def wallet(c,method,p=None):
            if method=='refresh':
                e=ValueError('SYNTHETIC_PRIVATE_MESSAGE');e.code=-9;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        r=self.broker.call('sync-status',{});self.assertEqual(r,{'synced':False,'walletHeight':120,'kind':'wallet-rpc-rejected','walletRpcCode':-9});self.assertNotIn('PRIVATE',json.dumps(r))
    def test_sync_recovers_connection_error_without_signing_or_recursion(self):
        self.launch.carrier.chain=lambda c:123
        original=self.launch.carrier.wallet;connected=[]
        def wallet(c,method,p=None):
            if method=='set_daemon':connected.append(p)
            if method=='get_height' and connected:return {'height':123}
            if method=='refresh' and not connected:
                e=ValueError('SYNTHETIC_PRIVATE_MESSAGE');e.code=-38;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        r=self.broker.call('sync-status',{})
        self.assertTrue(r['synced']);self.assertEqual(r['configuredNodeIndex'],0)
        self.assertEqual(len(connected),1);self.assertIs(connected[0]['ssl_allow_any_cert'],False)
        self.assertIs(connected[0]['trusted'],False);self.assertEqual(connected[0]['ssl_allowed_fingerprints'],['a'*64])
        self.assertFalse(any(method in ('transfer','sign','query_key') for method,p in self.calls))
        self.assertNotIn('PRIVATE',json.dumps(r))
    def test_sync_persistent_connection_error_has_bounded_reconnect(self):
        self.launch.carrier.chain=lambda c:123
        original=self.launch.carrier.wallet
        def wallet(c,method,p=None):
            if method=='refresh':
                e=ValueError('SYNTHETIC_PRIVATE_MESSAGE');e.code=-38;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        r=self.broker.call('sync-status',{})
        self.assertFalse(r['synced']);self.assertEqual(r['walletRpcCode'],-38)
        self.assertEqual(sum(method=='set_daemon' for method,p in self.calls),2)
        self.assertFalse(any(method in ('transfer','sign','query_key') for method,p in self.calls))
    def test_sync_reconnect_keeps_certificate_failure_closed(self):
        self.launch.carrier.chain=lambda c:123
        original=self.launch.carrier.wallet
        def wallet(c,method,p=None):
            if method=='refresh':
                e=ValueError('SYNTHETIC_PRIVATE_MESSAGE');e.code=-38;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        self.broker.leaf_verifier=lambda url:(_ for _ in ()).throw(m.ssl.SSLCertVerificationError('SYNTHETIC_CERT_REJECTED'))
        self.assertRaises(m.ssl.SSLCertVerificationError,self.broker.call,'sync-status',{})
        self.assertFalse(any(method=='set_daemon' for method,p in self.calls))
    def test_reconnect_uses_existing_daemon_with_certificate_verification(self):
        self.launch.carrier.chain=lambda c:121
        r=self.broker.call('reconnect-configured-daemon',{});self.assertTrue(r['synced'])
        request=next(p for method,p in self.calls if method=='set_daemon');self.assertEqual(request['address'],self.c['daemonUrls'][0]);self.assertEqual(request['ssl_support'],'enabled');self.assertIs(request['ssl_allow_any_cert'],False);self.assertIs(request['trusted'],False);self.assertEqual(request['ssl_allowed_fingerprints'],['a'*64]);self.assertEqual(request['ssl_ca_file'],'')
        self.assertFalse(any(method in ('transfer','sign','query_key') for method,p in self.calls))
    def test_reconnect_rejects_caller_endpoints_and_embedded_credentials(self):
        with self.assertRaises(ValueError):self.broker.call('reconnect-configured-daemon',{'address':'https://evil.invalid'})
        self.c['daemonUrls'][0]='https://user:password@test.invalid'
        with self.assertRaises(ValueError):self.broker.call('reconnect-configured-daemon',{})
        self.assertFalse(any(method=='set_daemon' for method,p in self.calls))
    def test_reconnect_can_use_second_configured_node_without_weakening_tls(self):
        self.launch.carrier.chain=lambda c:121
        original=self.launch.carrier.wallet;attempts=[]
        def wallet(c,method,p=None):
            if method=='set_daemon':attempts.append(p)
            if method=='refresh' and len(attempts)==1:
                e=ValueError('SYNTHETIC_UNAVAILABLE');e.code=-38;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        r=self.broker.call('reconnect-configured-daemon',{})
        self.assertTrue(r['synced']);self.assertEqual(r['configuredNodeIndex'],1)
        self.assertEqual([p['address'] for p in attempts],self.c['daemonUrls'])
        self.assertTrue(all(p['ssl_support']=='enabled' and p['ssl_allow_any_cert'] is False and p['trusted'] is False for p in attempts))
    def test_reconnect_does_not_retry_other_rpc_errors(self):
        original=self.launch.carrier.wallet
        def wallet(c,method,p=None):
            if method=='refresh':
                e=ValueError('SYNTHETIC_REJECTED');e.code=-9;raise e
            return original(c,method,p)
        self.launch.carrier.wallet=wallet
        r=self.broker.call('reconnect-configured-daemon',{})
        self.assertEqual(r['walletRpcCode'],-9);self.assertEqual(r['configuredNodeIndex'],0)
        self.assertEqual(sum(method=='set_daemon' for method,p in self.calls),1)
    def test_certificate_verification_failure_cannot_change_wallet_connection(self):
        self.broker.leaf_verifier=lambda url:(_ for _ in ()).throw(m.ssl.SSLCertVerificationError('SYNTHETIC_CERT_REJECTED'))
        self.assertRaises(m.ssl.SSLCertVerificationError,self.broker.call,'reconnect-configured-daemon',{})
        self.assertFalse(any(method=='set_daemon' for method,p in self.calls))
    def test_leaf_verifier_rejects_disabled_ca_or_hostname_checks(self):
        context=types.SimpleNamespace(check_hostname=False,verify_mode=m.ssl.CERT_REQUIRED)
        with patch.object(m.ssl,'create_default_context',return_value=context),patch.object(m.socket,'create_connection') as connection:
            self.assertRaises(ValueError,m.verified_leaf,'https://a.invalid');connection.assert_not_called()
    def test_transaction_discovery_and_complete_reads_accept_only_boolean_pruning(self):
        params=dict(txs_hashes=['a'*64],decode_as_json=True,prune=True)
        for prune in (True,False):
            self.assertEqual(self.broker.call('node',dict(index=0,method='get_transactions',params={**params,'prune':prune})),{'status':'OK'})
        for prune in ('true',0,1,None):
            self.assertRaises(ValueError,self.broker.call,'node',dict(index=0,method='get_transactions',params={**params,'prune':prune}))
        ids=[format(i,'064x') for i in range(65)]
        self.assertEqual(self.broker.call('node',dict(index=1,method='get_transactions',params={**params,'txs_hashes':ids[:64]})),{'status':'OK'})
        for values in ({**params,'txs_hashes':ids},{**params,'prune':False,'txs_hashes':ids[:17]},{**params,'txs_hashes':['a'*64]*2}):
            self.assertRaises(ValueError,self.broker.call,'node',dict(index=0,method='get_transactions',params=values))
        self.assertFalse(any(method in ('transfer','freeze','sign','set_daemon') for method,p in self.calls))
    def test_confirmation_range_is_read_only_and_bounded(self):
        r=self.broker.call('node',{'index':0,'method':'get_block_headers_range','params':{'start_height':100,'end_height':108}});self.assertEqual(r,{'status':'OK'})
        for p in [{'start_height':100,'end_height':116},{'start_height':108,'end_height':100},{'start_height':True,'end_height':108},{'start_height':100,'end_height':108,'privateKey':'SYNTHETIC'}]:
            self.assertRaises(ValueError,self.broker.call,'node',{'index':0,'method':'get_block_headers_range','params':p})
        self.assertFalse(any(method in ('transfer','freeze','sign','set_daemon') for method,p in self.calls))
    def test_new_carrier_requires_j3_capability_and_preserves_old_version(self):
        self.assertEqual(self.broker.capabilities()['profile'],'joint-carrier-v3')
        original=self.launch.carrier.wallet
        def old(c,method,p=None):
            if method=='get_version':return dict(xmr20_joint_carrier_version=2,xmr20_joint_payload_limit=960,xmr20_joint_extra_limit=1060,xmr20_joint_fragment_size=240)
            return original(c,method,p)
        self.launch.carrier.wallet=old
        self.assertRaises(ValueError,self.broker.capabilities)
    def test_link_uses_only_the_native_v3_spend_domain(self):
        r=dict(p='xmr20-joint',v=3,net='mainnet',op='link',owner=self.c['address'],to='4x5FpZshEW9j5Nqs49k7oaAkJDYbe2edKaJD2kwmsRt3',mint='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',program=m.PROGRAM,nonce='ab'*32)
        e=dict(record=r,signature='SigV2'+'1'*88);data=m.MAGIC+m.ordered(e).encode()
        self.assertEqual(self.broker.envelope(data),e)
        verify=next(p for method,p in self.calls if method=='verify')
        self.assertTrue(verify['data'].startswith('XMR20-JOINT-MAINNET-LINK-V3\n'))
        for changed in ({**r,'v':2},{**r,'program':'7U5xdrAJ5DRQmNfhe1cyUCycGm4WXuzR1vSu6DBehq1x'},{**r,'privateKey':'INVALID-FIXTURE'}):
            self.assertRaises(ValueError,self.broker.envelope,m.MAGIC+m.ordered({**e,'record':changed}).encode())
    def test_credit_is_exact_public_backing_record_never_generic_key_operation(self):
        r=dict(p='xmr20-joint',v=3,net='mainnet',op='credit',owner=self.c['address'],by='4x5FpZshEW9j5Nqs49k7oaAkJDYbe2edKaJD2kwmsRt3',mint='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR',program=m.PROGRAM,nonce='ab'*32,amount='42',into='4x5FpZshEW9j5Nqs49k7oaAkJDYbe2edKaJD2kwmsRt3')
        e=dict(record=r);self.assertEqual(self.broker.envelope(m.MAGIC+m.ordered(e).encode()),e)
        for changed in ({**r,'nonce':'0'*64},{**r,'amount':'1e3'},{**r,'mint':'not-a-mint'}):
            self.assertRaises(ValueError,self.broker.envelope,m.MAGIC+m.ordered(dict(record=changed)).encode())
        self.assertFalse(any(method in ('sign','query_key','transfer') for method,p in self.calls))


class IdentityTests(BrokerTests):
    def setUp(self):
        super().setUp()
        original=self.wallet
        def wallet(c,method,p=None):
            v=original(c,method,p)
            if method=='get_version':v['xmr20_wallet_identity_version']=1
            return v
        self.launch.carrier.wallet=wallet
        record=dict(p='xmr20-identity',v=1,net='mainnet',op='link',owner='4'+'a'*94,to='8r3LH9eB3U8VdTGbqrR3cnv8AqMSS4MAZPYH4V2Pg6yF',registry=m.PROGRAM,verifier=m.IDENTITY_VERIFIER,nonce='a'*64)
        self.envelope=dict(record=record,signature='SigV2'+'a'*88)
        self.identity=m.IDENTITY_MAGIC+json.dumps(self.envelope,sort_keys=True,separators=(',',':')).encode()
    def test_identity_checks_separate_native_domain(self):
        self.assertEqual(self.broker.envelope(self.identity),self.envelope)
        msg=next(p['data'] for method,p in self.calls if method=='verify')
        self.assertTrue(msg.startswith('XMR20-WALLET-IDENTITY-MAINNET-V1\n'))
        self.assertFalse(any(method=='transfer' for method,p in self.calls))
    def test_identity_rejects_mint_or_financial_fields(self):
        self.envelope['record']['mint']=m.PROGRAM
        with self.assertRaises(ValueError):self.broker.envelope(m.IDENTITY_MAGIC+json.dumps(self.envelope,sort_keys=True,separators=(',',':')).encode())
    def test_identity_requires_explicit_capability(self):
        self.assertEqual(self.broker.capabilities()['identityVersion'],1)
    def test_new_domain_never_accepts_token_scoped_payload(self):
        with self.assertRaises(ValueError):self.broker.envelope(m.IDENTITY_MAGIC+json.dumps({'record':{'op':'transfer'},'signature':'SigV2'+'a'*88},sort_keys=True,separators=(',',':')).encode())

if __name__=='__main__':unittest.main()
