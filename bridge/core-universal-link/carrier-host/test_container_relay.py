import importlib.util,socket,threading,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('relay',Path(__file__).with_name('container-node-relay.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class RelayTests(unittest.TestCase):
    def test_binary_request_and_response_preserved(self):
        server=socket.socket();server.bind(('127.0.0.1',0));server.listen(1)
        request=bytes(range(256))*4096;response=b'\x00\xff\x03RESPONSE'*5000;seen=[]
        def upstream():
            peer,_=server.accept();data=b''
            while len(data)<len(request):data+=peer.recv(65536)
            seen.append(data);peer.sendall(response);peer.close();server.close()
        th=threading.Thread(target=upstream);th.start();client,proxy=socket.socketpair();client.settimeout(5)
        self.assertTrue(m.LIMIT.acquire(False));worker=threading.Thread(target=m.relay,args=(proxy,server.getsockname()));worker.start()
        client.sendall(request);data=b''
        while len(data)<len(response):data+=client.recv(65536)
        client.close();worker.join(6);th.join(6)
        self.assertEqual(seen,[request]);self.assertEqual(data,response);self.assertFalse(worker.is_alive())
    def test_unavailable_upstream_closes_and_releases_slot(self):
        client,proxy=socket.socketpair();client.settimeout(1);self.assertTrue(m.LIMIT.acquire(False))
        with patch.object(m.socket,'create_connection',side_effect=OSError):m.relay(proxy)
        self.assertEqual(client.recv(1),b'');client.close()
        self.assertTrue(m.LIMIT.acquire(False));m.LIMIT.release()
    def test_refuses_host_namespace_before_bind(self):
        class Stat:st_ino=123
        with patch.object(m.os,'open',side_effect=[10,11]),patch.object(m.os,'fstat',return_value=Stat()),patch.object(m.os,'close'),patch.object(m.socket,'socket') as sock:
            self.assertRaises(ValueError,m.listen_in_container,123);sock.assert_not_called()
    def test_inactive_container_refused_before_namespace(self):
        with patch.object(m.subprocess,'check_output',return_value=b'0'),patch.object(m,'listen_in_container') as listen:
            self.assertRaises(ValueError,m.main);listen.assert_not_called()
if __name__=='__main__':unittest.main()
