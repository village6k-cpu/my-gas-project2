import sys,unittest,json,tempfile,time
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent));from recovery_policy import evaluate,transition,can_restart_worker,stabilize
class PolicyTests(unittest.TestCase):
 def test_heartbeat_alone_is_not_healthy(self):self.assertIn('collector_not_reading_full_list',evaluate({'authenticated':True,'watcher_ready':False,'bridge_responding':True},{'gateway':{'consumer':{'fresh':True}}}))
 def test_incident_survives_restart_and_only_ack_clears_notification(self):
  s=transition({},['collector'],0);s=transition(s,['collector'],30);self.assertTrue(s['notification_due']);self.assertTrue(transition(s,['collector'],60)['notification_due'])
 def test_healthy_initial_state_does_not_spam(self):self.assertFalse(transition({},[],1)['notification_due'])
 def test_repeat_notice_is_bounded(self):self.assertFalse(transition({'issues':['x'],'streak':3,'last_notified_at':30,'last_notified_issues':['x']},['x'],60)['notification_due'])
 def test_recovery_clears_existing_notice_without_sending_success(self):
  state=transition({'issues':['x'],'notified_active':True},[],1)
  self.assertFalse(state['notification_due']);self.assertTrue(state['clear_notification'])
 def test_backfill_progress_is_not_owner_work(self):
  s=transition({},['unreconciled_intake_backlog','reconciliation_scan_incomplete'],0)
  s=transition(s,s['issues'],1000)
  self.assertFalse(s['notification_due']);self.assertEqual(s['notification_issues'],[])
 def test_progress_fluctuation_does_not_renotify_manual_work(self):
  s={'issues':['reservation_write_needs_readback'],'streak':4,'last_notified_issues':['reservation_write_needs_readback'],'last_notified_at':0}
  state=transition(s,['reservation_write_needs_readback','reconciliation_scan_incomplete'],1000)
  self.assertFalse(state['notification_due']);self.assertEqual(state['notification_issues'],['reservation_write_needs_readback'])
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

class DeliveryTests(unittest.TestCase):
 def exercise(self,previous,health):
  from recovery_policy import maintain_health
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);(root/'control').mkdir();(root/'state').mkdir()
   (root/'control/bridge.env.json').write_text(json.dumps({'SLACK_BOT_TOKEN':'fixture'}))
   (root/'control/reservation-recovery-notifications.json').write_text(json.dumps({'channel':'C1'}))
   (root/'state/reservation-recovery.json').write_text(json.dumps(previous))
   calls=[]
   class Response:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return json.dumps({'ok':True,'ts':'1.2'}).encode()
   def request(req,**kwargs):calls.append(req.full_url);return Response()
   with patch('recovery_policy.urlopen',side_effect=request),patch('supervisor.gateway_owned',return_value=False):
    maintain_health(root,{'authenticated':True,'watcher_ready':True,'bridge_responding':True,'coverage':{'complete':True}},health)
   return calls,json.loads((root/'state/reservation-recovery.json').read_text())
 def test_active_incident_updates_one_existing_message(self):
  key='reservation_write_needs_readback'
  previous={'issues':[key],'streak':3,'condition_state':{key:{'active':True,'bad':3}},'last_notified_issues':[],'last_notified_at':0,'slack_ts':'1.2','published_issues':[key],'dashboard_published_at':time.time()}
  calls,state=self.exercise(previous,{'gateway':{'consumer':{'fresh':True},'registered_reservation_change':{'oldest_reserved_age_ms':700000}}})
  self.assertEqual(calls,['https://slack.com/api/chat.update']);self.assertTrue(state['notified_active'])
 def test_resolved_incident_is_removed_without_a_success_post(self):
  key='bridge_unresponsive'
  previous={'issues':[key],'condition_state':{key:{'active':True,'good':2}},'notified_active':True,'slack_ts':'1.2'}
  calls,state=self.exercise(previous,{'gateway':{'consumer':{'fresh':True}}})
  self.assertEqual(calls,['https://slack.com/api/chat.delete']);self.assertFalse(state['notified_active'])

if __name__=='__main__':unittest.main()
