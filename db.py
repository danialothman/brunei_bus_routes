"""Versioned store for route edits — SQLite locally, PostgreSQL on Replit.

The backend is chosen at init_db(): a connection string (explicit dsn, or the
DATABASE_URL env var that Replit's managed Postgres injects) selects PostgreSQL;
otherwise a local SQLite file. This matters for hosting — Replit Deployments have
an ephemeral filesystem, so a SQLite file there is wiped on every redeploy and
not shared across autoscale instances. Postgres lives outside that filesystem
and persists. Local dev keeps using SQLite with no setup.

Every function below is backend-agnostic: the small dialect differences (the
parameter marker `?` and `datetime('now')`) are translated for Postgres in _q(),
and the schema's column types are emitted per-backend in _schema().

Originals on disk are never modified. Each Save appends an immutable version
row keyed by (year, filename); the highest version is the active one. Reverting
to the original simply deletes all rows for a route so callers fall back to disk.
"""
import contextlib
import json
import os
import sqlite3

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg import errors as _pg_errors
    _HAVE_PSYCOPG = True
except ImportError:  # SQLite-only environments don't need the Postgres driver
    _HAVE_PSYCOPG = False

_BACKEND = None   # "sqlite" | "postgres", set by init_db
_DB_PATH = None   # SQLite file path
_DSN = None       # Postgres connection string

# UNIQUE-violation classes differ by backend; add_version catches both.
_INTEGRITY_ERRORS = (sqlite3.IntegrityError,)
if _HAVE_PSYCOPG:
    _INTEGRITY_ERRORS = (sqlite3.IntegrityError, _pg_errors.UniqueViolation)


def init_db(db_path=None, dsn=None):
    """Choose the backend and create the schema if needed (idempotent).

    Pass dsn — or set the DATABASE_URL env var (Replit's managed Postgres) — to
    use PostgreSQL; otherwise db_path selects a local SQLite file. app.py passes
    db_path and lets the environment decide which backend wins.
    """
    global _BACKEND, _DB_PATH, _DSN
    dsn = dsn or os.environ.get("DATABASE_URL")
    if dsn:
        if not _HAVE_PSYCOPG:
            raise RuntimeError(
                "DATABASE_URL is set but psycopg is not installed; "
                "add 'psycopg[binary]' to requirements.txt"
            )
        # Some platforms hand out the legacy postgres:// scheme; psycopg wants
        # postgresql://. SQLAlchemy does the same normalisation.
        if dsn.startswith("postgres://"):
            dsn = "postgresql://" + dsn[len("postgres://"):]
        _BACKEND = "postgres"
        _DSN = dsn
    else:
        _BACKEND = "sqlite"
        _DB_PATH = db_path
    with _connect() as conn:
        for stmt in _schema():
            conn.execute(stmt)
    # Run each migration in its own transaction so an "already exists" failure
    # (the expected case on fresh DBs / re-runs) rolls back only that statement.
    for stmt in _migrations():
        try:
            with _connect() as conn:
                conn.execute(_q(stmt))
        except Exception:
            pass


@contextlib.contextmanager
def _connect():
    """Yield a connection, committing on clean exit and always closing.

    Both backends expose conn.execute(sql, params) -> cursor and dict-style row
    access (sqlite3.Row / psycopg dict_row), so the query functions below don't
    care which one they got.
    """
    if _BACKEND is None:
        raise RuntimeError("db.init_db(...) must be called before use")
    if _BACKEND == "postgres":
        conn = psycopg.connect(_DSN, row_factory=dict_row)
    else:
        conn = sqlite3.connect(_DB_PATH)
        conn.row_factory = sqlite3.Row
        # WAL keeps reads non-blocking against the occasional write.
        conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _q(sql):
    """Translate our SQLite-flavoured SQL to the active backend.

    `?` placeholders become `%s`, and inline datetime('now') becomes the Postgres
    equivalent. Both tokens appear only as SQL syntax here, never inside literals.
    """
    if _BACKEND == "postgres":
        return sql.replace("?", "%s").replace("datetime('now')", "(now())::text")
    return sql


