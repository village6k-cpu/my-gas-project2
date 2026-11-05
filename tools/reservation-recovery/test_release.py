import unittest
from release import idle_for_release

class ReleaseTests(unittest.TestCase):
    def health(self):return {'consumer':{'fresh':True},'queue':{'ready':0},'application_counts':dict.fromkeys(['pending','claimed','applying','applied'],0)}
    def test_verified_idle_uses_live_consumer_even_if_status_file_is_old(self):
        self.assertTrue(idle_for_release({'active_agents':0,'updated_at':'2000-01-01T00:00:00Z'},self.health(),True))
    def test_active_or_unverified_native_turn_never_interrupted(self):
        self.assertFalse(idle_for_release({'active_agents':1},self.health(),True));self.assertFalse(idle_for_release({'active_agents':0},self.health(),False))
    def test_busy_application_or_disconnected_consumer_defers_release(self):
        health=self.health();health['application_counts']['applying']=1;self.assertFalse(idle_for_release({'active_agents':0},health,True));health=self.health();health['consumer']['fresh']=False;self.assertFalse(idle_for_release({'active_agents':0},health,True))
if __name__=='__main__':unittest.main()
