from flask import (
    Flask, render_template, send_from_directory, jsonify, json, request, Response,
    url_for, session, redirect,
)
import csv
import datetime
import io
import os
import re
import math
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _xml_escape

import db
import gtfs
import planner
import ratelimit
import auth

# Prefer defusedxml to guard against XXE / entity-expansion attacks; fall back
# to the stdlib parser (our KML files are trusted, shipped-in-repo assets).
try:
    from defusedxml.ElementTree import parse as _xml_parse
except ImportError:
    _xml_parse = ET.parse

app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)

# On Replit (and most PaaS) the app sits behind one reverse proxy, so the real
# client IP arrives in X-Forwarded-For. Trust exactly one hop so request.remote_addr
# reflects the client — rate limiting keys on it. Locally there's no such header,
# so remote_addr stays the loopback address. See ratelimit.py.
from werkzeug.middleware.proxy_fix import ProxyFix  # noqa: E402

app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

# Signed-cookie sessions back the editor login (see auth.py). SECRET_KEY must be
# set in production so the cookie validates across gunicorn workers and autoscale
# instances (same rationale as DATABASE_URL); the random fallback is dev-only and
# resets sessions on restart. SameSite=Lax is the CSRF baseline — the cookie isn't
# sent on cross-site POST/DELETE/fetch — and the write endpoints already require
# JSON. Secure is on only when SECRET_KEY is set, so local http login still works.
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("SECRET_KEY")),
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=14),
)

# The route data is segregated by year so new datasets live alongside the repo
# owner's original 2016 set (under sibling folders, e.g. data/2026). DATA_YEAR is
# the default; clients may request a specific year via the ?year= query param.
DATA_YEAR = "2016"

# Users may create brand-new routes only for this dataset year. New routes have
# no shipped file — they live entirely in the edits DB.
USER_ROUTE_YEAR = "2026"

# GTFS export. The Brunei data has real geometry + named stops but no timetables,
# so the feed is frequency-based with synthetic stop times (see gtfs.py). The
# single agency is a documented placeholder: ~5 operators are suspected but only
# ADBS is on record (docs/2016/reference/notes.txt). Route -> operator mapping is
# unknown, so every route references this one agency for now.
GTFS_AGENCY = {
    "id": "ADBS",
    "name": "ADBS Sdn Bhd",
    "url": "https://www.jpd.gov.bn/",
    "timezone": "Asia/Brunei",
    "lang": "ms",
    "phone": "+673 239 0241",
    "email": "",
}

# Feed-wide schedule defaults. Headway/window are nominal placeholders until real
# values are transcribed from the JPD timing signboards. Calendar validity is a
# fixed window (kept deterministic — no wall-clock dependency).
GTFS_PARAMS = {
    "headway_secs": 1800,          # 30 min
    "start_time": "06:00:00",
    "end_time": "20:00:00",
    "service_id": "DAILY",
    "days": [1, 1, 1, 1, 1, 1, 1],  # Mon..Sun
    "start_date": "20160101",
    "end_date": "20261231",
    "feed_version": "2016.1",
    "publisher_name": "Brunei Bus Routes project",
    "publisher_url": "https://github.com/danialothman/brunei_bus_routes",
    "feed_lang": "ms",
}

# Route edits live in a versioned DB, so the shipped route files are never
# modified. Backend is chosen at runtime (see db.py): Postgres when DATABASE_URL
# is set (e.g. Replit's managed Postgres, which survives redeploys), otherwise a
# local SQLite file under Flask's instance folder (gitignored). Init at import
# time so it runs under `flask run`, `python app.py`, and gunicorn alike.
os.makedirs(app.instance_path, exist_ok=True)
db.init_db(db_path=os.path.join(app.instance_path, "edits.db"))


@app.context_processor
def _asset_version():
    """Cache-buster for our own static assets: templates append ?v={{ asset_v }}
    so browsers re-fetch JS/CSS whenever any of it changes on disk."""
    latest = 0
    for sub in ("js", "css"):
        base = os.path.join(app.static_folder, sub)
        for root, _dirs, files in os.walk(base):
            for f in files:
                try:
                    latest = max(latest, int(os.path.getmtime(os.path.join(root, f))))
                except OSError:
                    continue
    return {"asset_v": latest}


def _available_years():
    """Year folders under static/data that hold a routes.json (sorted)."""
    base = os.path.join(app.static_folder, "data")
    years = []
    if os.path.isdir(base):
        for name in os.listdir(base):
            if re.fullmatch(r"\d{4}", name) and os.path.exists(
                os.path.join(base, name, "routes.json")
            ):
                years.append(name)
    return sorted(years)


def _resolve_year(year):
    """Validate a requested year (4 digits + existing folder), else DATA_YEAR."""
    if year and re.fullmatch(r"\d{4}", year) and os.path.isdir(
        os.path.join(app.static_folder, "data", year)
    ):
        return year
    return DATA_YEAR


def _find_kml(filename, year=None):
    """Locate a KML file: static/data/<year>/kml first, then top-level data/<year>/kml."""
    # Reject path traversal / absolute paths — only serve plain KML filenames.
    if os.path.isabs(filename) or ".." in filename.replace("\\", "/").split("/"):
        return None

    year = _resolve_year(year)

    static_kml = os.path.join(app.static_folder, "data", year, "kml", filename)
    if os.path.exists(static_kml):
        return static_kml

    data_kml = os.path.join("data", year, "kml", filename)
    if os.path.exists(data_kml):
        return data_kml

    return None


def _find_geojson(filename, year=None):
    """Locate a GeoJSON file under the chosen year (static first, then data/)."""
    if os.path.isabs(filename) or ".." in filename.replace("\\", "/").split("/"):
        return None

    year = _resolve_year(year)

    static_gj = os.path.join(app.static_folder, "data", year, "geojson", filename)
    if os.path.exists(static_gj):
        return static_gj

    data_gj = os.path.join("data", year, "geojson", filename)
    if os.path.exists(data_gj):
        return data_gj

    return None


# Official JPD stop-list signboards live under docs/<year>/images/stops/ (outside
# static/, so they need their own serving route). Resolved from this file's dir so
# the working directory doesn't matter.
DOCS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")


def _stop_images_dir(year):
    return os.path.join(DOCS_DIR, year, "images", "stops")


def _route_from_image(filename):
    """Derive a route label from a signboard filename:
    '20 [20150131].jpg' -> '20', '01A.jpg' -> '01A'."""
    stem = os.path.splitext(filename)[0]
    return re.split(r"\s*\[", stem)[0].strip()


def _find_stop_image(year, filename):
    """Locate a signboard image, rejecting path traversal / bad years."""
    if not re.fullmatch(r"\d{4}", year or ""):
        return None
    if os.path.isabs(filename) or ".." in filename.replace("\\", "/").split("/"):
        return None
    path = os.path.join(_stop_images_dir(year), filename)
    return path if os.path.isfile(path) else None


def _localname(tag):
    """Strip the XML namespace from a tag, e.g. '{ns}LineString' -> 'LineString'."""
    return tag.rsplit("}", 1)[-1]


def _parse_coords(text):
    """Parse a KML <coordinates> blob ('lon,lat[,alt] lon,lat[,alt] ...')."""
    points = []
    for token in text.split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        points.append([lon, lat])
    return points


