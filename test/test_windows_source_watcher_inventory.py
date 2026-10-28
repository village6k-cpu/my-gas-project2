from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
import migration_source_watcher_fence as watcher

class WatcherInventoryTests(unittest.TestCase):
    def management(self,rows):
        return {'api':'chrome.developerPrivate.getExtensionsInfo','complete':True,'extensions':rows}
    def test_explicit_empty_runtime_inventory(self):
        self.assertTrue(watcher.extensions_absent({'result':{'extensions':[]}},self.management([])))
    def test_present_extension_retains_strict_dom_guard(self):
        self.assertFalse(watcher.extensions_absent({'result':{'extensions':[{'id':'fixture'}]}},self.management([])))
    def test_packed_extension_present_with_empty_unpacked_census_refuses_absence(self):
        self.assertFalse(watcher.extensions_absent({'result':{'extensions':[]}},self.management([{'id':'packed-fixture','state':'ENABLED'}])))
    def test_missing_failed_or_unknown_inventory_refuses(self):
        for row in ({},{'error':{'message':'disabled'}},{'result':{}},{'result':{'extensions':None}}):
            with self.assertRaises(RuntimeError):watcher.extensions_absent(row,self.management([]))
        for row in ({},self.management(None),{'api':'unpacked-only','complete':True,'extensions':[]}):
            with self.assertRaises(RuntimeError):watcher.extensions_absent({'result':{'extensions':[]}},row)
    def test_absence_guard_does_not_accept_running_dom_marker(self):
        original="document.documentElement.dataset.villageKakaoExtensionWatcherStatus!=='stopped'"
        text=watcher.allow_verified_absence(original)
        self.assertIn('===undefined',text)
        self.assertIn("!=='stopped'",text)
        with self.assertRaises(RuntimeError):watcher.allow_verified_absence('changed helper')

if __name__=='__main__':unittest.main()
