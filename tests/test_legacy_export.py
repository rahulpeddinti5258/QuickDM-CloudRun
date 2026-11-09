import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('export_legacy', ROOT / 'scripts/export_legacy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LegacyExportTest(unittest.TestCase):
    def test_import_preserves_success_and_unknown_and_escapes_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'old.db'
            target = Path(directory) / 'import.sql'
            with sqlite3.connect(source) as db:
                db.execute('CREATE TABLE processed_comments(comment_id TEXT PRIMARY KEY, dm_sent INTEGER, public_reply_sent INTEGER)')
                records = [('success', 1, 1), ('partial', 1, 0), ("quoted'id", 0, 0)]
                db.executemany('INSERT INTO processed_comments VALUES (?, ?, ?)', records)
            self.assertEqual(module.export(source, target), 3)
            with sqlite3.connect(':memory:') as db:
                db.executescript((ROOT / 'migrations/0001_initial.sql').read_text())
                db.executescript(target.read_text())
                db.executescript(target.read_text())
                actual = db.execute('SELECT * FROM imported_comments').fetchall()
                self.assertEqual(sorted(actual), sorted(records))
            with self.assertRaises(FileExistsError):
                module.export(source, target)
