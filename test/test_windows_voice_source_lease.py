"""Synthetic source identities; no native phase, process, queue or HTTP changes."""
import copy
import hashlib
import json
import importlib.util
from pathlib import Path
import tempfile
import sys
import io
import time
from types import SimpleNamespace
from unittest.mock import patch
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))


class SourceLeaseTests(unittest.TestCase):
    def setUp(self):
        p=Path(__file__).resolve().parents[1]/'scripts/windows/migration_voice_source_lease.py'
        self.assertTrue(p.is_file(),'restart-aware bounded source lease is missing')
        spec=importlib.util.spec_from_file_location('voice_source_lease',p)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.contracts={r:{'role':r,'exe':'C:/fixture/python.exe' if r=='root' else 'C:/fixture/pythonw.exe',
            'argv':['fixture',r],'cwd':'C:/fixture/'+r,'home':'C:/fixture/'+r,'pythonpath':None}
            for r in ('root','voice')}
        self.rows=[dict(self.contracts[r],pid=i+10,started=i+100.1,ancestors=[]) for i,r in enumerate(('root','voice'))]
        self.status={'pid':10,'start_time':10010,'gateway_state':'running',
                     'platforms':{'slack':{'state':'connected'},'webhook':{'state':'connected'}}}
        self.observation={'observed_unix':200,'processes':self.rows,'root_state':self.status,
                          'listeners':{'8644':[10],'8788':[11]},'backend_health':True}

    def select(self):return self.m.select_current_sources(self.contracts,self.observation,now=201)

    def test_unique_restarted_owner_requires_full_contract_status_and_listener(self):
        self.assertEqual(self.select()['root'],{'pid':10,'started':100.1})
        self.rows[0].update(pid=20,started=180.1)
        self.status.update(pid=20,start_time=18010)
        self.observation['listeners']['8644']=[20]
        self.assertEqual(self.select()['root'],{'pid':20,'started':180.1})

    def test_missing_duplicate_or_wrong_contract_does_not_renew(self):
        original=copy.deepcopy(self.observation)
        for mode in ('missing','duplicate','cwd','home','argv'):
            self.observation=copy.deepcopy(original);rows=self.observation['processes']
            if mode=='missing':rows.pop(0)
            elif mode=='duplicate':rows.append(dict(rows[0],pid=99,started=170))
            else:rows[0][mode]=['changed'] if mode=='argv' else 'C:/changed'
            with self.subTest(mode=mode),self.assertRaises(self.m.LeaseHeld):self.select()

    def test_stale_gateway_state_disconnected_platform_or_listener_blocks(self):
        original=copy.deepcopy(self.observation)
        for mode in ('pid','birth','slack','webhook','listener','health','stale','nan'):
            self.observation=copy.deepcopy(original)
            if mode=='pid':self.observation['root_state']['pid']=99
            elif mode=='birth':self.observation['root_state']['start_time']=10011
            elif mode in ('slack','webhook'):self.observation['root_state']['platforms'][mode]['state']='disconnected'
            elif mode=='listener':self.observation['listeners']['8644']=[99]
            elif mode=='health':self.observation['backend_health']=False
            else:self.observation['observed_unix']=float('nan') if mode=='nan' else 180
            with self.subTest(mode=mode),self.assertRaises(self.m.LeaseHeld):self.select()

    def test_only_exact_bound_historical_stop_marker_can_be_ignored(self):
        self.m.validate_stop_markers({},None)
        allowed={'path':'C:/fixture/SOURCE_STOP_REQUESTED','sha256':'a'*64}
        self.m.validate_stop_markers({allowed['path']:'a'*64},allowed)
        for observed in ({allowed['path']:'b'*64},{allowed['path']:'a'*64,'C:/other':'c'*64},{}):
            with self.assertRaises(self.m.LeaseHeld):self.m.validate_stop_markers(observed,allowed)
        with self.assertRaises(self.m.LeaseHeld):self.m.validate_stop_markers({allowed['path']:'a'*64},None)

    def test_origin_namespace_is_retained_with_explicit_fresh_effective_owners(self):
        owners=self.select();origin={'root':{'pid':1,'started':1.1},'voice':{'pid':2,'started':1.2}}
        config={'epoch':'SYNTHETIC','origin_source':origin}
        phase=self.m.phase_payload(config,'windows',owners,'a'*64)
        self.assertEqual(phase['source'],origin);self.assertEqual(phase['effective_owners'],owners)
        self.assertNotIn('verified_unix',phase)  # Only native time may start the lease.
        held=self.m.phase_payload(config,'hold',{},'a'*64)
        self.assertEqual(held['mode'],'hold');self.assertNotIn('effective_owners',held)

    def test_multiple_recovered_attempts_never_ignore_a_new_or_changed_stop(self):
        old={'path':'C:/fixture/old/SOURCE_STOP_REQUESTED','sha256':'a'*64}
        current={'path':'C:/fixture/current/SOURCE_STOP_REQUESTED','sha256':'b'*64}
        prior=[{'marker':old,'authorization':{'recovered':{'path':'bound-proof','sha256':'c'*64}}}]
        observed={old['path']:old['sha256'],current['path']:current['sha256']}
        self.m.validate_stop_markers(observed,current,prior=prior)
        for changed in ({current['path']:current['sha256']},dict(observed,unapproved='d'*64),
                        {old['path']:'e'*64,current['path']:current['sha256']}):
            with self.subTest(changed=changed),self.assertRaises(self.m.LeaseHeld):
                self.m.validate_stop_markers(changed,current,prior=prior)
        with self.assertRaises(self.m.LeaseHeld):
            self.m.validate_stop_markers(observed,current,prior=prior+prior)

    def test_only_completed_recovery_can_be_carried_into_the_next_attempt(self):
        config={'historical_stop_marker':{'path':'old','sha256':'a'*64},
                'recovery_authorization':{'inputs':{'path':'inputs','sha256':'b'*64}}}
        with self.assertRaises(self.m.LeaseHeld):self.m.carry_prior_recoveries(config)
        config['recovery_authorization']['recovered']={'path':'ready','sha256':'c'*64}
        carried=self.m.carry_prior_recoveries(config)
        self.assertEqual(carried,[{'marker':config['historical_stop_marker'],
                                  'authorization':config['recovery_authorization']}])
        carried[0]['marker']['sha256']='changed'
        self.assertEqual(config['historical_stop_marker']['sha256'],'a'*64)

    def test_local_writer_lock_has_one_owner_and_can_be_released(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'lease.lock'
            with self.m.WriterLock(path):
                with self.assertRaises(self.m.LeaseHeld):self.m.WriterLock(path)
            with self.m.WriterLock(path):pass

    def test_config_cannot_ignore_a_stop_without_bound_recovery_authorization(self):
        self.assertTrue(hasattr(self.m,'validate_private_configuration'),'bound controller inputs are missing')
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            def ref(name,data):
                p=base/name;raw=json.dumps(data).encode();p.write_bytes(raw)
                return {'path':str(p),'sha256':hashlib.sha256(raw).hexdigest()}
            source={'root':{'pid':1,'started':1.1},'voice':{'pid':2,'started':1.2}}
            template=[dict(x,pythonpath=x.get('pythonpath')) for x in self.contracts.values()]
            template.append({'role':'worker','home':'C:/fixture/worker'})
            cfg={'schema':'village-voice-source-controller/v1','epoch':'SYNTHETIC','origin_source':source,
                'contracts':self.contracts,'intake_config_sha256':'c'*64,
                'intake_preparation':ref('prep.json',{'schema':'village-voice-intake-preparation/v1','epoch':'SYNTHETIC','source':source,'config_sha256':'c'*64}),
                'source_template':ref('template.json',{'profiles':template}),
                'origin_lease_owner':ref('old.json',{'pid':90,'started':90.1}),
                'prior_writers':[{'pid':90,'started':90.1}],
                'drain_paths':['C:/fixture/root/.drain_request.json','C:/fixture/worker/.drain_request.json']}
            self.m.validate_private_configuration(cfg,base)
            cfg['historical_stop_marker']={'path':str(base/'SOURCE_STOP_REQUESTED'),'sha256':'a'*64}
            with self.assertRaises(self.m.LeaseHeld):self.m.validate_private_configuration(cfg,base)
            marker=base/'SOURCE_STOP_REQUESTED';marker.write_bytes(b'SYNTHETIC STOP')
            cfg['historical_stop_marker']['sha256']=hashlib.sha256(marker.read_bytes()).hexdigest()
            stop=ref('stop.json',{'schema':1,'intent_sha256':'f'*64})
            inputs=ref('recovery-inputs.json',{'schema':'village-current-recovery-inputs/v1',
                'stop_sha256':stop['sha256'],'intent':{'sha256':'f'*64}})
            backends=ref('backends.json',{'schema':'village-source-backends-recovered/v1',
                'inputs_sha256':inputs['sha256'],'stop_sha256':stop['sha256'],
                'destination_ever_activated':False,'profiles':[{'role':r,'pid':i+10,'start_time':10000+i,'state':'running'}
                    for i,r in enumerate(('root','worker','voice','bridge','relay'))]})
            cfg['recovery_authorization']={'inputs':inputs,'stop':stop,'backends':backends}
            self.m.validate_private_configuration(cfg,base)
            prior={'marker':cfg.pop('historical_stop_marker'),'authorization':cfg.pop('recovery_authorization')}
            cfg['prior_recovered_stops']=[prior]
            with self.assertRaises(self.m.LeaseHeld):self.m.validate_private_configuration(cfg,base)
            proof={'schema':'village-source-recovery/v1','stopReceiptSha256':stop['sha256'],
                'voiceDispatchRestored':True,'destinationEverActivated':False,
                'profiles':[{'role':r,'pid':i+10,'start_time':10000+i,'state':'running'}
                    for i,r in enumerate(('root','worker','voice','bridge','relay'))]}
            prior['authorization']['recovered']=ref('SOURCE-RECOVERED.json',proof)
            self.m.validate_private_configuration(cfg,base)
            changed_proof=dict(proof,destinationEverActivated=True)
            prior['authorization']['recovered']=ref('SOURCE-RECOVERED.json',changed_proof)
            with self.assertRaises(self.m.LeaseHeld):self.m.validate_private_configuration(cfg,base)
            prior['authorization']['recovered']=ref('SOURCE-RECOVERED.json',proof)
            changed=copy.deepcopy(template);changed[0]['cwd']='C:/other'
            cfg['source_template']=ref('template.json',{'profiles':changed})
            with self.assertRaises(self.m.LeaseHeld):self.m.validate_private_configuration(cfg,base)

    def test_source_template_or_origin_proof_cannot_be_substituted(self):
        self.assertTrue(hasattr(self.m,'validate_private_configuration'),'bound controller inputs are missing')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises((self.m.LeaseHeld,KeyError)):
                self.m.validate_private_configuration({'schema':'village-voice-source-controller/v1'},Path(directory))

    def test_listener_proof_includes_other_processes_outside_source_candidates(self):
        def connection(pid,port):return SimpleNamespace(pid=pid,status='LISTEN',laddr=SimpleNamespace(ip='127.0.0.1',port=port))
        processes={}
        for row in self.rows:
            r=dict(row);p=SimpleNamespace(pid=r['pid'],info={'name':Path(r['exe']).name})
            p.exe=lambda r=r:r['exe'];p.create_time=lambda r=r:r['started']
            p.cmdline=lambda r=r:r['argv'];p.cwd=lambda r=r:r['cwd']
            p.environ=lambda r=r:{'HERMES_HOME':r['home']};p.parents=lambda:[]
            p.net_connections=lambda kind,r=r:[connection(r['pid'],8644 if r['role']=='root' else 8788)]
            processes[p.pid]=p
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)/'state.json';state.write_text(json.dumps(self.status))
            with patch('psutil.process_iter',return_value=list(processes.values())), \
                 patch('psutil.Process',side_effect=lambda pid:processes[pid]), \
                 patch('psutil.net_connections',return_value=[connection(10,8644),connection(99,8644),connection(11,8788)]), \
                 patch.object(self.m,'urlopen',side_effect=lambda *a,**k:io.BytesIO(b'{"status":"ok"}')):
                observed=self.m.observe(self.contracts,state)
            with self.assertRaises(self.m.LeaseHeld):self.m.select_current_sources(self.contracts,observed,now=time.time())


if __name__=='__main__':unittest.main()
