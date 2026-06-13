"""Shared-password gate for the editor.

One password (the EDITOR_PASSWORD env var, set as a Replit secret) protects every
write endpoint and the /gtfs workbench; the map/planner/ride pages stay public and
read-only. A signed session cookie keeps the editor logged in — see app.py for the
cookie hardening (HttpOnly, SameSite=Lax, Secure) and SECRET_KEY wiring.

The security boundary is the login_required decorator on the server. Frontend code
only hides controls for anonymous visitors; it is not relied on for enforcement.

If EDITOR_PASSWORD is unset, the gate is a no-op (editing stays open, as before)
and a warning is logged at import — convenient for local dev. Production must set
it. For fail-closed behaviour instead, make _enforced() return True unconditionally
and have check_password() reject when no password is configured.
"""
import hmac
import logging
import os
from functools import wraps
from urllib.parse import urlparse

from flask import jsonify, redirect, request, session, url_for

_PASSWORD = os.environ.get("EDITOR_PASSWORD", "")

if not _PASSWORD:
    logging.getLogger(__name__).warning(
        "EDITOR_PASSWORD is not set — the editor is UNPROTECTED (anyone can write). "
        "Set EDITOR_PASSWORD (and SECRET_KEY) to require login before editing."
    )


def _enforced():
    """Auth is enforced only when a password is configured."""
    return bool(_PASSWORD)


def is_authed():
    """True if the current session has logged in (or auth isn't enforced)."""
    return not _enforced() or bool(session.get("authed"))


def check_password(candidate):
    """Constant-time check of a submitted password against EDITOR_PASSWORD."""
    if not _PASSWORD:
        return False
    return hmac.compare_digest(str(candidate or ""), _PASSWORD)


def safe_next(target):
    """Return target only if it's a local path (open-redirect guard), else None.

    Rejects absolute URLs and scheme-relative '//host' values; accepts only paths
    beginning with a single '/'."""
    if not target or not target.startswith("/") or target.startswith("//"):
        return None
    parts = urlparse(target)
    if parts.scheme or parts.netloc:
        return None
    return target


def login_required(api=False):
    """Decorator: require a logged-in session.

    api=True  -> respond 401 JSON (for fetch/XHR write endpoints).
    api=False -> redirect to the login page with ?next= (for HTML pages).

    Place directly under @app.route and above @ratelimit.rate_limited so an
    unauthenticated caller is rejected before consuming limiter budget.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if is_authed():
                return fn(*args, **kwargs)
            if api:
                return jsonify({"error": "login required"}), 401
            return redirect(url_for("login_page", next=request.path))
        return wrapper
    return decorator
