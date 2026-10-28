import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))
from copy import deepcopy
from datetime import datetime
import unittest
import migration_final_cron


class FinalCronTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {'jobs': [{'id':'job-1','prompt':'unchanged business instruction',
            'workdir':'C:/Village/runtime','schedule':{'kind':'cron','expr':'*/10 * * * *'},
            'repeat':{'times':None,'completed':12},'enabled':True,'state':'scheduled',
            'next_run_at':'2026-09-30T16:40:00+09:00', 'last_run_at':'2026-09-30T16:30:02+09:00',
            'last_status':'success','fire_claim':None}], 'updated_at':'old'}
        self.native=deepcopy(self.baseline)
        self.native['jobs'][0]['workdir']='/Users/fixture/candidate/runtime'
        self.latest=deepcopy(self.baseline)
        self.latest['updated_at']='latest'
        self.latest['jobs'][0].update(next_run_at='2026-10-01T16:50:00+09:00',
            last_run_at='2026-10-01T16:40:04+09:00',repeat={'times':None,'completed':156})
        self.now=datetime.fromisoformat('2026-10-01T16:57:00+09:00')

    def build(self):
        return migration_final_cron.prepare(self.latest,self.baseline,self.native,now=self.now)

    def test_preserves_latest_history_and_advances_past_due_without_replay(self):
        original=deepcopy(self.latest)
        result=self.build()
        job=result['document']['jobs'][0]
        self.assertEqual(job['workdir'],'/Users/fixture/candidate/runtime')
        self.assertEqual(job['repeat'],{'times':None,'completed':156})
        self.assertEqual(job['last_run_at'],'2026-10-01T16:40:04+09:00')
        self.assertEqual(job['next_run_at'],'2026-10-01T17:00:00+09:00')
        self.assertEqual(result['document']['updated_at'],'latest')
        self.assertEqual(self.latest,original)
        self.assertFalse(result['activated'])

    def test_future_run_is_preserved(self):
        self.latest['jobs'][0]['next_run_at']='2026-10-01T17:10:00+09:00'
        self.assertEqual(self.build()['document']['jobs'][0]['next_run_at'],'2026-10-01T17:10:00+09:00')

    def test_new_job_or_changed_business_configuration_blocks(self):
        for key,value in [('prompt','new rule'),('schedule',{'kind':'cron','expr':'* * * * *'}),
                          ('enabled',False),('new_setting',True)]:
            with self.subTest(key=key):
                changed=deepcopy(self.latest);changed['jobs'][0][key]=value
                with self.assertRaises(ValueError):
                    migration_final_cron.prepare(changed,self.baseline,self.native,now=self.now)
        self.latest['jobs'].append({**self.latest['jobs'][0],'id':'new-job'})
        with self.assertRaises(ValueError):self.build()

    def test_native_rules_and_repeat_limit_cannot_change(self):
        self.native['jobs'][0]['prompt']='quietly weaker rule'
        with self.assertRaises(ValueError):self.build()
        self.native=deepcopy(self.baseline)
        self.latest['jobs'][0]['repeat']['times']=2
        with self.assertRaises(ValueError):self.build()

    def test_unsettled_fire_or_unknown_timezone_blocks(self):
        self.latest['jobs'][0]['fire_claim']={'at':'2026-10-01T16:50:00+09:00','by':'windows'}
        with self.assertRaises(ValueError):self.build()
        self.latest['jobs'][0]['fire_claim']=None
        self.latest['jobs'][0]['next_run_at']='2026-10-01T16:50:00'
        with self.assertRaises(ValueError):self.build()


if __name__=='__main__':unittest.main()
