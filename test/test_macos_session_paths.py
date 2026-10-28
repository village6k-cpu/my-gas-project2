import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path
from migration_session_paths import restore

class RestoreSessionPathsTests(unittest.TestCase):
    def test_exact_execution_path_changes_without_touching_history(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d); raw=base/'raw.db'; destination=base/'candidate';destination.mkdir()
            project=destination/'project';project.mkdir()
            conn=sqlite3.connect(raw)
            conn.executescript('CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,history TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,body BLOB);')
            conn.executemany('INSERT INTO sessions VALUES(?,?,?)', [('live',r'C:\Village\my-gas-project2','C:\\Village\\my-gas-project2 remains historical text'),('old',r'C:\Village\my-gas-project2-worktrees\retired','keep'),('mac','/Users/old-owner/project','keep')])
            conn.execute('INSERT INTO messages VALUES(1,?)',(b'\x00\xff historical message',));conn.commit();conn.close()
            sha=hashlib.sha256(raw.read_bytes()).hexdigest()
            output=destination/'restored.db'
            result=restore(raw,output,sha,{'C:/Village/my-gas-project2':str(project)},destination)
            self.assertEqual(result['updated_sessions'],1)
            self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(),sha)
            conn=sqlite3.connect(output)
            self.assertEqual(conn.execute('SELECT cwd FROM sessions WHERE id="old"').fetchone()[0],r'C:\Village\my-gas-project2-worktrees\retired')
            self.assertEqual(conn.execute('SELECT body FROM messages').fetchone()[0],b'\x00\xff historical message');conn.close()
            with self.assertRaises(ValueError):restore(raw,output,sha,{},destination)
            with self.assertRaises(ValueError):restore(raw,destination/'bad.db','0'*64,{},destination)
            with self.assertRaises(ValueError):restore(raw,destination/'escape.db',sha,{'C:/else':str(base)},destination)

    def test_a_trigger_cannot_rewrite_history_during_path_update(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);raw=base/'raw.db';candidate=base/'candidate';candidate.mkdir()
            conn=sqlite3.connect(raw)
            conn.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,history TEXT);INSERT INTO sessions VALUES('x','C:/Village','original');CREATE TRIGGER unsafe_history AFTER UPDATE OF cwd ON sessions BEGIN UPDATE sessions SET history='changed' WHERE id=new.id;END;")
            conn.close();sha=hashlib.sha256(raw.read_bytes()).hexdigest()
            with self.assertRaises(sqlite3.DatabaseError):restore(raw,candidate/'copy.db',sha,{'C:/Village':str(candidate)},candidate)
            self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(),sha)

if __name__=='__main__':unittest.main()