def parse_route_geometry(path):
    """Extract drive-path LineStrings and named stop Points from a KML file."""
    root = _xml_parse(path).getroot()
    segments = []
    stops = []

    for elem in root.iter():
        name = _localname(elem.tag)

        if name == "LineString":
            for child in elem:
                if _localname(child.tag) == "coordinates" and child.text:
                    pts = _parse_coords(child.text)
                    if len(pts) >= 2:
                        segments.append(pts)

        elif name == "Placemark":
            stop_name = None
            point = None
            for child in elem.iter():
                cname = _localname(child.tag)
                if cname == "name" and child.text and stop_name is None:
                    stop_name = child.text.strip()
                elif cname == "Point":
                    for pc in child:
                        if _localname(pc.tag) == "coordinates" and pc.text:
                            coords = _parse_coords(pc.text)
                            if coords:
                                point = coords[0]
            if point:
                stops.append({"name": stop_name or "", "lon": point[0], "lat": point[1]})

    # Bounds across all path vertices (fall back to stops if no segments).
    all_points = [pt for seg in segments for pt in seg]
    if not all_points:
        all_points = [[s["lon"], s["lat"]] for s in stops]
    bounds = None
    if all_points:
        lons = [p[0] for p in all_points]
        lats = [p[1] for p in all_points]
        bounds = {
            "minLon": min(lons),
            "minLat": min(lats),
            "maxLon": max(lons),
            "maxLat": max(lats),
        }

    return {"segments": segments, "stops": stops, "bounds": bounds}


