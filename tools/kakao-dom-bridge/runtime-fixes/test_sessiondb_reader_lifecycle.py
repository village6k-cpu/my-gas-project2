"""Real SQLite regression; only a disposable HERMES_HOME is opened."""
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

SOURCE = Path(os.environ['HERMES_RUNTIME_SOURCE']).resolve()
sys.path.insert(0, str(SOURCE))

class ReaderLifecycleTest(unittest.TestCase):
    def test_short_lived_threads_do_not_accumulate_connections(self):
        with tempfile.TemporaryDirectory(prefix='village-reader-regression-') as home:
            os.environ['HERMES_HOME'] = home
            from hermes_state import SessionDB
            db = SessionDB(db_path=Path(home) / 'state.db')
            errors = []
            try:
                self.assertTrue(db._wal_active)
                def read():
                    try:
                        conn = db._get_read_conn()
                        self.assertIsNotNone(conn)
                        self.assertEqual(conn.execute('SELECT 1').fetchone()[0], 1)
                    except BaseException as exc:
                        errors.append(exc)
                for _ in range(40):
                    thread = threading.Thread(target=read)
                    thread.start()
                    thread.join(10)
                    self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertLessEqual(len(db._read_conns), 1)
                # Main-thread close must actually release a retired thread's
                # tracked reader, rather than swallow ProgrammingError.
                readers = list(db._read_conns)
                db.close()
                for conn in readers:
                    with self.assertRaisesRegex(Exception, "closed database"):
                        conn.execute('SELECT 1')
                from hermes_cli.sqlite_safe_read import has_live_connection
                self.assertFalse(has_live_connection(db.db_path))
            finally:
                db.close()

    def test_active_reader_is_not_reclaimed(self):
        with tempfile.TemporaryDirectory(prefix='village-live-reader-') as home:
            os.environ['HERMES_HOME'] = home
            from hermes_state import SessionDB
            db = SessionDB(db_path=Path(home) / 'state.db')
            ready = threading.Event()
            release = threading.Event()
            errors = []
            def live_read():
                try:
                    conn = db._get_read_conn()
                    ready.set()
                    release.wait(10)
                    self.assertEqual(conn.execute('SELECT 7').fetchone()[0], 7)
                except BaseException as exc:
                    errors.append(exc)
            thread = threading.Thread(target=live_read)
            thread.start()
            try:
                self.assertTrue(ready.wait(10))
                for _ in range(10):
                    worker = threading.Thread(target=lambda: db._get_read_conn().execute('SELECT 1').fetchone())
                    worker.start()
                    worker.join(10)
                self.assertLessEqual(len(db._read_conns), 2)
            finally:
                release.set()
                thread.join(10)
                db.close()
            self.assertEqual(errors, [])

if __name__ == '__main__':
    unittest.main()
