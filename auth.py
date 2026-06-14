"""Shared-password gate for the editor.

One password (the EDITOR_PASSWORD env var, set as a Replit secret) protects every
write endpoint and the /gtfs workbench; the map/planner/ride pages stay public and
read-only. A signed session cookie keeps the editor logged in — see app.py for the
cookie hardening (HttpOnly, SameSite=Lax, Secure) and SECRET_KEY wiring.

The security boundary is the login_required decorator on the server. Frontend code
only hides controls for anonymous visitors; it is not relied on for enforcement.

Fail-closed: if EDITOR_PASSWORD is unset, no one can log in, so every write endpoint
and the /gtfs workbench stay locked (a warning is logged at import). Set
EDITOR_PASSWORD to enable editing — the same locally and in production.
"""
import hmac
import logging
import os
from functools import wraps
from urllib.parse import urlparse

from flask import jsonify, redirect, request, session, url_for

_PASSWORD = os.environ.get("EDITOR_PASSWORD", "")
# A separate password gates the admin area (/applications). Distinct from the
# editor password so route-editing access doesn't imply access to applicant
# contact details. Fail-closed the same way: unset -> the admin area is locked.
_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

if not _PASSWORD:
    logging.getLogger(__name__).warning(
        "EDITOR_PASSWORD is not set — editing is LOCKED (no one can log in). "
        "Set EDITOR_PASSWORD (and SECRET_KEY) to enable the editor."
    )
if not _ADMIN_PASSWORD:
    logging.getLogger(__name__).warning(
        "ADMIN_PASSWORD is not set — the admin area (/applications) is LOCKED. "
        "Set ADMIN_PASSWORD to enable it."
    )


def configured():
    """True when an editor password is set. With none, login is impossible and
    the editor stays locked (fail-closed)."""
    return bool(_PASSWORD)


def admin_configured():
    """True when an admin password is set (gates the /applications area)."""
    return bool(_ADMIN_PASSWORD)


def is_authed():
    """True only for a session that has logged in. Fail-closed: with no
    EDITOR_PASSWORD set, check_password() always fails, so this never becomes
    True and the editor stays locked."""
    return bool(session.get("authed"))


def is_admin():
    """True only for a session that logged in with the admin password."""
    return bool(session.get("admin"))


def check_password(candidate):
    """Constant-time check of a submitted password against EDITOR_PASSWORD."""
    if not _PASSWORD:
        return False
    return hmac.compare_digest(str(candidate or ""), _PASSWORD)


def check_admin_password(candidate):
    """Constant-time check of a submitted password against ADMIN_PASSWORD."""
    if not _ADMIN_PASSWORD:
        return False
    return hmac.compare_digest(str(candidate or ""), _ADMIN_PASSWORD)


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


def admin_required(api=False):
    """Decorator: require a session logged in with the admin password. Same
    shape as login_required, but gates the admin area instead of the editor."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if is_admin():
                return fn(*args, **kwargs)
            if api:
                return jsonify({"error": "admin login required"}), 401
            return redirect(url_for("login_page", next=request.path))
        return wrapper
    return decorator