def parse_geojson_geometry(path):
    """Extract LineString drive paths from a GeoJSON file (no named stops)."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    segments = []

    def add_line(coords):
        pts = []
        for c in coords or []:
            if isinstance(c, (list, tuple)) and len(c) >= 2:
                try:
                    pts.append([float(c[0]), float(c[1])])
                except (TypeError, ValueError):
                    continue
        if len(pts) >= 2:
            segments.append(pts)

    def handle_geom(geom):
        if not isinstance(geom, dict):
            return
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if gtype == "LineString":
            add_line(coords)
        elif gtype == "MultiLineString":
            for line in coords or []:
                add_line(line)
        elif gtype == "GeometryCollection":
            for g in geom.get("geometries", []):
                handle_geom(g)

    if isinstance(data, dict) and data.get("type") == "FeatureCollection":
        for feat in data.get("features", []):
            handle_geom((feat or {}).get("geometry"))
    elif isinstance(data, dict) and data.get("type") == "Feature":
        handle_geom(data.get("geometry"))
    elif isinstance(data, dict):
        handle_geom(data)  # bare geometry

    all_points = [pt for seg in segments for pt in seg]
    bounds = None
    if all_points:
        lons = [p[0] for p in all_points]
        lats = [p[1] for p in all_points]
        bounds = {
            "minLon": min(lons),
            "minLat": min(lats),
            "maxLon": max(lons),
            "maxLat": max(lats),
        }

    return {"segments": segments, "stops": [], "bounds": bounds}


# --- Editing: canonical geometry helpers -------------------------------------
def _bounds(segments, stops):
    """Bounding box over all path vertices (falling back to stop points)."""
    pts = [p for seg in segments for p in seg]
    if not pts:
        pts = [[s["lon"], s["lat"]] for s in stops]
    if not pts:
        return None
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return {"minLon": min(lons), "minLat": min(lats),
            "maxLon": max(lons), "maxLat": max(lats)}


def _validate_geometry(payload):
    """Validate an edit payload. Returns (geometry_dict, error_str)."""
    if not isinstance(payload, dict):
        return None, "body must be a JSON object"
    segments_in = payload.get("segments", [])
    stops_in = payload.get("stops", [])
    if not isinstance(segments_in, list) or not isinstance(stops_in, list):
        return None, "segments and stops must be arrays"

    def num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    segments = []
    total = 0
    for seg in segments_in:
        if not isinstance(seg, list) or len(seg) < 2:
            return None, "each segment needs at least 2 points"
        pts = []
        for c in seg:
            if (not isinstance(c, (list, tuple)) or len(c) < 2
                    or not num(c[0]) or not num(c[1])):
                return None, "coordinates must be [lon, lat] numbers"
            lon, lat = float(c[0]), float(c[1])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                return None, "coordinates out of range"
            pts.append([round(lon, 7), round(lat, 7)])
        total += len(pts)
        segments.append(pts)

    if not segments:
        return None, "a route needs at least one segment"
    if total > 100000:
        return None, "too many vertices"

    stops = []
    for s in stops_in:
        if not isinstance(s, dict) or not num(s.get("lon")) or not num(s.get("lat")):
            return None, "each stop needs numeric lon/lat"
        lon, lat = float(s["lon"]), float(s["lat"])
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return None, "stop coordinates out of range"
        name = s.get("name", "")
        if not isinstance(name, str):
            return None, "stop name must be a string"
        stop = {"name": name[:200], "lon": round(lon, 7), "lat": round(lat, 7)}
        code = s.get("code", "")
        if not isinstance(code, str):
            return None, "stop code must be a string"
        if code.strip():  # public stop number (GTFS stop_code)
            stop["code"] = code.strip()[:30]
        stops.append(stop)

    label = payload.get("label")
    if label is not None and not isinstance(label, str):
        return None, "label must be a string"

    name = payload.get("name")
    if name is not None and not isinstance(name, str):
        return None, "name must be a string"

    geom = {"segments": segments, "stops": stops}
    if name and name.strip():
        geom["name"] = name.strip()[:200]
    return geom, None


def geometry_to_kml(geom, name):
    """Synthesize minimal KML from canonical geometry (re-readable by our parser)."""
    title = geom.get("name") or name or ""
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
        f"<name>{_xml_escape(title)}</name>",
    ]
    for seg in geom.get("segments", []):
        coords = " ".join(f"{lon},{lat},0" for lon, lat in seg)
        parts.append(
            f"<Placemark><LineString><coordinates>{coords}</coordinates>"
            "</LineString></Placemark>"
        )
    for s in geom.get("stops", []):
        parts.append(
            f"<Placemark><name>{_xml_escape(s.get('name') or '')}</name>"
            f"<Point><coordinates>{s['lon']},{s['lat']},0</coordinates>"
            "</Point></Placemark>"
        )
    parts.append("</Document></kml>")
    return "".join(parts)


def geometry_to_geojson(geom):
    """Synthesize a path-only GeoJSON FeatureCollection (one LineString per segment)."""
    features = [
        {
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "LineString",
                "coordinates": [[lon, lat] for lon, lat in seg],
            },
        }
        for seg in geom.get("segments", [])
    ]
    return {"type": "FeatureCollection", "features": features}


# --- GTFS export -------------------------------------------------------------
# "Points - *" KML layers are marker overlays (feeder stops, mosques, proposed
# interchanges), not bus services with a drive path — excluded from the feed.
_GTFS_SKIP = re.compile(r"^points\s*-", re.IGNORECASE)


def _gtfs_route_meta(filename):
    """(route_id, short_name, long_name) from a KML filename.
    Pulls a leading route code (e.g. 'Muara 01' -> '01') into short_name."""
    stem = os.path.splitext(os.path.basename(filename))[0]
    route_id = re.sub(r"\s+", "-", stem.strip())
    m = re.search(r"(\d+[A-Za-z]?)\s*$", stem)
    short = m.group(1) if m else ""
    return route_id, short, stem


def gather_gtfs_routes(year):
    """Collect this year's KML routes as gtfs.build_feed inputs, preferring an
    edited geometry from the DB over the shipped file. Skips marker-only layers
    and routes with no stops (a frequency-based feed needs stops to time).
    Per-route GTFS metadata saved via the editor (names, color, schedule)
    overrides the derived defaults."""
    rp = os.path.join(app.static_folder, "data", year, "routes.json")
    if not os.path.exists(rp):
        return []
    with open(rp, "r") as f:
        filenames = json.load(f)

    meta_by_file = db.all_gtfs_meta(year)
    routes = []

    def add(filename, geom):
        if not geom or len(geom.get("stops") or []) < 2:
            return  # a valid trip needs at least 2 stops to time against
        route_id, short, long_name = _gtfs_route_meta(filename)
        meta = meta_by_file.get(filename, {})
        routes.append({
            "route_id": route_id,
            "short_name": meta.get("short_name") or short,
            "long_name": meta.get("long_name") or geom.get("name") or long_name,
            "color": meta.get("color", ""),
            "agency_id": meta.get("agency_id", ""),
            "direction": meta.get("direction", ""),
            "headsign": meta.get("headsign", ""),
            "return_headsign": meta.get("return_headsign", ""),
            "desc": meta.get("desc", ""),
            "hail": bool(meta.get("hail")),
            "schedules": meta.get("schedules")
                or ([meta["schedule"]] if meta.get("schedule") else None),
            "segments": geom.get("segments", []),
            "stops": geom.get("stops", []),
        })

    for filename in filenames:
        if _GTFS_SKIP.match(os.path.basename(filename)):
            continue
        geom = db.latest_geometry(year, filename)
        if geom is None:
            path = _find_kml(filename, year)
            if not path:
                continue
            try:
                geom = parse_route_geometry(path)
            except (ValueError, ET.ParseError):
                continue
        add(filename, geom)

    # User-created routes (DB-only, no shipped file) belong in the feed too —
    # the workbench flow is draw -> schedule -> export.
    user_files = sorted(
        f for f in db.distinct_files(year)
        if not _find_kml(f, year) and not _find_geojson(f, year)
    )
    for filename in user_files:
        add(filename, db.latest_geometry(year, filename))
    return routes


_TIME_RE = re.compile(r"^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$")


def _norm_time(t):
    """Normalize 'H:MM[:SS]' to 'HH:MM:SS', or None if invalid. GTFS allows
    hours past 24 for service spanning midnight."""
    m = _TIME_RE.match((t or "").strip())
    if not m:
        return None
    h, mi, s = int(m.group(1)), m.group(2), m.group(3) or "00"
    if h > 47:
        return None
    return f"{h:02d}:{mi}:{s}"


def _validate_gtfs_route_meta(payload):
    """Validate a per-route GTFS metadata payload. Returns (meta, error)."""
    if not isinstance(payload, dict):
        return None, "meta must be a JSON object"
    meta = {}
    for field in ("short_name", "long_name"):
        v = payload.get(field)
        if v is not None:
            if not isinstance(v, str):
                return None, f"{field} must be a string"
            if v.strip():
                meta[field] = v.strip()[:200]
    color = payload.get("color")
    if color:
        if not isinstance(color, str) or not re.fullmatch(
            r"#?[0-9A-Fa-f]{6}", color.strip()
        ):
            return None, "color must be a 6-digit hex value"
        meta["color"] = color.strip().lstrip("#").upper()
    agency_id = payload.get("agency_id")
    if agency_id:
        if not isinstance(agency_id, str):
            return None, "agency_id must be a string"
        if agency_id.strip():
            meta["agency_id"] = agency_id.strip()[:30]
    direction = payload.get("direction")
    if direction:
        if direction != "outback":
            return None, "direction must be 'outback' or omitted (loop/one-way)"
        meta["direction"] = "outback"
    for field in ("headsign", "return_headsign"):
        v = payload.get(field)
        if v is not None:
            if not isinstance(v, str):
                return None, f"{field} must be a string"
            if v.strip():
                meta[field] = v.strip()[:120]
    desc = payload.get("desc")
    if desc is not None:
        if not isinstance(desc, str):
            return None, "desc must be a string"
        if desc.strip():
            meta["desc"] = desc.strip()[:500]
    if payload.get("hail"):
        meta["hail"] = True  # hail & ride: continuous pickup/drop-off
    # Schedules: a list of day-type blocks (weekday/weekend…). The legacy
    # single `schedule` key is accepted as one block.
    sched_in = payload.get("schedule")
    if sched_in:
        sched, err = _validate_schedule_block(sched_in)
        if err:
            return None, err
        if sched:
            meta["schedule"] = sched
    scheds_in = payload.get("schedules")
    if scheds_in is not None:
        if not isinstance(scheds_in, list) or len(scheds_in) > 7:
            return None, "schedules must be a list of blocks (max 7)"
        blocks = []
        for b in scheds_in:
            sched, err = _validate_schedule_block(b)
            if err:
                return None, err
            if sched:
                blocks.append(sched)
        if blocks:
            meta["schedules"] = blocks
    return meta, None


def _validate_schedule_block(sched_in):
    """Validate one schedule block. Returns (sched_dict, error)."""
    if not isinstance(sched_in, dict):
        return None, "schedule must be an object"
    sched = {}
    hw = sched_in.get("headway_secs")
    if hw is not None:
        if not isinstance(hw, (int, float)) or isinstance(hw, bool) \
                or not (60 <= hw <= 24 * 3600):
            return None, "headway_secs must be 60..86400"
        sched["headway_secs"] = int(hw)
    for field in ("start_time", "end_time"):
        v = sched_in.get(field)
        if v:
            t = _norm_time(v)
            if t is None:
                return None, f"{field} must be HH:MM or HH:MM:SS"
            sched[field] = t
    # Time-of-day frequency bands (peak/off-peak): each becomes its own
    # frequencies.txt row. The legacy top-level fields above act as band one.
    bands_in = sched_in.get("bands")
    if bands_in is not None:
        if not isinstance(bands_in, list) or len(bands_in) > 10:
            return None, "bands must be a list (max 10)"
        bands = []
        for b in bands_in:
            if not isinstance(b, dict):
                return None, "each band must be an object"
            band = {}
            bh = b.get("headway_secs")
            if bh is not None:
                if not isinstance(bh, (int, float)) or isinstance(bh, bool) \
                        or not (60 <= bh <= 24 * 3600):
                    return None, "band headway_secs must be 60..86400"
                band["headway_secs"] = int(bh)
            for field in ("start_time", "end_time"):
                v = b.get(field)
                if v:
                    t = _norm_time(v)
                    if t is None:
                        return None, f"band {field} must be HH:MM or HH:MM:SS"
                    band[field] = t
            if band:
                bands.append(band)
        if bands:
            sched["bands"] = bands
    days = sched_in.get("days")
    if days is not None:
        if (not isinstance(days, list) or len(days) != 7
                or any(d not in (0, 1, True, False) for d in days)):
            return None, "days must be 7 values of 0/1"
        sched["days"] = [int(bool(d)) for d in days]
    # Exact departure times transcribed from the timing signboard. When
    # present the export emits one real trip per departure for this route
    # instead of a synthetic frequency entry.
    for field in ("departures", "return_departures"):
        deps = sched_in.get(field)
        if deps is not None:
            if not isinstance(deps, list) or len(deps) > 300:
                return None, f"{field} must be a list of times (max 300)"
            norm = []
            for d in deps:
                t = _norm_time(d) if isinstance(d, str) else None
                if t is None:
                    return None, f"bad departure time: {str(d)[:20]!r}"
                norm.append(t)
            if norm:
                sched[field] = sorted(set(norm))
    run = sched_in.get("run_secs")
    if run is not None:
        if not isinstance(run, (int, float)) or isinstance(run, bool) \
                or not (60 <= run <= 6 * 3600):
            return None, "run_secs must be 60..21600"
        sched["run_secs"] = int(run)
    return sched, None


def _validate_gtfs_feed_config(payload):
    """Validate feed-level config (operators + fare). Returns (config, error)."""
    if not isinstance(payload, dict):
        return None, "config must be a JSON object"
    config = {}
    # Operators: a list of agencies; the first is the default for routes
    # without an explicit assignment.
    agencies_in = payload.get("agencies")
    if agencies_in is not None:
        if not isinstance(agencies_in, list) or len(agencies_in) > 20:
            return None, "agencies must be a list (max 20)"
        agencies = []
        seen = set()
        for a in agencies_in:
            if not isinstance(a, dict):
                return None, "each operator must be an object"
            name = a.get("name")
            if not isinstance(name, str) or not name.strip():
                continue  # blank rows are dropped silently
            name = name.strip()[:200]
            aid = a.get("id")
            if aid is not None and not isinstance(aid, str):
                return None, "operator id must be a string"
            aid = (aid or "").strip()[:30]
            if not aid:
                aid = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").upper()[:30] or "OP"
            if aid in seen:
                return None, f"duplicate operator id: {aid}"
            seen.add(aid)
            entry = {"id": aid, "name": name}
            for field in ("url", "phone", "email"):
                v = a.get(field)
                if v is not None:
                    if not isinstance(v, str):
                        return None, f"operator {field} must be a string"
                    if v.strip():
                        entry[field] = v.strip()[:300]
            agencies.append(entry)
        if agencies:
            config["agencies"] = agencies
    agency_in = payload.get("agency")
    if agency_in:
        if not isinstance(agency_in, dict):
            return None, "agency must be an object"
        agency = {}
        for field in ("name", "url", "phone", "email"):
            v = agency_in.get(field)
            if v is not None:
                if not isinstance(v, str):
                    return None, f"agency.{field} must be a string"
                if v.strip():
                    agency[field] = v.strip()[:300]
        if agency:
            config["agency"] = agency
    # Holiday exceptions -> calendar_dates.txt.
    holidays_in = payload.get("holidays")
    if holidays_in is not None:
        if not isinstance(holidays_in, list) or len(holidays_in) > 50:
            return None, "holidays must be a list (max 50)"
        holidays = []
        for h in holidays_in:
            if not isinstance(h, dict):
                return None, "each holiday must be an object"
            date = h.get("date", "")
            if not isinstance(date, str):
                return None, "holiday date must be a string"
            date = date.replace("-", "").strip()
            try:
                datetime.datetime.strptime(date, "%Y%m%d")
            except ValueError:
                return None, f"bad holiday date: {date[:12]!r}"
            mode = h.get("mode", "none")
            if mode not in ("none", "sunday"):
                return None, "holiday mode must be 'none' or 'sunday'"
            entry = {"date": date, "mode": mode}
            name = h.get("name")
            if name is not None:
                if not isinstance(name, str):
                    return None, "holiday name must be a string"
                if name.strip():
                    entry["name"] = name.strip()[:100]
            holidays.append(entry)
        if holidays:
            config["holidays"] = sorted(holidays, key=lambda x: x["date"])
    fare_in = payload.get("fare")
    if fare_in:
        if not isinstance(fare_in, dict):
            return None, "fare must be an object"
        fare = {}
        price = fare_in.get("price")
        if price is not None and price != "":
            try:
                price = float(price)
            except (TypeError, ValueError):
                return None, "fare.price must be a number"
            if not (0 <= price <= 1000):
                return None, "fare.price out of range"
            fare["price"] = price
        currency = fare_in.get("currency")
        if currency:
            if not isinstance(currency, str) or not re.fullmatch(
                r"[A-Za-z]{3}", currency.strip()
            ):
                return None, "fare.currency must be a 3-letter code"
            fare["currency"] = currency.strip().upper()
        if fare:
            config["fare"] = fare
    return config, None


# --- Hiring: freelance field data-collection applications --------------------
# Districts of Brunei a collector can cover, and how they get around. Kept as
# closed sets so the public form can't store arbitrary values.
APPLICATION_DISTRICTS = ("Brunei-Muara", "Tutong", "Belait", "Temburong")
APPLICATION_TRANSPORT = ("Own vehicle", "Motorcycle", "Public transport", "Other")
# Admin review workflow stages for a submitted application.
APPLICATION_STATUSES = ("New", "Reviewing", "Contacted", "Accepted", "Rejected")


def _validate_application(form):
    """Validate a /join application. `form` has name, contact, districts (list),
    transport, availability, experience, message. Returns (fields, error) where
    fields is ready for db.add_application (districts joined to a string)."""
    name = (form.get("name") or "").strip()
    if not name:
        return None, "Please enter your name."
    contact = (form.get("contact") or "").strip()
    if not contact:
        return None, "Please enter an email or phone number so we can reach you."

    districts_in = form.get("districts") or []
    if isinstance(districts_in, str):
        districts_in = [districts_in]
    districts = [d for d in districts_in if d in APPLICATION_DISTRICTS]
    if len(districts) != len(districts_in):
        return None, "Unknown district selected."

    transport = (form.get("transport") or "").strip()
    if transport and transport not in APPLICATION_TRANSPORT:
        return None, "Unknown transport option."

    fields = {
        "name": name[:120],
        "contact": contact[:200],
        "districts": ", ".join(districts),
        "transport": transport[:40],
        "availability": (form.get("availability") or "").strip()[:300],
        "experience": (form.get("experience") or "").strip()[:1000],
        "message": (form.get("message") or "").strip()[:2000],
    }
    return fields, None


@app.route("/join")
def join_page():
    # Public hiring page for freelance field data collectors.
    return render_template(
        "join.html", submitted=False, error=None, form={},
        districts=APPLICATION_DISTRICTS, transport_options=APPLICATION_TRANSPORT,
    )


@app.route("/join", methods=["POST"])
@ratelimit.rate_limited(limits=[(5, 60), (20, 3600)], scope="apply")
def join_apply():
    # Plain form POST (public, unauthenticated contact form — no privileged
    # session action, so the editor's JSON/CSRF baseline doesn't apply here).
    form = {
        "name": request.form.get("name", ""),
        "contact": request.form.get("contact", ""),
        "districts": request.form.getlist("districts"),
        "transport": request.form.get("transport", ""),
        "availability": request.form.get("availability", ""),
        "experience": request.form.get("experience", ""),
        "message": request.form.get("message", ""),
    }
    fields, err = _validate_application(form)
    if err:
        return render_template(
            "join.html", submitted=False, error=err, form=form,
            districts=APPLICATION_DISTRICTS, transport_options=APPLICATION_TRANSPORT,
        ), 400
    db.add_application(fields)
    return render_template(
        "join.html", submitted=True, error=None, form={},
        districts=APPLICATION_DISTRICTS, transport_options=APPLICATION_TRANSPORT,
    )


@app.route("/applications")
@auth.admin_required()
def applications_page():
    # Admin view of submitted applications (newest first).
    return render_template(
        "applications.html",
        applications=db.list_applications(),
        statuses=APPLICATION_STATUSES,
    )


@app.route("/applications/<int:app_id>", methods=["POST"])
@auth.admin_required(api=True)
@ratelimit.rate_limited()
def update_application(app_id):
    # Update an application's review status and/or admin note.
    payload = request.get_json(silent=True) or {}
    updated = False
    if "status" in payload:
        status = payload.get("status")
        if status not in APPLICATION_STATUSES:
            return jsonify({"error": "unknown status"}), 400
        if not db.set_application_status(app_id, status):
            return jsonify({"error": "application not found"}), 404
        updated = True
    if "note" in payload:
        note = payload.get("note", "")
        if not isinstance(note, str):
            return jsonify({"error": "note must be a string"}), 400
        if not db.set_application_note(app_id, note[:2000]):
            return jsonify({"error": "application not found"}), 404
        updated = True
    if not updated:
        return jsonify({"error": "nothing to update"}), 400
    return jsonify({"ok": True})


@app.route("/applications/<int:app_id>", methods=["DELETE"])
@auth.admin_required(api=True)
@ratelimit.rate_limited()
def remove_application(app_id):
    if not db.delete_application(app_id):
        return jsonify({"error": "application not found"}), 404
    return jsonify({"ok": True})


@app.route("/applications.csv")
@auth.admin_required()
def applications_csv():
    # Download all applications as CSV (authed page download).
    cols = ("id", "created_at", "name", "contact", "districts", "transport",
            "availability", "experience", "message", "status", "admin_note")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for a in db.list_applications():
        writer.writerow([a.get(c, "") for c in cols])
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": 'attachment; filename="applications.csv"'},
    )


@app.route("/data/gtfs-meta")
def get_gtfs_meta():
    """Per-route GTFS metadata overrides (names, color, schedule)."""
    year = _resolve_year(request.args.get("year"))
    route = (request.args.get("route") or "").strip()[:200]
    if not route or route.startswith("_"):
        return jsonify({"error": "route required"}), 400
    return jsonify({"year": year, "route": route,
                    "meta": db.get_gtfs_meta(year, route)})


@app.route("/data/gtfs-meta", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def save_gtfs_meta():
    payload = request.get_json(silent=True) or {}
    year = _resolve_year(payload.get("year"))
    route = (payload.get("route") or "").strip()[:200]
    if not route or route.startswith("_"):
        return jsonify({"error": "route required"}), 400
    meta, err = _validate_gtfs_route_meta(payload.get("meta"))
    if err:
        return jsonify({"error": err}), 400
    saved = db.set_gtfs_meta(year, route, meta)
    return jsonify({"ok": True, "year": year, "route": route, "meta": saved})


@app.route("/data/gtfs-meta-summary")
def gtfs_meta_summary():
    """Per-route transcription status for the workbench list badges:
    {filename: {schedule, departures, operator, headsign}} for every route
    with saved GTFS metadata."""
    year = _resolve_year(request.args.get("year"))
    out = {}
    for key, m in db.all_gtfs_meta(year).items():
        if key.startswith("_"):
            continue
        blocks = m.get("schedules") or ([m["schedule"]] if m.get("schedule") else [])
        out[key] = {
            "schedule": bool(blocks),
            "departures": any(
                b.get("departures") or b.get("return_departures") for b in blocks
            ),
            "operator": bool(m.get("agency_id")),
            "headsign": bool(m.get("headsign")),
        }
    return jsonify({"year": year, "routes": out})


@app.route("/data/gtfs-config")
def get_gtfs_config():
    """Feed-level GTFS settings (operators + fare), the resolved operator list
    (saved or default — what the export will actually use), and the built-in
    defaults so the editor can show placeholders."""
    year = _resolve_year(request.args.get("year"))
    return jsonify({
        "year": year,
        "config": db.get_gtfs_meta(year, "_feed"),
        "agencies": [
            {"id": a["id"], "name": a["name"], "url": a.get("url", ""),
             "phone": a.get("phone", "")}
            for a in resolved_agencies(year)
        ],
        "defaults": {
            "agency": {"name": GTFS_AGENCY["name"], "url": GTFS_AGENCY["url"],
                       "phone": GTFS_AGENCY["phone"], "email": GTFS_AGENCY["email"]},
            "headway_secs": GTFS_PARAMS["headway_secs"],
            "start_time": GTFS_PARAMS["start_time"],
            "end_time": GTFS_PARAMS["end_time"],
        },
    })


@app.route("/data/gtfs-config", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def save_gtfs_config():
    payload = request.get_json(silent=True) or {}
    year = _resolve_year(payload.get("year"))
    config, err = _validate_gtfs_feed_config(payload.get("config"))
    if err:
        return jsonify({"error": err}), 400
    saved = db.set_gtfs_meta(year, "_feed", config)
    return jsonify({"ok": True, "year": year, "config": saved})


def _timing_images_dir(year):
    return os.path.join(DOCS_DIR, year, "images", "timings")


@app.route("/data/timing-images")
def timing_images():
    """Official JPD timing signboard photos, grouped by year (newest first).
    Shown beside the GTFS schedule form so real times can be transcribed."""
    out = {}
    years = []
    if os.path.isdir(DOCS_DIR):
        year_dirs = (n for n in os.listdir(DOCS_DIR) if re.fullmatch(r"\d{4}", n))
        for y in sorted(year_dirs, reverse=True):
            d = _timing_images_dir(y)
            if not os.path.isdir(d):
                continue
            imgs = sorted(
                f for f in os.listdir(d)
                if f.lower().endswith((".jpg", ".jpeg", ".png"))
            )
            if not imgs:
                continue
            years.append(y)
            # Route code is the leading token: '01 seri timing.jpg' -> '01',
            # '20 time details [20160402].jpg' -> '20'.
            out[y] = [
                {"file": f, "route": os.path.splitext(f)[0].split()[0]}
                for f in imgs
            ]
    return jsonify({"years": years, "images": out})


@app.route("/data/timing-image/<year>/<path:filename>")
def timing_image(year, filename):
    if not re.fullmatch(r"\d{4}", year or ""):
        return "Timing image not found", 404
    if os.path.isabs(filename) or ".." in filename.replace("\\", "/").split("/"):
        return "Timing image not found", 404
    path = os.path.join(_timing_images_dir(year), filename)
    if not os.path.isfile(path):
        return "Timing image not found", 404
    return send_from_directory(os.path.dirname(path), os.path.basename(path))


def resolved_agencies(year):
    """The year's operator list for the feed, ready for gtfs.build_feed.
    Saved operators (config.agencies) win; else the legacy single-agency
    override; else the built-in default. First entry = default operator."""
    config = db.get_gtfs_meta(year, "_feed")
    saved = config.get("agencies")
    if saved:
        return [
            {
                "id": a.get("id") or "AGENCY",
                "name": a.get("name") or GTFS_AGENCY["name"],
                # agency_url is required by the GTFS spec — fall back rather
                # than emit a blank.
                "url": a.get("url") or GTFS_AGENCY["url"],
                "timezone": GTFS_AGENCY["timezone"],
                "lang": GTFS_AGENCY["lang"],
                "phone": a.get("phone", ""),
                "email": a.get("email", ""),
            }
            for a in saved
        ]
    agency = dict(GTFS_AGENCY)
    for field in ("name", "url", "phone", "email"):
        v = (config.get("agency") or {}).get(field)
        if v:
            agency[field] = v
    return [agency]


def gtfs_feed_inputs(year):
    """(routes, agencies, params) for gtfs.build_feed, with the year's saved
    feed-level settings (operators, fare) merged over the built-in defaults.
    Shared by the /data/gtfs.zip endpoint and scripts/build_gtfs.py."""
    routes = gather_gtfs_routes(year)
    config = db.get_gtfs_meta(year, "_feed")
    # Version stamps the export date so consumers can tell feeds apart.
    today = datetime.date.today().strftime("%Y%m%d")
    params = dict(GTFS_PARAMS, feed_version=f"{year}.{today}")
    if config.get("fare"):
        params["fare"] = config["fare"]
    if config.get("holidays"):
        params["holidays"] = config["holidays"]
    return routes, resolved_agencies(year), params


# The built GTFS feed is deterministic per year + edits, so cache the bytes
# (keyed by the same change stamp the planner uses) instead of rebuilding it on
# every export / validate / preview / planner-network call — each rebuild is
# ~0.8s of CPU, so this both speeds things up and removes a spam-able hotspot.
_FEED_CACHE = {}  # year -> (db change stamp, data bytes, stats)


def _build_feed_cached(year):
    """Build or reuse the year's GTFS feed. Returns (data, stats), or
    (None, None) when the year has no exportable routes."""
    stamp = db.change_stamp(year)
    cached = _FEED_CACHE.get(year)
    if cached and cached[0] == stamp:
        return cached[1], cached[2]
    routes, agencies, params = gtfs_feed_inputs(year)
    if not routes:
        return None, None
    data, stats = gtfs.build_feed(routes, agencies, params)
    _FEED_CACHE[year] = (stamp, data, stats)
    return data, stats


# Per-IP tiers for the compute-heavy GET endpoints — a separate bucket from the
# write limits, generous for humans but a backstop against scripted spam.
READ_LIMITS = [(60, 10), (300, 60)]


@app.route("/data/gtfs-validate")
@auth.login_required(api=True)
@ratelimit.rate_limited(limits=READ_LIMITS, scope="read")
def gtfs_validate():
    """Build the year's feed in memory and run the structural validator."""
    year = _resolve_year(request.args.get("year"))
    data, stats = _build_feed_cached(year)
    if data is None:
        return jsonify({"error": "no routes to export"}), 404
    findings = gtfs.validate_feed(data)
    errors = sum(1 for f in findings if f["severity"] == "error")
    return jsonify({
        "year": year,
        "size": len(data),
        "stats": stats,
        "errors": errors,
        "warnings": len(findings) - errors,
        "findings": findings,
    })


