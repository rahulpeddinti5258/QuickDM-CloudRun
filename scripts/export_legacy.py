"""Export existing comment reservations for D1 without modifying the SQLite source."""
import argparse
import os
from pathlib import Path
import sqlite3


def export(source, target):
    source = Path(source).resolve()
    target = Path(target).resolve()
    if source == target:
        raise ValueError('Source and target must differ')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as connection:
        records = connection.execute(
            'SELECT comment_id, dm_sent, public_reply_sent FROM processed_comments'
        ).fetchall()
    statements = []
    for comment_id, dm_sent, public_sent in records:
        if not isinstance(comment_id, str) or not comment_id or '\x00' in comment_id:
            raise ValueError('Invalid legacy comment ID')
        escaped = comment_id.replace("'", "''")
        statements.append(
            "INSERT OR IGNORE INTO imported_comments(comment_id, dm_sent, public_reply_sent) "
            f"VALUES ('{escaped}', {int(bool(dm_sent))}, {int(bool(public_sent))});\n"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects previous exports from accidental replacement.
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        output.writelines(statements)
    return len(records)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Existing quickdm.db path')
    parser.add_argument('target', help='New private SQL file, preferably inside .local/')
    args = parser.parse_args()
    print(f'Exported {export(args.source, args.target)} legacy reservations. No source changes.')
