"""Build a GTFS feed (a zip of CSV tables) from canonical route geometry.

Pure stdlib and framework-agnostic: the caller supplies already-parsed routes
(the same {segments, stops} shape that app.parse_route_geometry returns), an
agency dict, and feed-wide params. We emit an in-memory zip.

The Brunei data has real geometry and named, ordered stops but NO timetables,
so the schedule is synthetic and FREQUENCY-BASED: each route gets one
representative trip with stop times interpolated along its shape, plus a
frequencies.txt row giving a nominal headway over a service window. Replace the
placeholder headways with real values (e.g. transcribed from the JPD timing
signboards) when they're known.
"""
import csv
import io
import math
import re
import zipfile

# Stops from different routes that name the same physical stop are merged into
# one stop_id when their names match (normalized) and they sit within this many
# metres of each other. Tunable: too large merges distinct nearby stops, too
# small leaves duplicates.
STOP_MERGE_RADIUS_M = 40.0

# GTFS files we emit, in a stable order (zip listing reads sensibly).
_FILE_ORDER = [
    "agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
    "shapes.txt", "frequencies.txt", "calendar.txt", "feed_info.txt",
]


# --- geometry helpers --------------------------------------------------------
def _haversine(a, b):
    """Great-circle distance in metres between [lon, lat] points a and b."""
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371000.0 * math.asin(min(1.0, math.sqrt(h)))


def _flatten_segments(segments):
    """Concatenate drive-path segments into one ordered list of [lon, lat],
    dropping a point that exactly repeats the previous one across the seam."""
    pts = []
    for seg in segments:
        for p in seg:
            if pts and pts[-1][0] == p[0] and pts[-1][1] == p[1]:
                continue
            pts.append([p[0], p[1]])
    return pts


def _cumulative_dist(points):
    """Cumulative haversine distance (metres) at each vertex; [0.0] for one point."""
    out = [0.0]
    for i in range(1, len(points)):
        out.append(out[-1] + _haversine(points[i - 1], points[i]))
    return out


def _project_dist(stop, points, cum):
    """Distance along the shape (metres) of the vertex nearest to `stop`."""
    best_i, best_d = 0, float("inf")
    sp = [stop["lon"], stop["lat"]]
    for i, p in enumerate(points):
        d = _haversine(sp, p)
        if d < best_d:
            best_i, best_d = i, d
    return cum[best_i]


def _secs_to_hhmmss(s):
    """Seconds since midnight -> 'HH:MM:SS' (GTFS allows hours >= 24)."""
    s = int(round(s))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


# --- stop dedup --------------------------------------------------------------
def _norm_name(name):
    return re.sub(r"\s+", " ", (name or "").strip()).upper()


class _StopPool:
    """Assigns stable stop_ids, merging same-name stops within a radius."""

    def __init__(self):
        # Each entry keeps numeric lon/lat (for proximity tests) alongside the
        # output fields; rows() formats coords at the end.
        self._entries = []         # [{stop_id, name, lon, lat}]
        self._by_name = {}         # normalized name -> list of indexes
        self.merges = 0

    def resolve(self, stop):
        """Return a stop_id for `stop` ({name, lon, lat}), merging when possible."""
        key = _norm_name(stop.get("name"))
        sp = [stop["lon"], stop["lat"]]
        if key:  # named stops merge by name + proximity
            for idx in self._by_name.get(key, []):
                ex = self._entries[idx]
                if _haversine(sp, [ex["lon"], ex["lat"]]) <= STOP_MERGE_RADIUS_M:
                    self.merges += 1
                    return ex["stop_id"]
        stop_id = f"S{len(self._entries) + 1:04d}"
        self._entries.append({
            "stop_id": stop_id,
            "name": stop.get("name") or stop_id,
            "lon": stop["lon"],
            "lat": stop["lat"],
        })
        if key:
            self._by_name.setdefault(key, []).append(len(self._entries) - 1)
        return stop_id

    def rows(self):
        """stops.txt rows with coords formatted to 6 decimals."""
        return [{
            "stop_id": e["stop_id"],
            "stop_name": e["name"],
            "stop_lat": f"{e['lat']:.6f}",
            "stop_lon": f"{e['lon']:.6f}",
        } for e in self._entries]


# --- csv / zip helpers -------------------------------------------------------
def _csv(header, rows):
    """Render rows (list of dicts) as a CSV string with the given header order."""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


