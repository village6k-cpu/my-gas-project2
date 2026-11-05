import difflib,unittest
from install import native_adapter_bytes
BASE='class Adapter:\n    pass\n'
PATCHED='class Adapter:\n    def _claim_capacity_available(self):\n        owner = getattr(getattr(self, "_message_handler", None), "__self__", None)\n        return True\n'
def diff():return ''.join(difflib.unified_diff(BASE.splitlines(True),PATCHED.splitlines(True),fromfile='a/hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py',tofile='b/hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py')).encode()
class InstallerTests(unittest.TestCase):
 def test_second_install_never_reverses_the_capacity_patch(self):
  once=native_adapter_bytes(BASE.encode(),diff());twice=native_adapter_bytes(once,diff());self.assertEqual(once,twice);self.assertEqual(once.count(b'def _claim_capacity_available'),1)
 def test_native_drain_is_checked_before_claiming_more_work(self):
  self.assertIn(b'getattr(owner, "_external_drain_active", False)',native_adapter_bytes(BASE.encode(),diff()))
 def test_failed_forward_patch_does_not_count_as_installed(self):
  with self.assertRaises(ValueError):native_adapter_bytes(BASE.encode(),b'broken patch')
if __name__=='__main__':unittest.main()
