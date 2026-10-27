import importlib.util
from pathlib import Path, PurePosixPath
import unittest

MODULE=Path(__file__).resolve().parents[1]/'scripts/macos/migration_environment.py'

class PersistentEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(MODULE.is_file(),'persistent native environment compiler required')
        spec=importlib.util.spec_from_file_location('native_environment',MODULE)
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
    def test_session_turn_and_cron_delivery_identity_never_become_launch_settings(self):
        persistent={'HERMES_HOME':'/native/root','HERMES_MODEL':'same','HERMES_GATEWAY_DETACHED':'1','SLACK_BOT_TOKEN':'fixture'}
        source=dict(persistent,HERMES_SESSION_ID='old',HERMES_SESSION_CHAT_ID='old-chat',HERMES_SESSION_PROFILE='old-profile',HERMES_TURN_ID='old-turn',HERMES_CRON_SESSION='1',HERMES_CRON_AUTO_DELIVER_CHAT_ID='old-delivery')
        self.assertEqual(self.module.persistent_environment(source),persistent)
        self.assertIn('HERMES_SESSION_ID',source)
    def test_business_worker_and_hermes_use_the_same_isolated_driver(self):
        root=PurePosixPath('/native/candidate')
        env=self.module.cua_environment(root)
        self.assertEqual(env['CUA_DRIVER_COMMAND'],'/native/candidate/control/village-cua-driver.py')
        self.assertEqual(env['HERMES_CUA_DRIVER_CMD'],'/native/candidate/venv-root/bin/python /native/candidate/control/village-cua-driver.py')
    def test_profile_keeps_configured_tool_settings_outside_live_process_prefixes(self):
        configured={'IMAGE_TOOLS_DEBUG':'false','BRAVE_API_KEY':'fixture','HERMES_SESSION_ID':'old','SLACK_HOME_CHANNEL_THREAD_ID':''}
        live={'HERMES_HOME':'/native/root','KAKAO_REMOTE_DEBUGGING_PORT':'19223'}
        self.assertEqual(self.module.profile_environment(configured,live),{
            'IMAGE_TOOLS_DEBUG':'false','BRAVE_API_KEY':'fixture','SLACK_HOME_CHANNEL_THREAD_ID':'',
            'HERMES_HOME':'/native/root','KAKAO_REMOTE_DEBUGGING_PORT':'19223'})
    def test_relocation_converts_path_suffix_separators_and_preserves_other_escapes(self):
        pairs=[('C:/Users/operator/hermes','/native/root')]
        text=r'cat C:\Users\operator\hermes\skills\ops\SKILL.md; keep regex \d and \n'
        self.assertEqual(self.module.relocate_text(text,pairs),r'cat /native/root/skills/ops/SKILL.md; keep regex \d and \n')

if __name__=='__main__':unittest.main()