# --- feed builder ------------------------------------------------------------
def build_feed(routes, agency, params):
    """Build a GTFS feed and return it as zip bytes.

    routes: [{route_id, short_name, long_name, segments, stops}]
    agency: {id, name, url, phone, timezone, lang, email?}
    params: {headway_secs, start_time, end_time, service_id, days[7],
             start_date, end_date, feed_version, publisher_name, publisher_url,
             feed_lang}
    """
    agency_id = agency["id"]
    service_id = params["service_id"]
    headway = int(params["headway_secs"])

    # Service window as seconds since midnight; trip stop_times span it from 0.
    def _hhmmss_to_secs(t):
        h, m, s = (int(x) for x in t.split(":"))
        return h * 3600 + m * 60 + s

    win_start = _hhmmss_to_secs(params["start_time"])

    pool = _StopPool()
    routes_rows, trips_rows, shapes_rows, stop_times_rows, freq_rows = [], [], [], [], []

    for r in routes:
        rid = r["route_id"]
        shape_id = f"shp_{rid}"
        trip_id = f"trip_{rid}"

        points = _flatten_segments(r.get("segments", []))
        cum = _cumulative_dist(points)
        total = cum[-1] if cum else 0.0

        routes_rows.append({
            "route_id": rid,
            "agency_id": agency_id,
            "route_short_name": r.get("short_name", "") or "",
            "route_long_name": r.get("long_name", "") or "",
            "route_type": 3,  # 3 = bus
        })

        for i, p in enumerate(points):
            shapes_rows.append({
                "shape_id": shape_id,
                "shape_pt_lon": f"{p[0]:.6f}",
                "shape_pt_lat": f"{p[1]:.6f}",
                "shape_pt_sequence": i,
                "shape_dist_traveled": f"{cum[i]:.1f}",
            })

        has_shape = len(points) >= 2
        trips_rows.append({
            "route_id": rid,
            "service_id": service_id,
            "trip_id": trip_id,
            "shape_id": shape_id if has_shape else "",
        })

        # Stop times: project each stop onto the shape, then map its distance to
        # a time proportional to the service window. Enforce monotonic times so
        # the trip is valid even when projection order wobbles.
        stops = r.get("stops", [])
        run = headway  # nominal end-to-end run time for one trip = one headway
        prev_secs = None
        seq = 0
        for s in stops:
            sid = pool.resolve(s)
            if has_shape and total > 0:
                frac = _project_dist(s, points, cum) / total
            else:
                frac = (seq / (len(stops) - 1)) if len(stops) > 1 else 0.0
            t = win_start + frac * run
            if prev_secs is not None and t <= prev_secs:
                t = prev_secs + 1
            prev_secs = t
            seq += 1
            hhmm = _secs_to_hhmmss(t)
            stop_times_rows.append({
                "trip_id": trip_id,
                "arrival_time": hhmm,
                "departure_time": hhmm,
                "stop_id": sid,
                "stop_sequence": seq,
                "shape_dist_traveled": f"{frac * total:.1f}" if has_shape else "",
            })

        freq_rows.append({
            "trip_id": trip_id,
            "start_time": params["start_time"],
            "end_time": params["end_time"],
            "headway_secs": headway,
            "exact_times": 0,
        })

    days = params["days"]
    calendar_rows = [{
        "service_id": service_id,
        "monday": days[0], "tuesday": days[1], "wednesday": days[2],
        "thursday": days[3], "friday": days[4], "saturday": days[5],
        "sunday": days[6],
        "start_date": params["start_date"],
        "end_date": params["end_date"],
    }]

    agency_rows = [{
        "agency_id": agency_id,
        "agency_name": agency["name"],
        "agency_url": agency["url"],
        "agency_timezone": agency["timezone"],
        "agency_lang": agency.get("lang", ""),
        "agency_phone": agency.get("phone", ""),
        "agency_email": agency.get("email", ""),
    }]

    feed_info_rows = [{
        "feed_publisher_name": params["publisher_name"],
        "feed_publisher_url": params["publisher_url"],
        "feed_lang": params["feed_lang"],
        "feed_version": params["feed_version"],
    }]

    tables = {
        "agency.txt": _csv(
            ["agency_id", "agency_name", "agency_url", "agency_timezone",
             "agency_lang", "agency_phone", "agency_email"], agency_rows),
        "stops.txt": _csv(
            ["stop_id", "stop_name", "stop_lat", "stop_lon"], pool.rows()),
        "routes.txt": _csv(
            ["route_id", "agency_id", "route_short_name", "route_long_name",
             "route_type"], routes_rows),
        "trips.txt": _csv(
            ["route_id", "service_id", "trip_id", "shape_id"], trips_rows),
        "stop_times.txt": _csv(
            ["trip_id", "arrival_time", "departure_time", "stop_id",
             "stop_sequence", "shape_dist_traveled"], stop_times_rows),
        "shapes.txt": _csv(
            ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence",
             "shape_dist_traveled"], shapes_rows),
        "frequencies.txt": _csv(
            ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"],
            freq_rows),
        "calendar.txt": _csv(
            ["service_id", "monday", "tuesday", "wednesday", "thursday",
             "friday", "saturday", "sunday", "start_date", "end_date"],
            calendar_rows),
        "feed_info.txt": _csv(
            ["feed_publisher_name", "feed_publisher_url", "feed_lang",
             "feed_version"], feed_info_rows),
    }

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in _FILE_ORDER:
            zf.writestr(name, tables[name])

    return out.getvalue(), {
        "routes": len(routes_rows),
        "stops": len(pool._entries),
        "stop_times": len(stop_times_rows),
        "shape_points": len(shapes_rows),
        "merged_stops": pool.merges,
    }