def _schema():
    """CREATE statements for the active backend (column types differ; SQL shared)."""
    if _BACKEND == "postgres":
        idpk = "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
        now = "((now())::text)"
    else:
        idpk = "INTEGER PRIMARY KEY AUTOINCREMENT"
        now = "(datetime('now'))"
    return [
        f"""
        CREATE TABLE IF NOT EXISTS route_versions (
            id         {idpk},
            year       TEXT    NOT NULL,
            filename   TEXT    NOT NULL,
            version    INTEGER NOT NULL,
            geometry   TEXT    NOT NULL,
            label      TEXT,
            created_at TEXT    NOT NULL DEFAULT {now},
            UNIQUE (year, filename, version)
        )
        """,
        """
        CREATE INDEX IF NOT EXISTS idx_route_versions_route
        ON route_versions (year, filename, version DESC)
        """,
        # Free-text triage notes, one per route (year, route key). Independent of
        # the version history above — notes are about a route, not a geometry edit.
        f"""
        CREATE TABLE IF NOT EXISTS route_notes (
            year       TEXT NOT NULL,
            route      TEXT NOT NULL,
            note       TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT {now},
            PRIMARY KEY (year, route)
        )
        """,
        # GTFS metadata overrides as JSON blobs. `key` is a route filename for
        # per-route data (schedule, names, color) or '_feed' for feed-level
        # settings (agency, fare). Upsert-only, like route_notes.
        f"""
        CREATE TABLE IF NOT EXISTS gtfs_meta (
            year       TEXT NOT NULL,
            key        TEXT NOT NULL,
            data       TEXT NOT NULL DEFAULT '{{}}',
            updated_at TEXT NOT NULL DEFAULT {now},
            PRIMARY KEY (year, key)
        )
        """,
        # Every overwritten gtfs_meta value is archived here, so a bad
        # autosave is recoverable (via SQL; no UI). Append-only.
        f"""
        CREATE TABLE IF NOT EXISTS gtfs_meta_history (
            id          {idpk},
            year        TEXT NOT NULL,
            key         TEXT NOT NULL,
            data        TEXT NOT NULL,
            replaced_at TEXT NOT NULL DEFAULT {now}
        )
        """,
        # Fixed-window request counters for rate limiting (see ratelimit.py).
        # Shared through the DB so limits hold across gunicorn workers and
        # autoscale instances, where in-memory counters would not.
        """
        CREATE TABLE IF NOT EXISTS rate_limits (
            bucket       TEXT    NOT NULL,
            window_start BIGINT  NOT NULL,
            hits         INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (bucket, window_start)
        )
        """,
        # Freelance field data-collection applications from the public /join
        # hiring page. Submitted fields are read-only; status + admin_note are
        # managed from the authed /applications view.
        f"""
        CREATE TABLE IF NOT EXISTS applications (
            id           {idpk},
            name         TEXT NOT NULL,
            contact      TEXT NOT NULL,
            districts    TEXT NOT NULL DEFAULT '',
            transport    TEXT NOT NULL DEFAULT '',
            availability TEXT NOT NULL DEFAULT '',
            experience   TEXT NOT NULL DEFAULT '',
            message      TEXT NOT NULL DEFAULT '',
            status       TEXT NOT NULL DEFAULT 'New',
            admin_note   TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL DEFAULT {now}
        )
        """,
    ]


def _migrations():
    """Idempotent ALTERs to evolve tables created by an earlier schema. Each is
    attempted in its own transaction and its 'column already exists' error
    ignored, so they no-op on fresh DBs (which already have the columns) and on
    re-runs. Add new column migrations here rather than mutating _schema()."""
    return [
        "ALTER TABLE applications ADD COLUMN status TEXT NOT NULL DEFAULT 'New'",
        "ALTER TABLE applications ADD COLUMN admin_note TEXT NOT NULL DEFAULT ''",
    ]


def latest_version(year, filename):
    """Highest version number for a route, or None if it has no edits."""
    with _connect() as conn:
        row = conn.execute(
            _q("SELECT MAX(version) AS v FROM route_versions WHERE year=? AND filename=?"),
            (year, filename),
        ).fetchone()
    return row["v"] if row and row["v"] is not None else None


def latest_geometry(year, filename):
    """Parsed geometry dict of the active (highest) version, or None."""
    with _connect() as conn:
        row = conn.execute(
            _q(
                """
                SELECT geometry FROM route_versions
                WHERE year=? AND filename=?
                ORDER BY version DESC LIMIT 1
                """
            ),
            (year, filename),
        ).fetchone()
    return json.loads(row["geometry"]) if row else None


