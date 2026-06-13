"""One-time copy of local SQLite route edits into PostgreSQL.

Use this when moving an existing instance/edits.db to Replit's managed Postgres
(or any Postgres). It reads every row from the SQLite file and inserts it into
the target, preserving versions, notes, GTFS metadata, history, and timestamps.
Identity ids are NOT copied — Postgres assigns fresh ones (nothing references id).

The target schema is created via db.init_db() if missing, so this is safe to run
against a brand-new database.

Usage:
    # DATABASE_URL points at the Postgres target (Replit injects this in the Repl
    # shell once the PostgreSQL tool is added; set it manually elsewhere).
    python scripts/migrate_sqlite_to_pg.py
    python scripts/migrate_sqlite_to_pg.py --sqlite instance/edits.db

The script is append-only and refuses to run if the target already has route
versions, so it won't silently double-insert. Pass --force to override.
"""
import argparse
import os
import sqlite3
import sys

# Import the project's db module so we reuse its schema + Postgres wiring.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402

# (table, columns to copy in order). id columns are intentionally omitted so
# Postgres' IDENTITY assigns fresh values.
_TABLES = [
    ("route_versions", ["year", "filename", "version", "geometry", "label", "created_at"]),
    ("route_notes", ["year", "route", "note", "updated_at"]),
    ("gtfs_meta", ["year", "key", "data", "updated_at"]),
    ("gtfs_meta_history", ["year", "key", "data", "replaced_at"]),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--sqlite",
        default=os.path.join("instance", "edits.db"),
        help="path to the source SQLite file (default: instance/edits.db)",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="insert even if the target already has route versions",
    )
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set — point it at the Postgres target first.")
    if not os.path.exists(args.sqlite):
        sys.exit(f"source SQLite file not found: {args.sqlite}")

    # Configure db for Postgres (creates the schema if needed).
    db.init_db(dsn=dsn)

    with db._connect() as pg:
        existing = pg.execute("SELECT COUNT(*) AS c FROM route_versions").fetchone()["c"]
        if existing and not args.force:
            sys.exit(
                f"target already has {existing} route version row(s); "
                "re-run with --force to insert anyway."
            )

        src = sqlite3.connect(args.sqlite)
        src.row_factory = sqlite3.Row
        try:
            for table, cols in _TABLES:
                rows = src.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
                if not rows:
                    print(f"{table}: 0 rows")
                    continue
                placeholders = ", ".join(["%s"] * len(cols))
                sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})"
                for r in rows:
                    pg.execute(sql, tuple(r[c] for c in cols))
                print(f"{table}: copied {len(rows)} row(s)")
        finally:
            src.close()
    print("Done. The target Postgres now holds the local edits.")


if __name__ == "__main__":
    main()
