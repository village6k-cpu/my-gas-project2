import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS=Path(__file__).resolve().parents[1]/'scripts/windows'
sys.path.insert(0,str(SCRIPTS))
import migration_source_recovery_executor as recovery

class SchedulerFenceReadbackTests(unittest.TestCase):
    def setUp(self):
        self.expected=[{'name':'task-'+str(i),'path':'\\','definitionSha256':str(i).zfill(64)} for i in range(21)]
        self.actual=[dict(r,enabled=False) for r in self.expected]

    def test_complete_disabled_unchanged_definitions(self):
        recovery.validate_scheduler_fence(self.expected,self.actual)

    def test_enabled_or_unknown_refuses(self):
        for enabled in (True,None,0):
            with self.subTest(enabled=enabled):
                self.actual[0]['enabled']=enabled
                with self.assertRaises(recovery.RecoveryError):recovery.validate_scheduler_fence(self.expected,self.actual)

    def test_changed_definition_or_path_refuses(self):
        for field,value in (('definitionSha256','f'*64),('path','\\other\\')):
            with self.subTest(field=field):
                actual=[dict(r) for r in self.actual];actual[0][field]=value
                with self.assertRaises(recovery.RecoveryError):recovery.validate_scheduler_fence(self.expected,actual)

    def test_missing_extra_and_duplicate_refuse(self):
        for actual in (self.actual[:-1],self.actual+[self.actual[0]],self.actual[:-1]+[self.actual[0]]):
            with self.assertRaises(recovery.RecoveryError):recovery.validate_scheduler_fence(self.expected,actual)

if __name__=='__main__':unittest.main()