def distinct_files(year):
    """All distinct route filenames that have at least one saved version."""
    with _connect() as conn:
        rows = conn.execute(
            _q("SELECT DISTINCT filename FROM route_versions WHERE year=?"),
            (year,),
        ).fetchall()
    return [r["filename"] for r in rows]


def latest_names(year):
    """Map filename -> custom route name, for routes whose latest edit sets one."""
    out = {}
    with _connect() as conn:
        rows = conn.execute(
            _q(
                """
                SELECT rv.filename AS filename, rv.geometry AS geometry
                FROM route_versions rv
                WHERE rv.year = ? AND rv.version = (
                    SELECT MAX(version) FROM route_versions
                    WHERE year = rv.year AND filename = rv.filename
                )
                """
            ),
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
            _q(
                """
                SELECT version, created_at, label FROM route_versions
                WHERE year=? AND filename=?
                ORDER BY version DESC
                """
            ),
            (year, filename),
        ).fetchall()
    return [dict(r) for r in rows]


def get_version(year, filename, version):
    """Parsed geometry dict for a specific version, or None."""
    with _connect() as conn:
        row = conn.execute(
            _q("SELECT geometry FROM route_versions WHERE year=? AND filename=? AND version=?"),
            (year, filename, version),
        ).fetchone()
    return json.loads(row["geometry"]) if row else None


def add_version(year, filename, geometry, label=None):
    """Append a new version (latest+1) and return its version number."""
    payload = json.dumps(geometry, ensure_ascii=False)
    for _attempt in range(2):  # UNIQUE constraint is a race backstop; retry once
        with _connect() as conn:
            row = conn.execute(
                _q("SELECT MAX(version) AS v FROM route_versions WHERE year=? AND filename=?"),
                (year, filename),
            ).fetchone()
            nxt = (row["v"] or 0) + 1
            try:
                conn.execute(
                    _q(
                        """
                        INSERT INTO route_versions (year, filename, version, geometry, label)
                        VALUES (?, ?, ?, ?, ?)
                        """
                    ),
                    (year, filename, nxt, payload, label),
                )
                return nxt  # context manager commits on the way out
            except _INTEGRITY_ERRORS:
                # Postgres aborts the txn on error; roll back before the retry.
                conn.rollback()
                continue
    raise sqlite3.IntegrityError("could not allocate a version number")


def get_note(year, route):
    """Free-text note for a route, or '' if none."""
    with _connect() as conn:
        row = conn.execute(
            _q("SELECT note FROM route_notes WHERE year=? AND route=?"),
            (year, route),
        ).fetchone()
    return row["note"] if row else ""


def set_note(year, route, note):
    """Upsert a route's note. Returns the saved text."""
    with _connect() as conn:
        conn.execute(
            _q(
                """
                INSERT INTO route_notes (year, route, note, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT (year, route) DO UPDATE SET
                    note = excluded.note, updated_at = excluded.updated_at
                """
            ),
            (year, route, note),
        )
    return note


def add_application(fields):
    """Insert a field-collection application and return its new id. `fields` is a
    dict with name, contact, districts, transport, availability, experience,
    message (the optional ones default to '')."""
    cols = ("name", "contact", "districts", "transport",
            "availability", "experience", "message")
    values = tuple(fields.get(c, "") or "" for c in cols)
    sql = _q(
        f"INSERT INTO applications ({', '.join(cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})"
    )
    with _connect() as conn:
        if _BACKEND == "postgres":
            row = conn.execute(sql + " RETURNING id", values).fetchone()
            return row["id"]
        cur = conn.execute(sql, values)
        return cur.lastrowid


