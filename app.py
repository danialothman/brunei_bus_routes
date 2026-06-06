from flask import Flask, render_template, send_from_directory, jsonify, json, request
import os
import re
import xml.etree.ElementTree as ET

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


@app.route("/data/routes.json")
def get_routes():
    # Read and return the chosen year's routes.json directly as JSON.
    year = _resolve_year(request.args.get("year"))
    routes_path = os.path.join(app.static_folder, "data", year, "routes.json")
    with open(routes_path, "r") as f:
        return json.load(f)


@app.route("/data/route-geometry/<path:filename>")
def route_geometry(filename):
    # Parse a route's KML into JSON (drive segments, named stops, bounds).
    path = _find_kml(filename, request.args.get("year"))
    if not path:
        return jsonify({"error": "Route not found"}), 404
    try:
        data = parse_route_geometry(path)
    except ET.ParseError as e:
        return jsonify({"error": f"Failed to parse KML: {e}"}), 500
    data["name"] = os.path.splitext(os.path.basename(filename))[0]
    return jsonify(data)


@app.route("/data/kml/<path:filename>")
def serve_kml(filename):
    path = _find_kml(filename, request.args.get("year"))
    if path:
        return send_from_directory(os.path.dirname(path), os.path.basename(path))
    return "KML file not found", 404


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
    path = _find_geojson(filename, request.args.get("year"))
    if path:
        return send_from_directory(os.path.dirname(path), os.path.basename(path))
    return "GeoJSON file not found", 404


@app.route("/favicon.png")
def favicon():
    return send_from_directory(app.static_folder, "favicon.png", mimetype="image/png")


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=8000)
