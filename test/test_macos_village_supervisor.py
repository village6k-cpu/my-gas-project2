import importlib.util
from pathlib import Path, PurePosixPath
import unittest
from unittest.mock import Mock, patch
import psutil
import inspect

MODULE=Path(__file__).resolve().parents[1]/'scripts/macos/village-supervisor.py'
spec=importlib.util.spec_from_file_location('supervisor',MODULE)
supervisor=importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)

class WatcherRecoveryTests(unittest.TestCase):
    def test_authentication_failure_never_reinjects_or_restarts_browser(self):
        self.assertEqual(supervisor.watcher_action({'cdpReady':True,'authenticated':False,'challengeType':'otp'}),'user_auth_required')
    def test_missing_browser_is_left_to_its_own_launchd_owner(self):
        self.assertEqual(supervisor.watcher_action({'cdpReady':False}),'wait_for_chrome')
    def test_authenticated_missing_watcher_can_be_reinjected(self):
        self.assertEqual(supervisor.watcher_action({'cdpReady':True,'authenticated':True,'watcherReady':False}),'inject')
    def test_ready_watcher_does_not_imply_healthy_business_workflow(self):
        self.assertEqual(supervisor.watcher_action({'cdpReady':True,'authenticated':True,'watcherReady':True}),'observe')
    def test_missing_authentication_evidence_is_not_assumed(self):
        self.assertEqual(supervisor.watcher_action({'cdpReady':True}),'user_auth_required')
    def test_chrome_uses_only_isolated_profile_and_loopback(self):
        args=supervisor.chrome_argv(PurePosixPath('/tmp/isolated'),19223,'https://business.kakao.com/space/353491/channel/_xhPMls/chats')
        self.assertIn('--user-data-dir=/tmp/isolated/chrome-kakao',args)
        self.assertIn('--remote-debugging-address=127.0.0.1',args)
        self.assertNotIn('--disable-web-security',args)
    def test_unknown_or_busy_gateway_blocks_reload_capable_recovery(self):
        self.assertEqual(len(inspect.signature(supervisor.recovery_idle).parameters),3,'recovery must inspect both gateways')
        idle={'active_agents':0,'owner_verified':True,'gateway_state':'running'}
        health={'ok':True,'state':{'activeWorkerRuns':0},'gateway':{'queue':{'claimed':0},'application_counts':{}}}
        self.assertFalse(supervisor.recovery_idle({},idle,health))
        self.assertFalse(supervisor.recovery_idle(dict(idle,active_agents=1),idle,health))
        self.assertFalse(supervisor.recovery_idle(idle,dict(idle,owner_verified=False),health))
        self.assertFalse(supervisor.recovery_idle(idle,dict(idle,gateway_state='stopped'),health))
        self.assertTrue(supervisor.recovery_idle(idle,idle,health))
    def test_business_application_and_unknown_status_block_recovery(self):
        idle={'active_agents':0,'owner_verified':True,'gateway_state':'running'}
        for stage in ('pending','claimed','applying','applied'):
            health={'ok':True,'state':{'activeWorkerRuns':0},'gateway':{'queue':{'claimed':0},'application_counts':{stage:1}}}
            with self.subTest(stage=stage):
                self.assertFalse(supervisor.recovery_idle(idle,idle,health))
        for apps in (None,[],{'applying':'0'},{'claimed':-1}):
            health={'ok':True,'state':{'activeWorkerRuns':0},'gateway':{'queue':{'claimed':0},'application_counts':apps}}
            with self.subTest(apps=apps):
                self.assertFalse(supervisor.recovery_idle(idle,idle,health))
        self.assertFalse(supervisor.recovery_idle(idle,idle,{}))
    def test_dead_or_reused_pid_is_not_an_owned_gateway(self):
        self.assertTrue(callable(getattr(supervisor,'gateway_owned',None)),'native process ownership must be verified')
        home=Path('/isolated/hermes-root').resolve();code=Path('/isolated/root-code').resolve()
        state={'pid':123,'start_time':10000,'kind':'hermes-gateway','hermes_home':str(home),'gateway_state':'running','active_agents':0}
        process=Mock()
        process.is_running.return_value=True
        process.status.return_value='running'
        process.create_time.return_value=100.0
        process.cmdline.return_value=['python','-m','hermes_cli.main','gateway','run']
        process.environ.return_value={'HERMES_HOME':str(home),'PYTHONPATH':str(code)}
        with patch.object(psutil,'Process',return_value=process):
            self.assertTrue(supervisor.gateway_owned(state,home,code))
            process.create_time.return_value=101.0
            self.assertFalse(supervisor.gateway_owned(state,home,code))
            process.create_time.return_value=100.0
            process.environ.return_value={'HERMES_HOME':'/another/profile','PYTHONPATH':str(code)}
            self.assertFalse(supervisor.gateway_owned(state,home,code))
        with patch.object(psutil,'Process',side_effect=psutil.NoSuchProcess(123)):
            self.assertFalse(supervisor.gateway_owned(state,home,code))

if __name__=='__main__':unittest.main()