def list_applications(limit=500):
    """All applications, newest first, capped at `limit`."""
    with _connect() as conn:
        rows = conn.execute(
            _q(
                """
                SELECT id, name, contact, districts, transport,
                       availability, experience, message, status,
                       admin_note, created_at
                FROM applications
                ORDER BY id DESC LIMIT ?
                """
            ),
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def set_application_status(app_id, status):
    """Update one application's status. Returns True if a row was updated."""
    with _connect() as conn:
        cur = conn.execute(
            _q("UPDATE applications SET status=? WHERE id=?"), (status, app_id)
        )
        return cur.rowcount > 0


def set_application_note(app_id, note):
    """Update one application's admin note. Returns True if a row was updated."""
    with _connect() as conn:
        cur = conn.execute(
            _q("UPDATE applications SET admin_note=? WHERE id=?"), (note, app_id)
        )
        return cur.rowcount > 0


def delete_application(app_id):
    """Delete one application. Returns True if a row was removed."""
    with _connect() as conn:
        cur = conn.execute(
            _q("DELETE FROM applications WHERE id=?"), (app_id,)
        )
        return cur.rowcount > 0


def get_gtfs_meta(year, key):
    """GTFS metadata dict for a route filename (or '_feed'), or {} if none."""
    with _connect() as conn:
        row = conn.execute(
            _q("SELECT data FROM gtfs_meta WHERE year=? AND key=?"),
            (year, key),
        ).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["data"])
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


def set_gtfs_meta(year, key, data):
    """Upsert GTFS metadata for a route (or '_feed'), archiving the value
    being replaced into gtfs_meta_history. Returns the saved dict."""
    payload = json.dumps(data, ensure_ascii=False)
    with _connect() as conn:
        row = conn.execute(
            _q("SELECT data FROM gtfs_meta WHERE year=? AND key=?"), (year, key)
        ).fetchone()
        if row and row["data"] != payload:
            conn.execute(
                _q("INSERT INTO gtfs_meta_history (year, key, data) VALUES (?, ?, ?)"),
                (year, key, row["data"]),
            )
        conn.execute(
            _q(
                """
                INSERT INTO gtfs_meta (year, key, data, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT (year, key) DO UPDATE SET
                    data = excluded.data, updated_at = excluded.updated_at
                """
            ),
            (year, key, payload),
        )
    return data


def all_gtfs_meta(year):
    """All GTFS metadata for a year: {key: dict} (includes '_feed' if set)."""
    out = {}
    with _connect() as conn:
        rows = conn.execute(
            _q("SELECT key, data FROM gtfs_meta WHERE year=?"), (year,)
        ).fetchall()
    for r in rows:
        try:
            data = json.loads(r["data"])
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            out[r["key"]] = data
    return out


def change_stamp(year):
    """Cheap fingerprint of a year's edits, for cache invalidation: changes
    whenever route geometry or GTFS metadata is saved, replaced, or deleted."""
    with _connect() as conn:
        rv = conn.execute(
            _q("SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM route_versions WHERE year=?"),
            (year,),
        ).fetchone()
        gm = conn.execute(
            _q("SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), '') AS m FROM gtfs_meta WHERE year=?"),
            (year,),
        ).fetchone()
        # History grows on every overwrite, catching same-second meta updates.
        gh = conn.execute(
            _q("SELECT COALESCE(MAX(id), 0) AS m FROM gtfs_meta_history WHERE year=?"),
            (year,),
        ).fetchone()
    return (rv["c"], rv["m"], gm["c"], gm["m"], gh["m"])


def rate_limit_hit(bucket, window_start, prune_before=None):
    """Atomically count one request in a fixed window and return the running
    total for (bucket, window_start). Optionally drop the bucket's older windows
    to keep the table small. Backend-shared, so counts hold across gunicorn
    workers and autoscale instances. Used by ratelimit.py."""
    with _connect() as conn:
        conn.execute(
            _q(
                """
                INSERT INTO rate_limits (bucket, window_start, hits)
                VALUES (?, ?, 1)
                ON CONFLICT (bucket, window_start)
                DO UPDATE SET hits = rate_limits.hits + 1
                """
            ),
            (bucket, window_start),
        )
        row = conn.execute(
            _q("SELECT hits FROM rate_limits WHERE bucket=? AND window_start=?"),
            (bucket, window_start),
        ).fetchone()
        if prune_before is not None:
            conn.execute(
                _q("DELETE FROM rate_limits WHERE bucket=? AND window_start<?"),
                (bucket, prune_before),
            )
    return row["hits"]


def delete_all(year, filename):
    """Remove every version for a route (revert to original). Returns rows deleted."""
    with _connect() as conn:
        cur = conn.execute(
            _q("DELETE FROM route_versions WHERE year=? AND filename=?"),
            (year, filename),
        )
        return cur.rowcount