# Preview payloads stay bounded: stop_times.txt alone can run to tens of
# thousands of rows, which would bloat the JSON and stall the browser table.
GTFS_PREVIEW_MAX_ROWS = 500


@app.route("/data/gtfs-preview")
@auth.login_required(api=True)
@ratelimit.rate_limited(limits=READ_LIMITS, scope="read")
def gtfs_preview():
    """Build the year's feed in memory and return every file's parsed contents,
    so the workbench can show the data exactly as the export will emit it."""
    year = _resolve_year(request.args.get("year"))
    data, stats = _build_feed_cached(year)
    if data is None:
        return jsonify({"error": "no routes to export"}), 404
    files = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            text = zf.read(name).decode("utf-8-sig")
            rows = list(csv.reader(io.StringIO(text)))
            header = rows[0] if rows else []
            body = rows[1:]
            files.append({
                "name": name,
                "header": header,
                "rows": body[:GTFS_PREVIEW_MAX_ROWS],
                "total_rows": len(body),
                "truncated": len(body) > GTFS_PREVIEW_MAX_ROWS,
                "size": zf.getinfo(name).file_size,
            })
    return jsonify({"year": year, "size": len(data), "stats": stats, "files": files})


@app.route("/data/gtfs.zip")
@ratelimit.rate_limited(limits=READ_LIMITS, scope="read")
def gtfs_feed():
    # On-demand GTFS feed for the year, reflecting DB edits (via gather) and
    # any feed-level settings saved through the GTFS editor. Public download, so
    # rate-limited (and cached) rather than auth-gated.
    year = _resolve_year(request.args.get("year"))
    data, _stats = _build_feed_cached(year)
    if data is None:
        return jsonify({"error": "no routes to export"}), 404
    return Response(
        data,
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="brunei-gtfs-{year}.zip"'},
    )


