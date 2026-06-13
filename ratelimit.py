"""Per-client rate limiting for data-entry (write) endpoints.

Goal: stop a script from flooding the edits DB with automated writes, without
getting in the way of a human editing routes (autosaves debounce at ~0.6-0.8s,
so real sustained write rates stay well under 2/sec).

Counters are fixed-window and live in the app DB (see db.rate_limit_hit), so the
limits hold across gunicorn workers and Replit autoscale instances — in-memory
counters would be per-process and trivially bypassed once the app scales out.

Each protected endpoint is checked against every tier in WRITE_LIMITS; exceeding
any tier returns 429 with a Retry-After header. Tune without code changes via
the RATE_LIMIT_WRITE env var, e.g. "30/10,100/60" (hits/seconds, comma-separated),
or set RATE_LIMIT_DISABLED=1 to turn it off entirely.
"""
import os
import time
from functools import wraps

from flask import jsonify, request

import db

# Defaults: 30 writes / 10s (burst) and 100 writes / 60s (sustained), per client.
# Both sit far above human editing yet cut off automated flooding within seconds.
_DEFAULT_WRITE_LIMITS = [(30, 10), (100, 60)]


def _parse_limits(spec):
    """Parse "hits/seconds,hits/seconds" into [(hits, seconds), ...]."""
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        hits, _, window = part.partition("/")
        out.append((int(hits), int(window)))
    return out


_env = os.environ.get("RATE_LIMIT_WRITE", "").strip()
WRITE_LIMITS = _parse_limits(_env) if _env else _DEFAULT_WRITE_LIMITS
_DISABLED = os.environ.get("RATE_LIMIT_DISABLED", "").strip() in ("1", "true", "True")


def _client_id():
    """Identify the caller. Behind Replit's proxy, ProxyFix (configured in
    app.py) rewrites remote_addr from the trusted X-Forwarded-For entry, so this
    is the real client IP, not the proxy's."""
    return request.remote_addr or "unknown"


def rate_limited(limits=None, scope="write"):
    """Decorator: reject a request that exceeds any configured rate tier.

    Place it directly under @app.route so the route registers the wrapped view:
        @app.route("/data/edit/<path:filename>", methods=["POST"])
        @rate_limited()
        def save_route(...): ...
    """
    tiers = limits if limits is not None else WRITE_LIMITS

    def decorator(fn):
        if _DISABLED or not tiers:
            return fn

        @wraps(fn)
        def wrapper(*args, **kwargs):
            now = int(time.time())
            ident = _client_id()
            retry_after = 0
            for max_hits, window in tiers:
                window_start = now - (now % window)
                bucket = f"{scope}:{window}:{ident}"
                # Prune this bucket's earlier windows as we go (self-cleaning).
                hits = db.rate_limit_hit(bucket, window_start, prune_before=window_start)
                if hits > max_hits:
                    retry_after = max(retry_after, window - (now % window))
            if retry_after:
                resp = jsonify({"error": "Too many requests — slow down and retry."})
                resp.status_code = 429
                resp.headers["Retry-After"] = str(retry_after)
                return resp
            return fn(*args, **kwargs)

        return wrapper

    return decorator
