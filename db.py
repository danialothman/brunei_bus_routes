"""SQLite store for route edits (full version history).

Originals on disk are never modified. Each Save appends an immutable version
row keyed by (year, filename); the highest version is the active one. Reverting
to the original simply deletes all rows for a route so callers fall back to disk.

Pure stdlib (sqlite3) — framework-agnostic; the DB path is injected by app.py.
"""
import json
import sqlite3

_DB_PATH = None


def init_db(db_path):
    """Remember the DB path and create the schema if needed (idempotent)."""
    global _DB_PATH
    _DB_PATH = db_path
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS route_versions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                year       TEXT    NOT NULL,
                filename   TEXT    NOT NULL,
                version    INTEGER NOT NULL,
                geometry   TEXT    NOT NULL,
                label      TEXT,
                created_at TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE (year, filename, version)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_route_versions_route
            ON route_versions (year, filename, version DESC)
            """
        )
        # Free-text triage notes, one per route (year, route key). Independent of
        # the version history above — notes are about a route, not a geometry edit.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS route_notes (
                year       TEXT NOT NULL,
                route      TEXT NOT NULL,
                note       TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (year, route)
            )
            """
        )


def _connect():
    if _DB_PATH is None:
        raise RuntimeError("db.init_db(path) must be called before use")
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL keeps reads non-blocking against the occasional write.
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def latest_version(year, filename):
    """Highest version number for a route, or None if it has no edits."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT MAX(version) AS v FROM route_versions WHERE year=? AND filename=?",
            (year, filename),
        ).fetchone()
    return row["v"] if row and row["v"] is not None else None


def latest_geometry(year, filename):
    """Parsed geometry dict of the active (highest) version, or None."""
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT geometry FROM route_versions
            WHERE year=? AND filename=?
            ORDER BY version DESC LIMIT 1
            """,
            (year, filename),
        ).fetchone()
    return json.loads(row["geometry"]) if row else None


def distinct_files(year):
    """All distinct route filenames that have at least one saved version."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT filename FROM route_versions WHERE year=?",
            (year,),
        ).fetchall()
    return [r["filename"] for r in rows]


def latest_names(year):
    """Map filename -> custom route name, for routes whose latest edit sets one."""
    out = {}
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT rv.filename AS filename, rv.geometry AS geometry
            FROM route_versions rv
            WHERE rv.year = ? AND rv.version = (
                SELECT MAX(version) FROM route_versions
                WHERE year = rv.year AND filename = rv.filename
            )
            """,
            (year,),
        ).fetchall()
    for r in rows:
        try:
            name = json.loads(r["geometry"]).get("name")
        except (ValueError, TypeError):
            name = None
        if name:
            out[r["filename"]] = name
    return out


def list_versions(year, filename):
    """Version metadata (no geometry blob), newest first."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT version, created_at, label FROM route_versions
            WHERE year=? AND filename=?
            ORDER BY version DESC
            """,
            (year, filename),
        ).fetchall()
    return [dict(r) for r in rows]


def get_version(year, filename, version):
    """Parsed geometry dict for a specific version, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT geometry FROM route_versions WHERE year=? AND filename=? AND version=?",
            (year, filename, version),
        ).fetchone()
    return json.loads(row["geometry"]) if row else None


def add_version(year, filename, geometry, label=None):
    """Append a new version (latest+1) and return its version number."""
    payload = json.dumps(geometry, ensure_ascii=False)
    for _attempt in range(2):  # UNIQUE constraint is a race backstop; retry once
        with _connect() as conn:
            row = conn.execute(
                "SELECT MAX(version) AS v FROM route_versions WHERE year=? AND filename=?",
                (year, filename),
            ).fetchone()
            nxt = (row["v"] or 0) + 1
            try:
                conn.execute(
                    """
                    INSERT INTO route_versions (year, filename, version, geometry, label)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (year, filename, nxt, payload, label),
                )
                conn.commit()
                return nxt
            except sqlite3.IntegrityError:
                continue
    raise sqlite3.IntegrityError("could not allocate a version number")


def get_note(year, route):
    """Free-text note for a route, or '' if none."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT note FROM route_notes WHERE year=? AND route=?",
            (year, route),
        ).fetchone()
    return row["note"] if row else ""


def set_note(year, route, note):
    """Upsert a route's note. Returns the saved text."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO route_notes (year, route, note, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(year, route) DO UPDATE SET
                note = excluded.note, updated_at = excluded.updated_at
            """,
            (year, route, note),
        )
        conn.commit()
    return note


def delete_all(year, filename):
    """Remove every version for a route (revert to original). Returns rows deleted."""
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM route_versions WHERE year=? AND filename=?",
            (year, filename),
        )
        conn.commit()
        return cur.rowcount