# --- Trip planner --------------------------------------------------------------
# The RAPTOR network is built from the same in-memory GTFS feed the export
# emits, then cached per year until that year's edits change.
_PLANNER_CACHE = {}  # year -> (db change stamp, planner.Network)


def _planner_network(year):
    stamp = db.change_stamp(year)
    cached = _PLANNER_CACHE.get(year)
    if cached and cached[0] == stamp:
        return cached[1]
    data, _stats = _build_feed_cached(year)
    if data is None:
        return None
    net = planner.Network(data)
    _PLANNER_CACHE[year] = (stamp, net)
    return net


@app.route("/planner")
def planner_page():
    # Old URL kept for bookmarks and ride-exit links; the planner is now "/".
    return redirect(url_for("index"))


@app.route("/data/planner-stops")
def planner_stops():
    """All stops in the year's plannable network, for the search boxes."""
    year = _resolve_year(request.args.get("year"))
    net = _planner_network(year)
    return jsonify({"year": year, "stops": net.stop_list() if net else []})


@app.route("/data/plan")
@ratelimit.rate_limited(limits=READ_LIMITS, scope="read")
def plan_trip():
    """Point-to-point journeys: ?from=lon,lat&to=lon,lat&time=HH:MM&day=0..6."""
    year = _resolve_year(request.args.get("year"))

    def point(name):
        parts = (request.args.get(name) or "").split(",")
        if len(parts) != 2:
            return None
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            return None
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return None
        return (lon, lat)

    origin, dest = point("from"), point("to")
    if not origin or not dest:
        return jsonify({"error": "from and to must be 'lon,lat'"}), 400
    # Time and day are optional filters. With neither, plan over the typical
    # service: a blank time uses a representative departure, and a blank/"any"
    # day skips weekday filtering (the feed is frequency-based and mostly daily).
    time_arg = (request.args.get("time") or "").strip()
    if time_arg:
        t = _norm_time(time_arg)
        if t is None:
            return jsonify({"error": "time must be HH:MM or HH:MM:SS"}), 400
        h, m, s = (int(x) for x in t.split(":"))
        dep_secs = h * 3600 + m * 60 + s
    else:
        dep_secs = 8 * 3600  # representative midday-ish departure for "any time"

    day_arg = (request.args.get("day") or "").strip().lower()
    if day_arg in ("", "any"):
        day = None
    else:
        try:
            day = int(day_arg)
        except ValueError:
            return jsonify({"error": "day must be 0..6 (Mon..Sun) or 'any'"}), 400
        if not (0 <= day <= 6):
            return jsonify({"error": "day must be 0..6 (Mon..Sun) or 'any'"}), 400

    net = _planner_network(year)
    if net is None:
        return jsonify({"error": "this source has no routes with stops to plan over"}), 404
    result = net.plan(origin, dest, dep_secs, day)
    if not time_arg or day is None:
        result.setdefault("notes", []).append(
            "Typical journey for any time/day — set a depart time or day to filter."
        )
    result["year"] = year
    return jsonify(result)


