import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent));from recovery_policy import evaluate,transition,can_restart_worker,stabilize
class PolicyTests(unittest.TestCase):
 def test_heartbeat_alone_is_not_healthy(self):self.assertIn('collector_not_reading_full_list',evaluate({'authenticated':True,'watcher_ready':False,'bridge_responding':True},{'gateway':{'consumer':{'fresh':True}}}))
 def test_incident_survives_restart_and_only_ack_clears_notification(self):
  s=transition({},['collector'],0);s=transition(s,['collector'],30);self.assertTrue(s['notification_due']);self.assertTrue(transition(s,['collector'],60)['notification_due'])
 def test_healthy_initial_state_does_not_spam(self):self.assertFalse(transition({},[],1)['notification_due'])
 def test_repeat_notice_is_bounded(self):self.assertFalse(transition({'issues':['x'],'streak':3,'last_notified_at':30,'last_notified_issues':['x']},['x'],60)['notification_due'])
 def test_recovery_notified_once_after_real_incident(self):self.assertTrue(transition({'issues':['x'],'notified_active':True},[],1)['notification_due'])
 def test_never_restart_active_or_unverified_worker(self):
  stale={'consumer':{'fresh':False}};idle={'owner_verified':True,'active_agents':0,'gateway_state':'running'}
  self.assertTrue(can_restart_worker(stale,idle));self.assertFalse(can_restart_worker(stale,dict(idle,active_agents=1)));self.assertFalse(can_restart_worker(stale,dict(idle,owner_verified=False)));self.assertFalse(can_restart_worker({},idle))
 def test_fluctuating_issues_cannot_starve_alert(self):
  s=transition({},['collector'],0);s=transition(s,['collector','backlog'],30);self.assertTrue(s['notification_due']);self.assertEqual(s['first_seen_at'],0)
 def test_intermittent_probe_failure_does_not_spam_or_request_login(self):
  active,conditions=stabilize({},['collector_probe_unavailable']);self.assertEqual(active,[])
  active,conditions=stabilize({'condition_state':conditions},[]);self.assertEqual(active,[])
  self.assertNotIn('kakao_login_or_browser_unavailable',evaluate({'authenticated':None},{}))

class FloodTests(unittest.TestCase):
 def test_different_error_sets_cannot_emit_a_burst(self):
  previous={'issues':['x'],'streak':3,'last_notified_at':100,'last_notified_issues':['x']}
  self.assertFalse(transition(previous,['x','y'],130)['notification_due'])
  self.assertTrue(transition(previous,['x','y'],1000)['notification_due'])



class MaintenanceTests(unittest.TestCase):
 def test_intentional_owned_drain_is_not_reported_as_worker_crash(self):
  report={'authenticated':True,'watcher_ready':True,'bridge_responding':True,'maintenance':True,'coverage':{'complete':True}}
  self.assertNotIn('reservation_worker_disconnected',evaluate(report,{'gateway':{'consumer':{'fresh':False}}}))
  report['maintenance']=False
  self.assertIn('reservation_worker_disconnected',evaluate(report,{'gateway':{'consumer':{'fresh':False}}}))

if __name__=='__main__':unittest.main()
