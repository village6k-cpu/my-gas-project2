"""Real local TCP tests; no production service or browser is contacted."""
import os,socket,unittest
from pathlib import Path

def probe(port):
    with socket.socket() as stream:
        stream.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        stream.bind(('127.0.0.1',port))

class PortProbeTests(unittest.TestCase):
    def test_running_incumbent_is_still_protected(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(('127.0.0.1',0));server.listen()
            with self.assertRaises(OSError):probe(server.getsockname()[1])
    def test_closed_connection_time_wait_does_not_block_restart(self):
        server=socket.socket();server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        server.bind(('127.0.0.1',0));server.listen();port=server.getsockname()[1]
        client=socket.create_connection(('127.0.0.1',port));accepted,_=server.accept()
        accepted.shutdown(socket.SHUT_WR);client.recv(1);accepted.close();client.close();server.close()
        with socket.socket() as old_probe:
            with self.assertRaises(OSError):old_probe.bind(('127.0.0.1',port))
        probe(port)
    def test_installed_launcher_uses_the_verified_probe_option(self):
        source=(Path(os.environ['VILLAGE_RUNTIME_ROOT'])/'control/village-runtime.py').read_text()
        self.assertIn('probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)',source)
        self.assertIn('fd=acquire_service_lock(plan)',source)

if __name__=='__main__':unittest.main()
