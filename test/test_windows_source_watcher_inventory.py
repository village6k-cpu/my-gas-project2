from pathlib import Path
import json,shutil,subprocess,sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
import migration_source_watcher_fence as watcher

class WatcherInventoryTests(unittest.TestCase):
    def test_stop_controller_can_use_pinned_cdp_port(self):
        self.assertEqual(watcher.PORT,9223)
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

    def test_management_query_accepts_complete_callback_and_promise_responses(self):
        fixtures=[
            ("(_options,callback)=>callback([])",True),
            ("()=>Promise.resolve([])",True),
            ("(_options,callback)=>{callback([]);return Promise.resolve([]);}",True),
            ("()=>Promise.resolve([{id:'packed',state:'ENABLED'}])",True),
            ("()=>Promise.resolve(null)",False),
            ("()=>Promise.reject(Error('denied'))",False),
            ("()=>{throw Error('denied');}",False),
            ("(_options,callback)=>{chrome.runtime.lastError={message:'denied'};callback([]);}",False),
        ]
        program="""const vm=require('node:vm');
        (async()=>{const results=[];for(const fixture of JSON.parse(process.argv[1])){
          const chrome={runtime:{},developerPrivate:{}};
          const context=vm.createContext({location:{origin:'chrome://extensions'},chrome});
          chrome.developerPrivate.getExtensionsInfo=vm.runInContext(fixture[0],context);
          try{const value=await Promise.race([vm.runInContext(process.argv[2],context),new Promise((_,r)=>setTimeout(()=>r(Error('timeout')),100))]);results.push({ok:true,value});}
          catch(e){results.push({ok:false,error:e.message});}
        }console.log(JSON.stringify(results));})();"""
        q=subprocess.run([shutil.which('node') or 'node','-e',program,json.dumps(fixtures),watcher.MANAGEMENT_EXPRESSION],capture_output=True,text=True,check=True,timeout=5)
        rows=json.loads(q.stdout)
        self.assertEqual([r['ok'] for r in rows],[r[1] for r in fixtures])
        self.assertEqual(rows[0]['value'],self.management([]))
        self.assertEqual(rows[1]['value'],self.management([]))
        self.assertEqual(rows[3]['value']['extensions'][0]['id'],'packed')

if __name__=='__main__':unittest.main()