@app.route("/login")
def login_page():
    # One login form for both gates (editor + admin). Already in? Skip through.
    if auth.is_authed() or auth.is_admin():
        return redirect(auth.safe_next(request.args.get("next")) or url_for("gtfs_page"))
    return render_template("login.html", next=request.args.get("next", ""), error=False)


@app.route("/login", methods=["POST"])
@ratelimit.rate_limited(limits=[(5, 60), (20, 3600)], scope="login")
def login_submit():
    # Tight rate tiers above slow password brute-forcing. The single password
    # field accepts either the editor or the admin password (distinct secrets),
    # setting whichever session flag matches.
    password = request.form.get("password")
    is_editor = auth.check_password(password)
    is_admin = auth.check_admin_password(password)
    if is_editor or is_admin:
        session.permanent = True
        if is_editor:
            session["authed"] = True
        if is_admin:
            session["admin"] = True
        # Send admins to where they were headed (e.g. /applications); the editor
        # default remains the workbench.
        default = url_for("applications_page") if is_admin and not is_editor \
            else url_for("gtfs_page")
        return redirect(auth.safe_next(request.form.get("next")) or default)
    return render_template(
        "login.html", next=request.form.get("next", ""), error=True
    ), 401


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/auth/status")
def auth_status():
    # Lets the frontend decide whether to show editor controls.
    return jsonify({"authed": auth.is_authed()})


