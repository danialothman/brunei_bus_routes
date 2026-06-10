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
# fare_attributes.txt is only present when a fare is configured.
_FILE_ORDER = [
    "agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
    "shapes.txt", "frequencies.txt", "calendar.txt", "fare_attributes.txt",
    "feed_info.txt",
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


def _project_stops(stops, points, cum):
    """Distance along the shape (metres) for each stop, in stop order.

    Stops are listed in travel order in the source KML, so the search moves
    monotonically forward through the shape — and among near-equal candidates
    the EARLIEST vertex wins. Both guards matter for loop routes, where the
    terminal appears at the start and the end of the shape: a plain global
    nearest-vertex search can snap every stop to the closing vertices,
    collapsing all stop times at the end of the trip."""
    dists = []
    start = 0
    for s in stops:
        sp = [s["lon"], s["lat"]]
        best_i, best_d = start, float("inf")
        for i in range(start, len(points)):
            d = _haversine(sp, points[i])
            if d < best_d:
                best_i, best_d = i, d
        for i in range(start, best_i):  # earliest within tolerance wins
            if _haversine(sp, points[i]) <= best_d + 25.0:
                best_i = i
                break
        dists.append(cum[best_i])
        start = best_i
    return dists


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
        """Return a stop_id for `stop` ({name, lon, lat, code?}), merging when
        possible. Stops with two DIFFERENT public codes never merge; a merge
        backfills a code the first occurrence lacked."""
        key = _norm_name(stop.get("name"))
        code = (stop.get("code") or "").strip()
        sp = [stop["lon"], stop["lat"]]
        if key:  # named stops merge by name + proximity
            for idx in self._by_name.get(key, []):
                ex = self._entries[idx]
                if code and ex["code"] and ex["code"] != code:
                    continue  # same name but distinct signed stops
                if _haversine(sp, [ex["lon"], ex["lat"]]) <= STOP_MERGE_RADIUS_M:
                    if code and not ex["code"]:
                        ex["code"] = code
                    self.merges += 1
                    return ex["stop_id"]
        stop_id = f"S{len(self._entries) + 1:04d}"
        self._entries.append({
            "stop_id": stop_id,
            "name": stop.get("name") or stop_id,
            "code": code,
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
            "stop_code": e["code"],
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
def _hhmmss_to_secs(t):
    h, m, s = (int(x) for x in t.split(":"))
    return h * 3600 + m * 60 + s


def build_feed(routes, agencies, params):
    """Build a GTFS feed and return it as zip bytes.

    routes: [{route_id, short_name, long_name, segments, stops, color?,
              agency_id?, direction?, headsign?, return_headsign?,
              schedules?, schedule?}]
             where schedules is a list of day-type blocks (weekday/weekend…),
             each overriding the feed defaults: {headway_secs?, start_time?,
              end_time?, days?[7], departures?: [HH:MM:SS, ...], run_secs?}.
             A legacy single `schedule` dict is treated as one block.
             direction="outback" additionally emits a return pattern
             (direction_id 1, reversed shape/stops, departures offset by one
             run time); anything else is a loop/one-way single pattern.
    agencies: list of {id, name, url, phone, timezone, lang, email?} —
              the FIRST is the default operator for unassigned routes.
              (A single dict is accepted for backward compatibility.)
    params: {headway_secs, start_time, end_time, service_id, days[7],
             start_date, end_date, feed_version, publisher_name, publisher_url,
             feed_lang, fare?: {price, currency}}

    Routes WITH transcribed departures get one real trip per departure time
    (pure schedule-based GTFS, no frequencies.txt entry). Routes without fall
    back to a single representative trip plus a frequency-based headway.
    Intermediate stop times are interpolated along the shape over the route's
    run time (run_secs if given, else estimated from shape length at ~18 km/h).
    """
    if isinstance(agencies, dict):
        agencies = [agencies]
    default_agency_id = agencies[0]["id"]
    known_agency_ids = {a["id"] for a in agencies}
    default_service_id = params["service_id"]
    default_days = list(params["days"])

    # Each distinct operating-days pattern becomes its own service_id; the
    # feed-default pattern keeps the default id (e.g. DAILY).
    services = {}  # tuple(days) -> service_id

    def _service_for(days):
        key = tuple(int(bool(d)) for d in days)
        if key not in services:
            if list(key) == default_days:
                services[key] = default_service_id
            else:
                services[key] = "SVC_" + "".join(str(d) for d in key)
        return services[key]

    _service_for(default_days)  # always emit the default service

    pool = _StopPool()
    routes_rows, trips_rows, shapes_rows, stop_times_rows, freq_rows = [], [], [], [], []

    for r in routes:
        rid = r["route_id"]
        shape_id = f"shp_{rid}"

        points = _flatten_segments(r.get("segments", []))
        cum = _cumulative_dist(points)
        total = cum[-1] if cum else 0.0
        has_shape = len(points) >= 2

        # Per-route operator; unknown/unset assignments fall back to the default.
        aid = r.get("agency_id")
        if aid not in known_agency_ids:
            aid = default_agency_id
        routes_rows.append({
            "route_id": rid,
            "agency_id": aid,
            "route_short_name": r.get("short_name", "") or "",
            "route_long_name": r.get("long_name", "") or "",
            "route_type": 3,  # 3 = bus
            "route_color": (r.get("color") or "").lstrip("#").upper(),
        })

        # Project each stop onto the shape once; every trip reuses the offsets.
        # Times are spread over the first->last stop span (not the full shape),
        # so a trip departs its first stop exactly at the departure time.
        stops = r.get("stops", [])
        n = len(stops)
        if has_shape and total > 0 and stops:
            dists = _project_stops(stops, points, cum)
        else:
            dists = [0.0] * n
        span = (dists[-1] - dists[0]) if n > 1 else 0.0
        stop_entries = []  # (stop_id, time fraction 0..1, dist along shape)
        for idx, (s, dist) in enumerate(zip(stops, dists)):
            if span > 0:
                frac = (dist - dists[0]) / span
            else:
                frac = (idx / (n - 1)) if n > 1 else 0.0
            stop_entries.append((pool.resolve(s), frac, dist))

        # Direction patterns. Loop/one-way routes have a single pattern.
        # Out-and-back routes additionally get a return pattern (direction_id
        # 1): reversed shape and reversed stop order.
        patterns = [{
            "suffix": "",
            "shape_id": shape_id,
            "points": points,
            "cum": cum,
            "direction_id": 0,
            "headsign": r.get("headsign", "") or "",
            "entries": stop_entries,
        }]
        if r.get("direction") == "outback":
            entries_r = [
                (sid, 1.0 - frac, total - dist)
                for sid, frac, dist in reversed(stop_entries)
            ]
            patterns.append({
                "suffix": "_r",
                "shape_id": f"{shape_id}_r",
                "points": points[::-1],
                "cum": [total - c for c in reversed(cum)],
                "direction_id": 1,
                "headsign": r.get("return_headsign", "") or "",
                "entries": entries_r,
            })

        for pat in patterns:
            for i, p in enumerate(pat["points"]):
                shapes_rows.append({
                    "shape_id": pat["shape_id"],
                    "shape_pt_lon": f"{p[0]:.6f}",
                    "shape_pt_lat": f"{p[1]:.6f}",
                    "shape_pt_sequence": i,
                    "shape_dist_traveled": f"{pat['cum'][i]:.1f}",
                })

        # Schedule blocks: day-type variants (e.g. weekday vs weekend), each
        # with its own days/headway/window/run/departures -> its own
        # service_id and trip set. A legacy single `schedule` is one block.
        blocks = r.get("schedules") or [r.get("schedule") or {}]
        for bi, sched in enumerate(blocks[:7]):
            headway = int(sched.get("headway_secs") or params["headway_secs"])
            start_time = sched.get("start_time") or params["start_time"]
            end_time = sched.get("end_time") or params["end_time"]
            days = sched.get("days") or default_days
            departures = sched.get("departures") or []
            service_id = _service_for(days)

            # End-to-end run time used to spread intermediate stop times:
            # explicit run_secs, else estimated from shape length at ~18 km/h
            # (5 m/s) city bus average, else one headway as a last resort.
            run = int(sched.get("run_secs") or 0)
            if run <= 0:
                run = int(total / 5.0) if total > 0 else headway

            bsuf = "" if bi == 0 else f"_b{bi + 1}"
            for pat in patterns:
                # The bus turns around at the far terminal, so the return
                # direction departs one run time after the outbound.
                offset = run if pat["direction_id"] else 0
                base = f"trip_{rid}{bsuf}{pat['suffix']}"

                # Transcribed departures -> one real trip each (no frequencies
                # entry). Otherwise one representative trip + a headway.
                if departures:
                    trip_starts = [
                        (f"{base}_{i + 1}", _hhmmss_to_secs(d) + offset)
                        for i, d in enumerate(departures)
                    ]
                else:
                    trip_starts = [(base, _hhmmss_to_secs(start_time) + offset)]

                for trip_id, dep_secs in trip_starts:
                    trips_rows.append({
                        "route_id": rid,
                        "service_id": service_id,
                        "trip_id": trip_id,
                        "trip_headsign": pat["headsign"],
                        "direction_id": pat["direction_id"],
                        "shape_id": pat["shape_id"] if has_shape else "",
                    })
                    # Monotonic times keep the trip valid even when projection wobbles.
                    prev_secs = None
                    for seq, (sid, frac, dist) in enumerate(pat["entries"], 1):
                        t = dep_secs + frac * run
                        if prev_secs is not None and t <= prev_secs:
                            t = prev_secs + 1
                        prev_secs = t
                        hhmm = _secs_to_hhmmss(t)
                        stop_times_rows.append({
                            "trip_id": trip_id,
                            "arrival_time": hhmm,
                            "departure_time": hhmm,
                            "stop_id": sid,
                            "stop_sequence": seq,
                            # Only the first stop of a transcribed-departure
                            # trip is an exact time; everything else here is
                            # interpolated (an estimate, per the spec).
                            "timepoint": 1 if (departures and seq == 1) else 0,
                            "shape_dist_traveled": f"{dist:.1f}" if has_shape else "",
                        })

                if not departures:
                    freq_rows.append({
                        "trip_id": base,
                        "start_time": start_time,
                        "end_time": end_time,
                        "headway_secs": headway,
                        "exact_times": 0,
                    })

    calendar_rows = [
        {
            "service_id": sid,
            "monday": key[0], "tuesday": key[1], "wednesday": key[2],
            "thursday": key[3], "friday": key[4], "saturday": key[5],
            "sunday": key[6],
            "start_date": params["start_date"],
            "end_date": params["end_date"],
        }
        for key, sid in sorted(services.items(), key=lambda kv: kv[1])
    ]

    agency_rows = [{
        "agency_id": a["id"],
        "agency_name": a["name"],
        "agency_url": a["url"],
        "agency_timezone": a["timezone"],
        "agency_lang": a.get("lang", ""),
        "agency_phone": a.get("phone", ""),
        "agency_email": a.get("email", ""),
    } for a in agencies]

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
            ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon"],
            pool.rows()),
        "routes.txt": _csv(
            ["route_id", "agency_id", "route_short_name", "route_long_name",
             "route_type", "route_color"], routes_rows),
        "trips.txt": _csv(
            ["route_id", "service_id", "trip_id", "trip_headsign",
             "direction_id", "shape_id"], trips_rows),
        "stop_times.txt": _csv(
            ["trip_id", "arrival_time", "departure_time", "stop_id",
             "stop_sequence", "timepoint", "shape_dist_traveled"],
            stop_times_rows),
        "shapes.txt": _csv(
            ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence",
             "shape_dist_traveled"], shapes_rows),
        "calendar.txt": _csv(
            ["service_id", "monday", "tuesday", "wednesday", "thursday",
             "friday", "saturday", "sunday", "start_date", "end_date"],
            calendar_rows),
        "feed_info.txt": _csv(
            ["feed_publisher_name", "feed_publisher_url", "feed_lang",
             "feed_version"], feed_info_rows),
    }

    # Only routes still on the synthetic headway need frequencies.txt; a fully
    # transcribed feed (every route has departures) is pure schedule-based.
    if freq_rows:
        tables["frequencies.txt"] = _csv(
            ["trip_id", "start_time", "end_time", "headway_secs", "exact_times"],
            freq_rows)

    # Optional flat fare (e.g. Brunei's B$1): payment on board, no transfers info.
    fare = params.get("fare") or {}
    if fare.get("price"):
        tables["fare_attributes.txt"] = _csv(
            ["fare_id", "price", "currency_type", "payment_method", "transfers"],
            [{
                "fare_id": "FLAT",
                "price": f"{float(fare['price']):.2f}",
                "currency_type": fare.get("currency", "BND"),
                "payment_method": 0,  # paid on board
                "transfers": "",      # unlimited / unknown
            }])

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in _FILE_ORDER:
            if name in tables:
                zf.writestr(name, tables[name])

    return out.getvalue(), {
        "routes": len(routes_rows),
        "trips": len(trips_rows),
        "scheduled_routes": len(routes_rows) - len(freq_rows),
        "stops": len(pool._entries),
        "stop_times": len(stop_times_rows),
        "shape_points": len(shapes_rows),
        "merged_stops": pool.merges,
    }
