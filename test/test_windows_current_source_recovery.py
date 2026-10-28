import copy
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts/windows"))
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from migration_source_recovery import build_plan, collect_source, FUTURE_LABELS, CANDIDATE, REMOTE_HOST, confirmed_label_absence, same_contract


class WindowsBootstrapPathTests(unittest.TestCase):
    def contract(self,path):
        return dict(exe='C:/python.exe',cwd='C:/agent',home='C:/home',
                    argv=['C:/python.exe','-m','hermes_cli.main','gateway','run'],pythonpath=path)

    def test_only_complete_identical_search_sequence_repetitions_are_equivalent(self):
        paths='C:/agent;C:/agent/venv/Lib/site-packages'
        self.assertTrue(same_contract(self.contract(paths+';'+paths),self.contract(paths)))
        self.assertTrue(same_contract(self.contract(';'.join([paths]*3)),self.contract(';'.join([paths]*2))))

    def test_new_reordered_missing_or_empty_search_roots_are_rejected(self):
        paths='C:/agent;C:/agent/venv/Lib/site-packages'
        for other in (paths+';C:/other','C:/agent/venv/Lib/site-packages;C:/agent',
                      'C:/agent',paths+';',paths+';;'+paths,paths+';C:/agent'):
            with self.subTest(other=other):self.assertFalse(same_contract(self.contract(other),self.contract(paths)))

    def test_path_repetition_does_not_allow_other_execution_contract_drift(self):
        expected=self.contract('C:/agent;C:/site');actual=self.contract('C:/agent;C:/site;C:/agent;C:/site')
        for field,value in (('home','C:/wrong'),('cwd','C:/wrong'),('exe','C:/wrong.exe'),('argv',['C:/wrong.exe'])):
            with self.subTest(field=field):self.assertFalse(same_contract(dict(actual,**{field:value}),expected))

    def test_no_path_and_literal_empty_path_remain_distinct(self):
        self.assertTrue(same_contract(self.contract(None),self.contract(None)))
        self.assertFalse(same_contract(self.contract(''),self.contract(None)))


class SourceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.intent = {'profiles': []}
        self.receipt = {'schema': 1, 'intent_sha256': 'a' * 64, 'stopped_at': 990,
                        'profiles': []}
        for n, role in enumerate(('root', 'worker', 'bridge', 'relay', 'voice'), 1):
            args=['-m','hermes_cli.main','gateway','run'] if role in ('root','worker') else [f'C:/runtime/{role}.py' if role=='voice' else f'C:/runtime/{role}.mjs']
            self.intent['profiles'].append(dict(role=role, pid=n, started=100+n,
                exe=f'C:/runtime/{role}.exe', argv=[f'C:/runtime/{role}.exe', *args],
                cwd=f'C:/runtime/{role}', home=f'C:/home/{role}', pythonpath=None,
                ports=[] if role == 'worker' else [8000+n]))
            self.receipt['profiles'].append(dict(role=role, pid=n, started=100+n,
                status='stopped', children_inventory_complete=True, children=[]))
        self.remote = dict(observed_at=999, host=REMOTE_HOST, candidate=CANDIDATE,
            domain_verified=True,uid=501,
            inactive=True, activation_absent=True, labels={x: 'unloaded' for x in FUTURE_LABELS},
            errors=[])
        self.snapshot = dict(observed_at=999, processes=[], listeners=[], errors=[])

    def plan(self, **kw):
        return build_plan(self.intent, self.receipt, 'a'*64, self.snapshot,
                          self.remote, now=self.now, activated=kw.get('activated', False))

    def test_detached_bun_store_interpreter_blocks_closed_writer_claim(self):
        self.snapshot['processes'].append(dict(pid=90,started=995,exe='C:/tools/bun.exe',
            argv=['C:/tools/bun.exe','C:/code/gbrain/src/cli.ts','serve'],cwd='C:/code/gbrain',
            home=None,pythonpath=None,ancestors=[]))
        result=self.plan()
        self.assertFalse(result['ready'])
        self.assertIn('detached_store_interpreter_requires_ownership_resolution',result['errors'])

    def test_bun_store_child_of_exact_replacement_is_preserved(self):
        root=self.candidate('root',50)
        self.snapshot['processes'].append(root)
        self.snapshot['listeners'].append(dict(port=root['ports'][0],pid=root['pid']))
        self.snapshot['processes'].append(dict(pid=90,started=996,exe='C:/tools/bun.exe',
            argv=['C:/tools/bun.exe','C:/code/gbrain/src/cli.ts','serve'],cwd='C:/code/gbrain',
            home=root['home'],pythonpath=None,ancestors=[dict(pid=50,started=995)]))
        result=self.plan()
        self.assertTrue(result['ready'],result['errors'])

    def test_source_collection_does_not_skip_bun_processes(self):
        proc=SimpleNamespace(pid=90,name=lambda:'bun.exe',create_time=lambda:995,
             exe=lambda:'C:/tools/bun.exe',cmdline=lambda:['C:/tools/bun.exe','C:/code/cli.ts'],
             cwd=lambda:'C:/code',environ=lambda:{},parents=lambda:[])
        with patch('psutil.process_iter',return_value=[proc]),patch('psutil.net_connections',return_value=[]):
            result=collect_source(self.intent,self.receipt)
        self.assertEqual([p['pid'] for p in result['processes']],[90])

    def test_detached_gbrain_launcher_is_a_store_owner_candidate(self):
        self.snapshot['processes'].append(dict(pid=90,started=995,exe='C:/tools/gbrain.exe',
            argv=['C:/tools/gbrain.exe','serve'],cwd='C:/code/gbrain',
            home=None,pythonpath=None,ancestors=[]))
        result=self.plan()
        self.assertFalse(result['ready'])
        self.assertIn('detached_store_interpreter_requires_ownership_resolution',result['errors'])

    def test_source_collection_does_not_skip_gbrain_launchers(self):
        proc=SimpleNamespace(pid=90,name=lambda:'gbrain.exe',create_time=lambda:995,
             exe=lambda:'C:/tools/gbrain.exe',cmdline=lambda:['C:/tools/gbrain.exe','serve'],
             cwd=lambda:'C:/code',environ=lambda:{},parents=lambda:[])
        with patch('psutil.process_iter',return_value=[proc]),patch('psutil.net_connections',return_value=[]):
            result=collect_source(self.intent,self.receipt)
        self.assertEqual([p['pid'] for p in result['processes']],[90])

    def candidate(self, role='root', pid=50):
        row = copy.deepcopy(next(x for x in self.intent['profiles'] if x['role'] == role))
        row.update(pid=pid, started=995)
        return row

    def test_closed_source_returns_only_bounded_restart_methods(self):
        result = self.plan()
        self.assertTrue(result['ready'], result['errors'])
        self.assertFalse(result['execution_authorized'])
        methods = {x['role']: x for x in result['steps']}
        self.assertEqual(methods['root']['task'], 'Hermes_Gateway')
        self.assertEqual(methods['worker']['task'], 'Hermes_Gateway_Kakaoworker_Native')
        self.assertEqual(methods['voice']['task'], 'Hermes_Watch_Voice_Relay')
        self.assertEqual(methods['bridge']['method'], 'current_guarded_bridge_relay_recovery_required')
        self.assertNotIn('task', methods['bridge'])
        self.assertEqual(methods['relay']['method'], 'current_guarded_bridge_relay_recovery_required')
        self.assertNotIn('task', methods['relay'])

    def test_local_activation_history_forbids_even_when_mac_currently_inactive(self):
        self.assertFalse(self.plan(activated=True)['ready'])

    def test_missing_stale_or_partial_remote_proof_fails_closed(self):
        for remote in (None, {}, dict(self.remote, observed_at=950),
                       dict(self.remote, labels={}), dict(self.remote, inactive=False),
                       dict(self.remote, activation_absent=False)):
            with self.subTest(remote=remote):
                original = self.remote
                self.remote = remote
                self.assertFalse(self.plan()['ready'])
                self.remote = original

    def test_one_loaded_or_unknown_future_job_forbids(self):
        for value in ('loaded', 'unknown'):
            self.remote['labels'][FUTURE_LABELS[0]] = value
            self.assertFalse(self.plan()['ready'])

    def test_old_mcp_alive_forbids_even_with_all_parent_pids_gone(self):
        self.receipt['profiles'][0]['children'] = [dict(pid=80, started=200)]
        self.snapshot['processes'] = [dict(pid=80, started=200)]
        self.assertFalse(self.plan()['ready'])

    def test_old_parent_alive_is_never_reused_as_replacement(self):
        self.snapshot['processes'] = [self.intent['profiles'][0]]
        self.assertFalse(self.plan()['ready'])

    def test_duplicate_exact_candidates_forbid(self):
        self.snapshot['processes'] = [self.candidate(pid=50), self.candidate(pid=51)]
        self.assertFalse(self.plan()['ready'])

    def test_wrong_environment_listener_forbids(self):
        wrong = self.candidate()
        wrong['home'] = 'C:/other-home'
        self.snapshot['processes'] = [wrong]
        self.snapshot['listeners'] = [dict(port=8001, pid=50)]
        self.assertFalse(self.plan()['ready'])

    def test_wrong_cwd_without_port_also_forbids_near_duplicate(self):
        wrong = self.candidate('worker')
        wrong['cwd'] = 'C:/other-runtime'
        self.snapshot['processes'] = [wrong]
        self.assertFalse(self.plan()['ready'])

    def test_owned_replacement_reused_only_when_all_listeners_match(self):
        self.snapshot['processes'] = [self.candidate()]
        self.assertFalse(self.plan()['ready'])
        self.snapshot['listeners'] = [dict(port=8001, pid=50)]
        result = self.plan()
        self.assertTrue(result['ready'], result['errors'])
        self.assertEqual(next(x for x in result['steps'] if x['role']=='root')['method'],
                         'reuse_verified_replacement')

    def test_unaffected_identity_must_remain_exact(self):
        self.receipt['profiles'][1]['status'] = 'unaffected'
        self.snapshot['processes'] = [self.intent['profiles'][1]]
        self.assertTrue(self.plan()['ready'])
        self.snapshot['processes'] = [self.candidate('worker')]
        self.assertFalse(self.plan()['ready'])

    def test_unbound_receipt_missing_child_inventory_or_unobserved_processes_forbid(self):
        for change in ('hash', 'children', 'snapshot'):
            with self.subTest(change=change):
                self.setUp()
                if change == 'hash': self.receipt['intent_sha256'] = 'b'*64
                elif change == 'children': del self.receipt['profiles'][0]['children_inventory_complete']
                else: self.snapshot['errors'] = ['process inspection denied']
                result = self.plan()
                self.assertFalse(result['ready'])
                self.assertEqual(result['steps'], [])

    def test_source_collection_excludes_kernel_identity_but_fails_unreadable_runtime(self):
        import psutil
        kernel = SimpleNamespace(pid=0, name=lambda: 'System Idle Process', create_time=lambda: 0)
        with patch('psutil.process_iter', return_value=[kernel]), patch('psutil.net_connections', return_value=[]):
            result = collect_source(self.intent, self.receipt)
        self.assertEqual(result['processes'], [])
        self.assertEqual(result['errors'], [])
        def denied():
            raise psutil.AccessDenied(50)
        candidate = SimpleNamespace(pid=50, name=lambda: 'root.exe', create_time=lambda: 995,
                                    environ=denied)
        with patch('psutil.process_iter', return_value=[candidate]), patch('psutil.net_connections', return_value=[]):
            result = collect_source(self.intent, self.receipt)
        self.assertTrue(result['errors'])


    def test_legacy_four_role_receipt_is_rejected(self):
        self.receipt['profiles']=[x for x in self.receipt['profiles'] if x['role']!='relay']
        self.assertFalse(self.plan()['ready'])
        self.assertEqual(self.plan()['steps'],[])

    def test_guarded_relay_and_its_descendants_must_be_closed(self):
        relay=next(x for x in self.intent['profiles'] if x['role']=='relay')
        self.snapshot['processes']=[relay]
        self.assertFalse(self.plan()['ready'])
        self.snapshot['processes']=[dict(pid=85,started=500)]
        receipt=next(x for x in self.receipt['profiles'] if x['role']=='relay')
        receipt['children']=[dict(pid=85,started=500)]
        self.assertFalse(self.plan()['ready'])

    def test_missing_guarded_relay_launchd_proof_is_rejected(self):
        self.remote['labels'].pop('com.village.migrated.relay',None)
        self.assertFalse(self.plan()['ready'])

    def test_partial_guarded_replacement_is_observed_without_start_authority(self):
        bridge=self.candidate('bridge')
        self.snapshot['processes']=[bridge]
        self.snapshot['listeners']=[dict(port=8003,pid=50)]
        result=self.plan()
        self.assertTrue(result['ready'],result['errors'])
        self.assertFalse(result['execution_authorized'])
        self.assertEqual(next(x for x in result['steps'] if x['role']=='bridge')['method'],'reuse_verified_replacement')
        self.assertEqual(next(x for x in result['steps'] if x['role']=='relay')['method'],'current_guarded_bridge_relay_recovery_required')

    def test_proven_new_owner_helper_is_not_a_second_gateway(self):
        for role in ('root','bridge'):
            with self.subTest(role=role):
                self.setUp()
                owner=self.candidate(role)
                helper=self.candidate(role,pid=51)
                helper['started']=996
                helper['argv']=[helper['exe'],'C:/runtime/read_only_helper.py']
                helper['ancestors']=[{'pid':50,'started':995}]
                self.snapshot['processes']=[owner,helper]
                self.snapshot['listeners']=[dict(port=owner['ports'][0],pid=50)]
                self.assertTrue(self.plan()['ready'],self.plan()['errors'])

    def test_cross_profile_distinct_tool_child_requires_live_verified_owner(self):
        root=self.candidate('root',50);bridge=self.candidate('bridge',60)
        bridge['home']=root['home']
        old_bridge=next(r for r in self.intent['profiles'] if r['role']=='bridge');old_bridge['home']=root['home']
        helper=dict(bridge,pid=70,started=996,argv=[bridge['exe'],'C:/tools/review-stock.mjs'],
                    ancestors=[{'pid':root['pid'],'started':root['started']}])
        self.snapshot['processes']=[root,bridge,helper]
        self.snapshot['listeners']=[{'port':o['ports'][0],'pid':o['pid']} for o in (root,bridge)]
        result=self.plan();self.assertTrue(result['ready'],result['errors'])
        self.snapshot['processes']=[bridge,helper]
        self.snapshot['listeners']=[{'port':bridge['ports'][0],'pid':bridge['pid']}]
        self.assertFalse(self.plan()['ready'])

    def test_unowned_helper_under_same_profile_is_not_safe_absence(self):
        helper=self.candidate('root')
        helper['argv']=[helper['exe'],'C:/runtime/unknown.py']
        self.snapshot['processes']=[helper]
        self.assertFalse(self.plan()['ready'])

    def test_cross_profile_service_script_is_not_helper_when_exact_service_is_absent(self):
        root=self.candidate('root',50)
        bridge=next(r for r in self.intent['profiles'] if r['role']=='bridge');bridge['home']=root['home']
        helper=dict(bridge,pid=70,started=996,argv=bridge['argv']+['--changed-mode'],
                    ancestors=[{'pid':root['pid'],'started':root['started']}])
        self.snapshot['processes']=[root,helper]
        self.snapshot['listeners']=[{'port':root['ports'][0],'pid':root['pid']}]
        result=self.plan();self.assertFalse(result['ready'])
        self.assertIn('bridge:near_candidate_has_wrong_execution_contract',result['errors'])

    def test_changed_gateway_entrypoint_arguments_are_rejected_even_in_new_owner_lineage(self):
        owner=self.candidate('root')
        child=self.candidate('root',pid=51);child['started']=996
        child['argv'].append('--changed');child['ancestors']=[dict(pid=50,started=995)]
        self.snapshot['processes']=[owner,child]
        self.snapshot['listeners']=[dict(port=8001,pid=50)]
        self.assertFalse(self.plan()['ready'])

    def test_interpreter_options_cannot_hide_a_second_gateway_in_owner_lineage(self):
        for role,options in [('root',['-u']),('root',['-X','utf8']),
              ('voice',['-B']),('bridge',['--trace-warnings'])]:
            with self.subTest(role=role,options=options):
                self.setUp()
                owner=self.candidate(role)
                child=self.candidate(role,pid=51);child['started']=996
                child['argv'][1:1]=options
                child['ancestors']=[dict(pid=50,started=995)]
                self.snapshot['processes']=[owner,child]
                self.snapshot['listeners']=[dict(port=owner['ports'][0],pid=50)]
                self.assertFalse(self.plan()['ready'])

    def test_ambiguous_inline_or_unknown_interpreter_form_is_not_a_proven_helper(self):
        for args in [('-c','import gateway'),('--unknown-interpreter-option','helper.py')]:
            with self.subTest(args=args):
                self.setUp()
                owner=self.candidate('root');child=self.candidate('root',pid=51)
                child['started']=996;child['argv']=[child['exe'],*args]
                child['ancestors']=[dict(pid=50,started=995)]
                self.snapshot['processes']=[owner,child]
                self.snapshot['listeners']=[dict(port=8001,pid=50)]
                self.assertFalse(self.plan()['ready'])

    def test_module_as_script_does_not_hide_a_second_gateway(self):
        owner=self.candidate('root');child=self.candidate('root',pid=51)
        child['started']=996
        child['argv']=[child['exe'],'C:/runtime/hermes_cli/main.py','gateway','run']
        child['ancestors']=[dict(pid=50,started=995)]
        self.snapshot['processes']=[owner,child]
        self.snapshot['listeners']=[dict(port=8001,pid=50)]
        self.assertFalse(self.plan()['ready'])

    def test_same_entrypoint_with_changed_arguments_and_home_contract_is_not_absent(self):
        wrong=self.candidate('worker')
        wrong['argv'].append('--different')
        self.snapshot['processes']=[wrong]
        self.assertFalse(self.plan()['ready'])

    def test_only_pinned_missing_service_diagnostic_proves_absence(self):
        label='com.village.migrated.relay'
        diagnostic='Bad request.\nCould not find service "'+label+'" in domain for user gui: 501\n'
        self.assertTrue(confirmed_label_absence(True,113,diagnostic,label,501))
        for domain,code,text,uid in [(False,113,diagnostic,501),(True,1,diagnostic,501),
              (True,113,diagnostic,502),(True,113,'Could not find service',501),
              (True,113,diagnostic+'Transport error',501)]:
            self.assertFalse(confirmed_label_absence(domain,code,text,label,uid))

    def test_remote_domain_or_uid_mismatch_is_not_inactivity(self):
        for field,value in [('domain_verified',False),('uid',502)]:
            self.setUp();self.remote[field]=value
            self.assertFalse(self.plan()['ready'])

if __name__ == '__main__':
    unittest.main()