@app.route("/")
def index():
    # The trip planner is the homepage.
    return render_template("planner.html")


@app.route("/map")
def map_page():
    # The route map (formerly the homepage). Editor controls are gated by auth.
    return render_template(
        "index.html", authed=auth.is_authed(), auth_configured=auth.configured()
    )


@app.route("/gtfs")
@auth.login_required()
def gtfs_page():
    # Dedicated GTFS workbench: route list + geometry editor + schedule forms.
    return render_template("gtfs.html")


@app.route("/gtfs/guide")
def gtfs_guide_page():
    # Data-entry guide for transcription personnel.
    return render_template("gtfs_guide.html")


@app.route("/ride/three")
def ride_three():
    return render_template("ride_three.html")


@app.route("/ride/maplibre")
def ride_maplibre():
    return render_template("ride_maplibre.html")


@app.route("/data/years")
def get_years():
    # Available dataset years + the default, for the client's year picker.
    years = _available_years() or [DATA_YEAR]
    default = DATA_YEAR if DATA_YEAR in years else years[0]
    return jsonify({"years": years, "default": default})


@app.route("/data/catalog")
def catalog():
    # Everything the sidebar/ride need, for ALL years at once: shipped routes,
    # geojson paths, user-created routes, and custom names — grouped by year.
    years = _available_years() or [DATA_YEAR]
    out = {"years": years}
    for y in years:
        rp = os.path.join(app.static_folder, "data", y, "routes.json")
        kml = []
        if os.path.exists(rp):
            with open(rp, "r") as f:
                kml = json.load(f)
        gd = os.path.join(app.static_folder, "data", y, "geojson")
        geojson = (
            sorted(f for f in os.listdir(gd) if f.lower().endswith(".geojson"))
            if os.path.isdir(gd)
            else []
        )
        user = sorted(
            f
            for f in db.distinct_files(y)
            if not _find_kml(f, y) and not _find_geojson(f, y)
        )
        out[y] = {
            "routes": kml,
            "geojson": geojson,
            "user": user,
            "names": db.latest_names(y),
        }
    return jsonify(out)


@app.route("/data/routes.json")
def get_routes():
    # Read and return the chosen year's routes.json directly as JSON.
    year = _resolve_year(request.args.get("year"))
    routes_path = os.path.join(app.static_folder, "data", year, "routes.json")
    with open(routes_path, "r") as f:
        return json.load(f)


@app.route("/data/route-geometry/<path:filename>")
def route_geometry(filename):
    # Drive segments, named stops, bounds. Serves an edited version from the DB
    # when one exists (unless ?original=1); ?version=N fetches a saved version.
    # Falls back to the on-disk file, dispatched by extension.
    year = _resolve_year(request.args.get("year"))
    is_geojson = filename.lower().endswith(".geojson")
    finder = _find_geojson if is_geojson else _find_kml
    path = finder(filename, year)

    version = request.args.get("version")
    geom = None
    ver = None
    if version is not None:
        try:
            geom = db.get_version(year, filename, int(version))
        except ValueError:
            return jsonify({"error": "bad version"}), 400
        if geom is None:
            return jsonify({"error": "version not found"}), 404
        ver = int(version)
    elif not request.args.get("original"):
        geom = db.latest_geometry(year, filename)
        if geom is not None:
            ver = db.latest_version(year, filename)

    # User-created routes have no shipped file — they exist only in the DB.
    if geom is None and not path:
        return jsonify({"error": "Route not found"}), 404

    if geom is not None:
        data = {
            "segments": geom["segments"],
            "stops": geom.get("stops", []),
            "bounds": _bounds(geom["segments"], geom.get("stops", [])),
            "edited": True,
            "version": ver,
        }
    else:
        path = finder(filename, year)
        try:
            data = parse_geojson_geometry(path) if is_geojson else parse_route_geometry(path)
        except (ValueError, ET.ParseError) as e:
            return jsonify({"error": f"Failed to parse: {e}"}), 500
        data["edited"] = False
        data["version"] = None
    default_name = os.path.splitext(os.path.basename(filename))[0]
    data["name"] = (geom.get("name") if geom else None) or default_name
    return jsonify(data)


@app.route("/data/kml/<path:filename>")
def serve_kml(filename):
    year = _resolve_year(request.args.get("year"))
    path = _find_kml(filename, year)
    if not request.args.get("original"):
        geom = db.latest_geometry(year, filename)
        if geom is not None:  # includes user-created (file-less) routes
            name = os.path.splitext(os.path.basename(filename))[0]
            return Response(
                geometry_to_kml(geom, name),
                mimetype="application/vnd.google-earth.kml+xml",
            )
    if not path:
        return "KML file not found", 404
    # Strip <Icon> refs (e.g. Google gstatic stock markers): we never render KML
    # icons (styles are off client-side), and those external URLs lack CORS
    # headers, producing console errors. The file on disk is untouched.
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = re.sub(r"<Icon>.*?</Icon>", "", f.read(), flags=re.DOTALL)
    return Response(text, mimetype="application/vnd.google-earth.kml+xml")


@app.route("/data/geojson-list")
def get_geojson_list():
    # Filenames of the chosen year's GeoJSON path files (may be empty).
    year = _resolve_year(request.args.get("year"))
    d = os.path.join(app.static_folder, "data", year, "geojson")
    files = []
    if os.path.isdir(d):
        files = sorted(f for f in os.listdir(d) if f.lower().endswith(".geojson"))
    return jsonify(files)


