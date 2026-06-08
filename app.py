from flask import (
    Flask, render_template, send_from_directory, jsonify, json, request, Response,
    url_for,
)
import os
import re
import math
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _xml_escape

import db

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

# The route data is segregated by year so new datasets live alongside the repo
# owner's original 2016 set (under sibling folders, e.g. data/2026). DATA_YEAR is
# the default; clients may request a specific year via the ?year= query param.
DATA_YEAR = "2016"

# Users may create brand-new routes only for this dataset year. New routes have
# no shipped file — they live entirely in the edits DB.
USER_ROUTE_YEAR = "2026"

# Route edits live in a SQLite DB under Flask's instance folder (gitignored), so
# the shipped route files are never modified. Init at import time so it runs
# under both `flask run` and `python app.py`.
os.makedirs(app.instance_path, exist_ok=True)
db.init_db(os.path.join(app.instance_path, "edits.db"))


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
        stops.append({"name": name[:200], "lon": round(lon, 7), "lat": round(lat, 7)})

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


@app.route("/")
def index():
    return render_template("index.html")


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
def delete_edit(filename):
    # Revert to original: drop all saved versions so serving falls back to disk.
    year = _resolve_year(request.args.get("year"))
    deleted = db.delete_all(year, filename)
    return jsonify({"reverted": True, "deleted": deleted})


@app.route("/data/edit/<path:filename>/restore", methods=["POST"])
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
    app.run(debug=True, host="0.0.0.0", port=8000)
