import copy
import importlib.util
from pathlib import Path
import sys
import unittest

S=Path(__file__).resolve().parents[1]/'scripts/windows'
sys.path.insert(0,str(S))
import migration_freeze_closed_plans as m


class FreezeTests(unittest.TestCase):
    def setUp(self):
        self.intent={'profiles':[dict(role=r,pid=10+i,started=100+i) for i,r in enumerate(m.ROLES)]}
        owners={r['role']:dict(pid=r['pid'],started=r['started']) for r in self.intent['profiles']}
        for r in ('root','worker'):owners[r].update(gateway_state='draining',active_agents=0,pending_messages=0,running_cron=0)
        owners['bridge'].update(drained=True,http_closed=True,preexisting_work_verified=True,pending_handlers=0,pending_tracked_work=0)
        owners['relay']['owned_producer_paused']=True
        owners['voice'].update(threads=1,non_listening_tcp_connections=0,ingress_mode='hold',ingress_dispatching=0,ingress_epoch='epoch',receipt_status_counts={'webhook_accepted':2})
        self.accepted={'schema':'village-current-accepted-work-closure/v1','intent_sha256':'a'*64,'owners':owners,'slack_quiet':{'settled_seconds':301,'new_input_observed':False},'preserved_obligations':{'replay_authorized':False,'manifest_sha256':'e'*64}}
        self.inventory={r:[] for r in m.ROLES}
        self.request={'schema':'village-source-stop-request/v1','intent_sha256':'a'*64,'child_inventory_sha256':'b'*64,'accepted_work_sha256':'c'*64,'requested_at':200}
        self.stop={'schema':1,'source_closed':True,'intent_sha256':'a'*64,'child_inventory_sha256':'b'*64,'accepted_work_sha256':'c'*64,'stopped_at':201,'profiles':[dict(r,status='stopped',children_inventory_complete=True,children=[]) for r in self.intent['profiles']]}
        self.capture={'schema':'village-current-closed-capture-plan/v1','preparation_only':True,'accepted_work':{'required_actual_receipt':'pending'},'roots':[{'name':'keep'}]}
        self.recovery={'schema':'village-current-recovery-inputs/v1','preparation_only':True,'intent':{'path':'intent.json','sha256':'a'*64},'stop_sha256':'pending','tasks_sha256':'pending','watcher_pause':{'required_actual_receipt':'pending'},'owned_drains':{'required_actual_receipt':'pending'}}
        self.kw=dict(intent=self.intent,intent_sha='a'*64,stop=self.stop,stop_sha='d'*64,request=self.request,inventory=self.inventory,inventory_sha='b'*64,accepted=self.accepted,accepted_ref={'path':'accepted.json','sha256':'c'*64},tasks_sha='f'*64,watcher_pause={'path':'watcher.json','sha256':'1'*64},owned_drains={'path':'drains.json','sha256':'2'*64},now=202)

    def freeze(self):return m.freeze_documents(self.capture,self.recovery,**self.kw)

    def test_real_receipts_replace_only_pending_bindings(self):
        before=copy.deepcopy((self.capture,self.recovery))
        c,r=self.freeze()
        self.assertNotIn('preparation_only',c);self.assertNotIn('preparation_only',r)
        self.assertEqual(c['accepted_work'],self.kw['accepted_ref'])
        self.assertEqual(r['stop_sha256'],'d'*64);self.assertEqual(r['tasks_sha256'],'f'*64)
        self.assertEqual(c['roots'],self.capture['roots']);self.assertEqual((self.capture,self.recovery),before)

    def test_partial_or_unaffected_source_cannot_create_cold_plan(self):
        for mode in ('partial','unaffected'):
            self.stop['profiles'][0]['status']=mode
            with self.assertRaises(ValueError):self.freeze()
        self.stop['profiles'][0]['status']='stopped';self.stop['source_closed']=False
        with self.assertRaises(ValueError):self.freeze()

    def test_changed_children_or_stop_marker_block(self):
        self.inventory[m.ROLES[0]]=[{'pid':999,'started':150}]
        with self.assertRaises(ValueError):self.freeze()
        self.inventory[m.ROLES[0]]=[];self.request['accepted_work_sha256']='0'*64
        with self.assertRaises(ValueError):self.freeze()

    def test_unsettled_accepted_work_and_wrong_owner_block(self):
        self.accepted['owners']['root']['active_agents']=1
        with self.assertRaises(ValueError):self.freeze()
        self.accepted['owners']['root']['active_agents']=0
        self.stop['profiles'][0]['started']+=1
        with self.assertRaises(ValueError):self.freeze()

    def test_placeholders_in_live_bindings_or_future_stop_block(self):
        self.kw['tasks_sha']='pending'
        with self.assertRaises(ValueError):self.freeze()
        self.kw['tasks_sha']='f'*64;self.kw['now']=199
        with self.assertRaises(ValueError):self.freeze()


if __name__=='__main__':unittest.main()
