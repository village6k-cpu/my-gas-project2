import importlib.util
from pathlib import Path
import unittest
s=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collector.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
URL='https://business.kakao.com/space/123/channel/_abc/chats'
class CollectorTests(unittest.TestCase):
 def test_never_selects_business_list_or_room(self):
  self.assertIsNone(m.owned_page([{'id':'business','type':'page','url':URL}],m.list_url(URL)))
 def test_creation_does_not_touch_shared_target(self):
  calls=[];owned={'id':'ours','type':'page','url':m.list_url(URL),'webSocketDebuggerUrl':'ws://local'}
  page,created=m.ensure_owned_page([{'id':'business','type':'page','url':URL}],m.list_url(URL),create=lambda u:(calls.append(u) or {'targetId':'ours'}),refresh=lambda:[owned],wait=lambda _:None)
  self.assertTrue(created);self.assertEqual(page,owned);self.assertEqual(calls,[m.list_url(URL)])
 def test_existing_owned_target_reused_without_creation(self):
  page={'id':'ours','type':'page','url':m.list_url(URL)}
  self.assertEqual(m.ensure_owned_page([page],m.list_url(URL),create=lambda _:self.fail(),refresh=lambda:self.fail(),wait=lambda _:None),(page,False))
 def test_recycled_target_receipt_rejected(self):
  with self.assertRaises(ValueError):m.ensure_owned_page([{'id':'business'}],m.list_url(URL),create=lambda _:{'targetId':'business'},refresh=lambda:[],wait=lambda _:None)
 def test_ambiguous_owned_tabs_not_guessed(self):
  with self.assertRaises(ValueError):m.owned_page([{'type':'page','url':m.list_url(URL)}]*2,m.list_url(URL))
 def test_other_hosts_and_non_list_routes_rejected(self):
  for url in ['https://evil.example/space/1/chats',URL+'/123']:
   with self.assertRaises(ValueError):m.list_url(url)
if __name__=='__main__':unittest.main()