@app.route("/data/geojson/<path:filename>")
def serve_geojson(filename):
    year = _resolve_year(request.args.get("year"))
    path = _find_geojson(filename, year)
    if not path:
        return "GeoJSON file not found", 404
    if not request.args.get("original"):
        geom = db.latest_geometry(year, filename)
        if geom is not None:
            return jsonify(geometry_to_geojson(geom))
    return send_from_directory(os.path.dirname(path), os.path.basename(path))


@app.route("/data/stop-images")
def stop_images():
    """Official JPD stop-list signboard images, grouped by year (newest first).
    Used by the in-app reference panel while drawing/placing stops."""
    out = {}
    years = []
    if os.path.isdir(DOCS_DIR):
        year_dirs = (n for n in os.listdir(DOCS_DIR) if re.fullmatch(r"\d{4}", n))
        for y in sorted(year_dirs, reverse=True):
            d = _stop_images_dir(y)
            if not os.path.isdir(d):
                continue
            imgs = sorted(
                f for f in os.listdir(d)
                if f.lower().endswith((".jpg", ".jpeg", ".png"))
            )
            if not imgs:
                continue
            years.append(y)
            out[y] = [{"file": f, "route": _route_from_image(f)} for f in imgs]
    return jsonify({"years": years, "images": out})


@app.route("/data/stop-image/<year>/<path:filename>")
def stop_image(year, filename):
    path = _find_stop_image(year, filename)
    if not path:
        return "Stop image not found", 404
    return send_from_directory(os.path.dirname(path), os.path.basename(path))


@app.route("/data/route-note")
def get_route_note():
    """Free-text triage note for a route, keyed by (year, route)."""
    year = _resolve_year(request.args.get("year"))
    route = (request.args.get("route") or "").strip()[:120]
    if not route:
        return jsonify({"error": "route required"}), 400
    return jsonify({"year": year, "route": route, "note": db.get_note(year, route)})


@app.route("/data/route-note", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def save_route_note():
    payload = request.get_json(silent=True) or {}
    year = _resolve_year(payload.get("year"))
    route = (payload.get("route") or "").strip()[:120]
    note = payload.get("note", "")
    if not route:
        return jsonify({"error": "route required"}), 400
    if not isinstance(note, str):
        return jsonify({"error": "note must be a string"}), 400
    saved = db.set_note(year, route, note[:10000])
    return jsonify({"ok": True, "year": year, "route": route, "note": saved})


@app.route("/data/edit/<path:filename>", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def save_edit(filename):
    # Save a new edited version of a route's geometry into the SQLite store.
    year = _resolve_year(request.args.get("year"))
    is_geojson = filename.lower().endswith(".geojson")
    finder = _find_geojson if is_geojson else _find_kml
    # Shipped routes are read-only — they can only be copied into a user route.
    # Editing is allowed only for user-created (DB-only, no shipped file) routes.
    if finder(filename, year):
        return jsonify(
            {"error": "shipped routes are read-only; copy it to your routes to edit"}
        ), 403
    if db.latest_version(year, filename) is None:
        return jsonify({"error": "Route not found"}), 404
    payload = request.get_json(silent=True)
    geom, err = _validate_geometry(payload)
    if err:
        return jsonify({"error": err}), 400
    if is_geojson:
        geom["stops"] = []  # geojson routes are path-only
    label = payload.get("label") if isinstance(payload, dict) else None
    version = db.add_version(year, filename, geom, label)
    return jsonify({"version": version}), 201


@app.route("/data/edit-history/<path:filename>")
def edit_history(filename):
    year = _resolve_year(request.args.get("year"))
    return jsonify(db.list_versions(year, filename))


@app.route("/data/edit-names")
def edit_names():
    # Custom route names for the year (filename -> name) for the sidebar legend.
    year = _resolve_year(request.args.get("year"))
    return jsonify(db.latest_names(year))


@app.route("/data/user-routes")
def user_routes():
    # Filenames of user-created routes (DB-only, no shipped file) for the year.
    year = _resolve_year(request.args.get("year"))
    out = [
        f
        for f in db.distinct_files(year)
        if not _find_kml(f, year) and not _find_geojson(f, year)
    ]
    return jsonify(sorted(out))


@app.route("/data/create", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def create_route():
    # Create a brand-new (file-less) route — allowed only for USER_ROUTE_YEAR.
    year = _resolve_year(request.args.get("year"))
    if year != USER_ROUTE_YEAR:
        return jsonify(
            {"error": f"new routes can only be created for {USER_ROUTE_YEAR}"}
        ), 403
    payload = request.get_json(silent=True)
    geom, err = _validate_geometry(payload)
    if err:
        return jsonify({"error": err}), 400
    # Allocate the next free user-<N>.kml filename.
    nxt = 0
    for f in db.distinct_files(year):
        m = re.match(r"^user-(\d+)\.kml$", f)
        if m:
            nxt = max(nxt, int(m.group(1)))
    filename = f"user-{nxt + 1}.kml"
    label = payload.get("label") if isinstance(payload, dict) else None
    version = db.add_version(year, filename, geom, label)
    return jsonify({"filename": filename, "version": version}), 201


@app.route("/data/edit/<path:filename>", methods=["DELETE"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def delete_edit(filename):
    # Revert to original: drop all saved versions so serving falls back to disk.
    year = _resolve_year(request.args.get("year"))
    deleted = db.delete_all(year, filename)
    return jsonify({"reverted": True, "deleted": deleted})


@app.route("/data/edit/<path:filename>/restore", methods=["POST"])
@auth.login_required(api=True)
@ratelimit.rate_limited()
def restore_edit(filename):
    # Append a copy of version N as a new latest version (history stays forward).
    year = _resolve_year(request.args.get("year"))
    version = request.args.get("version")
    try:
        geom = db.get_version(year, filename, int(version))
    except (TypeError, ValueError):
        return jsonify({"error": "bad version"}), 400
    if geom is None:
        return jsonify({"error": "version not found"}), 404
    new_version = db.add_version(year, filename, geom, f"Restored from v{int(version)}")
    return jsonify({"version": new_version}), 201


@app.route("/data/ride-music")
def ride_music():
    # Background tracks for the ride-along: any audio dropped into static/audio.
    # An optional credits.json (filename -> {title, artist, source, license})
    # supplies the attribution line shown while a track plays (required for the
    # CC-BY tracks we use).
    d = os.path.join(app.static_folder, "audio")
    exts = (".mp3", ".ogg", ".m4a", ".wav")
    files = (
        sorted(f for f in os.listdir(d) if f.lower().endswith(exts))
        if os.path.isdir(d)
        else []
    )
    credits = {}
    cpath = os.path.join(d, "credits.json")
    if os.path.exists(cpath):
        try:
            with open(cpath, "r", encoding="utf-8") as fh:
                credits = json.load(fh)
        except (ValueError, OSError):
            credits = {}
    return jsonify(
        [
            {"src": url_for("static", filename=f"audio/{f}"), "credit": credits.get(f)}
            for f in files
        ]
    )


@app.route("/favicon.png")
def favicon():
    return send_from_directory(app.static_folder, "favicon.png", mimetype="image/png")


if __name__ == "__main__":
    # PORT is honoured for parity with hosts that inject it (Replit etc.); the
    # dev server is for local use — production runs under gunicorn (see .replit).
    port = int(os.environ.get("PORT", 8000))
    app.run(debug=True, host="0.0.0.0", port=port)
