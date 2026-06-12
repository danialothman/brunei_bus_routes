"""RAPTOR journey planner over the GTFS feed built by gtfs.py.

The Network loads the in-memory GTFS zip (the same bytes /data/gtfs.zip
serves) into a timetable and answers point-to-point queries with RAPTOR
(round-based: each round adds at most one more ride). Planning over the
feed itself — rather than the raw route files — means a journey the planner
returns is exactly what a GTFS consumer of the export would compute.

Frequency-based trips (routes without transcribed departures) are expanded
into explicit departures at their headway. Walking is planner-side and
geometry-derived: access/egress to nearby stops plus stop-to-stop transfer
paths, independent of the feed's transfers.txt.

Pure stdlib; no Flask imports.
"""
import csv
import heapq
import io
import zipfile
from bisect import bisect_left

from gtfs import _haversine

# Walking parameters.
WALK_SPEED = 1.2             # m/s — relaxed urban walking pace
ACCESS_RADIUS_M = 1000.0     # origin/destination -> stop
TRANSFER_RADIUS_M = 350.0    # stop -> stop direct hop between rides
TRANSFER_SLACK_S = 30        # buffer added to every walk between stops
TRANSFER_MAX_S = 900         # cap on a chained walk between rides (~15 min)
MAX_DIRECT_WALK_M = 2000.0   # offer a walk-only journey under this
MAX_ROUNDS = 5               # rides per journey (= 4 transfers)
SLICE_TOL_M = 250.0          # a ride leg's drawn line must end this close to its stops

_INF = float("inf")
_DAY_COLS = ("monday", "tuesday", "wednesday", "thursday", "friday",
             "saturday", "sunday")


def _secs(t):
    """'HH:MM:SS' -> seconds since midnight (GTFS allows hours >= 24)."""
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _walk_secs(dist_m):
    return int(dist_m / WALK_SPEED) + TRANSFER_SLACK_S


def _read(zf, name):
    if name not in zf.namelist():
        return []
    with zf.open(name) as fh:
        return list(csv.DictReader(io.TextIOWrapper(fh, "utf-8-sig")))


class Network:
    """A queryable timetable parsed from GTFS feed bytes."""

    def __init__(self, feed_bytes):
        zf = zipfile.ZipFile(io.BytesIO(feed_bytes))

        # --- stops ---------------------------------------------------------
        self.stops = []   # [{id, code, name, lat, lon}]
        idx = {}
        for s in _read(zf, "stops.txt"):
            idx[s["stop_id"]] = len(self.stops)
            self.stops.append({
                "id": s["stop_id"],
                "code": s.get("stop_code", ""),
                "name": s.get("stop_name", "") or s["stop_id"],
                "lat": float(s["stop_lat"]),
                "lon": float(s["stop_lon"]),
            })

        routes_info = {r["route_id"]: r for r in _read(zf, "routes.txt")}
        service_days = {
            c["service_id"]: tuple(int(c.get(d, "0") or 0) for d in _DAY_COLS)
            for c in _read(zf, "calendar.txt")
        }
        trips_info = {t["trip_id"]: t for t in _read(zf, "trips.txt")}

        st_by_trip = {}
        for st in _read(zf, "stop_times.txt"):
            st_by_trip.setdefault(st["trip_id"], []).append(st)
        for rows in st_by_trip.values():
            rows.sort(key=lambda r: int(r["stop_sequence"]))

        freq = {}  # trip_id -> [(start_secs, end_secs, headway_secs)]
        for f in _read(zf, "frequencies.txt"):
            freq.setdefault(f["trip_id"], []).append(
                (_secs(f["start_time"]), _secs(f["end_time"]),
                 int(f["headway_secs"])))

        # --- shapes (for drawing ride legs) ---------------------------------
        self.shapes = {}  # shape_id -> (points [[lon,lat]], cum dists [m])
        pts_by_shape = {}
        for row in _read(zf, "shapes.txt"):
            pts_by_shape.setdefault(row["shape_id"], []).append((
                int(row["shape_pt_sequence"]),
                float(row["shape_pt_lon"]), float(row["shape_pt_lat"]),
                float(row.get("shape_dist_traveled") or 0),
            ))
        for sid, pts in pts_by_shape.items():
            pts.sort()
            self.shapes[sid] = ([[p[1], p[2]] for p in pts],
                                [p[3] for p in pts])

        # --- patterns: trips grouped by identical stop sequence -------------
        # RAPTOR scans "routes" that never branch, so the unit here is the
        # pattern (route_id + direction + exact stop sequence), with its trips
        # sorted by departure. Frequency templates expand into one concrete
        # trip per headway departure.
        pattern_by_key = {}
        self.patterns = []  # [{stop_idxs, dists, shape_id, trips, route meta}]
        for trip_id, rows in st_by_trip.items():
            t = trips_info.get(trip_id)
            if not t:
                continue
            stop_idxs = [idx[r["stop_id"]] for r in rows if r["stop_id"] in idx]
            if len(stop_idxs) < 2:
                continue
            times = [(_secs(r["arrival_time"]), _secs(r["departure_time"]))
                     for r in rows]
            key = (t["route_id"], t.get("direction_id", ""), tuple(stop_idxs))
            if key not in pattern_by_key:
                info = routes_info.get(t["route_id"], {})
                dists = []
                for r in rows:
                    try:
                        dists.append(float(r.get("shape_dist_traveled") or 0))
                    except ValueError:
                        dists.append(0.0)
                pattern_by_key[key] = len(self.patterns)
                self.patterns.append({
                    "route_id": t["route_id"],
                    "short_name": info.get("route_short_name", ""),
                    "long_name": info.get("route_long_name", ""),
                    "color": info.get("route_color", ""),
                    "shape_id": t.get("shape_id", ""),
                    "stop_idxs": stop_idxs,
                    "dists": dists,
                    "trips": [],
                })
            pat = self.patterns[pattern_by_key[key]]

            days = service_days.get(t["service_id"], (1,) * 7)
            headsign = t.get("trip_headsign", "")
            base = times[0][1]
            if trip_id in freq:  # template trip: one departure per headway
                starts = []
                for ws, we, hw in freq[trip_id]:
                    x = ws
                    while x < we:
                        starts.append(x)
                        x += hw
            else:
                starts = [base]
            for s0 in starts:
                off = s0 - base
                pat["trips"].append({
                    "days": days,
                    "headsign": headsign,
                    "times": [(a + off, d + off) for a, d in times],
                })
        for pat in self.patterns:
            pat["trips"].sort(key=lambda tr: tr["times"][0][1])

        # stop -> [(pattern_idx, earliest position)] for the route-collection
        # step. Only the first position matters for starting a scan; later
        # occurrences (loop terminals) are reached by the scan itself.
        self.patterns_by_stop = [[] for _ in self.stops]
        for pi, pat in enumerate(self.patterns):
            seen = {}
            for pos, s in enumerate(pat["stop_idxs"]):
                if s not in seen:
                    seen[s] = pos
            for s, pos in seen.items():
                self.patterns_by_stop[s].append((pi, pos))

        # --- foot paths between nearby stops (grid-bucketed) ----------------
        direct = [[] for _ in self.stops]
        cell = TRANSFER_RADIUS_M / 111000.0
        grid = {}
        for i, s in enumerate(self.stops):
            grid.setdefault(
                (int(s["lat"] / cell), int(s["lon"] / cell)), []).append(i)
        self._grid = grid
        self._cell = cell
        for (gy, gx), idxs in grid.items():
            for i in idxs:
                a = self.stops[i]
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        for j in grid.get((gy + dy, gx + dx), []):
                            if j == i:
                                continue
                            b = self.stops[j]
                            d = _haversine([a["lon"], a["lat"]],
                                           [b["lon"], b["lat"]])
                            if d <= TRANSFER_RADIUS_M:
                                direct[i].append((j, _walk_secs(d)))

        # RAPTOR requires the footpath graph to be transitively closed, or it
        # misses journeys that chain short hops between rides. Close it with a
        # per-stop Dijkstra over the direct hops, capped at TRANSFER_MAX_S.
        self.foot = [self._foot_closure(direct, i) for i in range(len(self.stops))]

    # --- helpers -------------------------------------------------------------

    @staticmethod
    def _foot_closure(direct, src):
        """[(stop, walk secs)] reachable from src by chained hops within the
        cap — Dijkstra over the direct-hop graph (neighbourhoods are tiny)."""
        dist = {src: 0}
        heap = [(0, src)]
        while heap:
            d, i = heapq.heappop(heap)
            if d > dist.get(i, _INF):
                continue
            for j, w in direct[i]:
                nd = d + w
                if nd <= TRANSFER_MAX_S and nd < dist.get(j, _INF):
                    dist[j] = nd
                    heapq.heappush(heap, (nd, j))
        del dist[src]
        return sorted(dist.items())

    def stop_list(self):
        """All stops, for the client's search box."""
        return self.stops

    def _near(self, point, radius_m):
        """[(stop_idx, dist_m)] within radius of (lon, lat), via the grid."""
        lon, lat = point
        span = int(radius_m / TRANSFER_RADIUS_M) + 1
        gy, gx = int(lat / self._cell), int(lon / self._cell)
        out = []
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                for i in self._grid.get((gy + dy, gx + dx), []):
                    s = self.stops[i]
                    d = _haversine([lon, lat], [s["lon"], s["lat"]])
                    if d <= radius_m:
                        out.append((i, d))
        return out

    def _stop_dist(self, i, j):
        """Straight-line metres between two stops (for walk-leg display)."""
        a, b = self.stops[i], self.stops[j]
        return int(_haversine([a["lon"], a["lat"]], [b["lon"], b["lat"]]))

    def _stop_json(self, i, time=None):
        s = self.stops[i]
        out = {"id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"]}
        if s["code"]:
            out["code"] = s["code"]
        if time is not None:
            out["time"] = int(time)
        return out

    def _slice_shape(self, shape_id, d1, d2):
        """Shape points between two along-shape distances (metres), with
        interpolated endpoints. None when the shape can't be sliced."""
        sh = self.shapes.get(shape_id)
        if not sh or d2 <= d1:
            return None
        pts, cum = sh

        def at(d):
            i = bisect_left(cum, d)
            if i <= 0:
                return list(pts[0])
            if i >= len(pts):
                return list(pts[-1])
            seg = cum[i] - cum[i - 1]
            f = (d - cum[i - 1]) / seg if seg > 0 else 0.0
            return [pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]),
                    pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1])]

        lo = bisect_left(cum, d1)
        hi = bisect_left(cum, d2)
        return [at(d1)] + [list(p) for p in pts[lo:hi]] + [at(d2)]

    def _slice_ok(self, geom, bpt, apt):
        """A usable ride polyline starts near the board stop and ends near
        the alight stop."""
        return (geom is not None and len(geom) >= 2
                and _haversine(geom[0], bpt) <= SLICE_TOL_M
                and _haversine(geom[-1], apt) <= SLICE_TOL_M)

    def _reslice_by_stops(self, shape_id, bpt, apt):
        """Slice between the shape vertices nearest each stop, requiring the
        alight vertex to come after the board vertex (loop shapes pass a
        terminal twice). Recovery path for collapsed feed projections."""
        sh = self.shapes.get(shape_id)
        if not sh:
            return None
        pts, cum = sh
        bi = min(range(len(pts)), key=lambda i: _haversine(pts[i], bpt))
        if bi >= len(pts) - 1:
            return None
        ai = min(range(bi + 1, len(pts)), key=lambda i: _haversine(pts[i], apt))
        return self._slice_shape(shape_id, cum[bi], cum[ai])

    def _ride_geometry(self, pat, bpos, apos):
        """Polyline for a ride leg, anchored to its board/alight stops.

        The feed's stop->shape projections can collapse on loop routes (a
        monotonic snap that runs ahead of the stops), leaving a slice that
        ends kilometres from the alight stop. Validate the slice, re-derive
        it from the stops' own nearest shape vertices when it's off, and as
        a last resort draw stop-to-stop lines. Ends are pinned to the exact
        stop coordinates so consecutive journey legs always connect."""
        board = self.stops[pat["stop_idxs"][bpos]]
        alight = self.stops[pat["stop_idxs"][apos]]
        bpt = [board["lon"], board["lat"]]
        apt = [alight["lon"], alight["lat"]]

        geom = self._slice_shape(
            pat["shape_id"], pat["dists"][bpos], pat["dists"][apos])
        if not self._slice_ok(geom, bpt, apt):
            geom = self._reslice_by_stops(pat["shape_id"], bpt, apt)
        if not self._slice_ok(geom, bpt, apt):
            geom = [[self.stops[i]["lon"], self.stops[i]["lat"]]
                    for i in pat["stop_idxs"][bpos:apos + 1]]
        if geom[0] != bpt:
            geom.insert(0, bpt)
        if geom[-1] != apt:
            geom.append(apt)
        return geom

    # --- RAPTOR ----------------------------------------------------------------

    def plan(self, origin, dest, dep_secs, day, max_rounds=MAX_ROUNDS):
        """Journeys from origin to dest (both (lon, lat)) departing at/after
        dep_secs on weekday `day` (0=Mon..6=Sun). Returns a dict with the
        Pareto set over (arrival time, number of rides): one journey per ride
        count that arrives strictly earlier than using fewer rides."""
        access = [(i, d) for i, d in self._near(origin, ACCESS_RADIUS_M)]
        egress = {i: d for i, d in self._near(dest, ACCESS_RADIUS_M)}
        direct_m = _haversine(list(origin), list(dest))

        journeys = []
        if direct_m <= MAX_DIRECT_WALK_M:
            w = _walk_secs(direct_m)
            journeys.append(self._walk_only(origin, dest, dep_secs, w, direct_m))

        notes = []
        if not access:
            notes.append("no stops within walking distance of the start point")
        if not egress:
            notes.append("no stops within walking distance of the destination")
        if not access or not egress:
            return {"journeys": journeys, "notes": notes}

        n = len(self.stops)
        best = [_INF] * n            # best arrival over all rounds
        tau_prev = [_INF] * n        # arrival with <= k-1 rides
        parents = [dict()]           # per round: stop -> parent record
        marked = set()
        for i, dist in access:
            w = _walk_secs(dist)
            t = dep_secs + w
            if t < tau_prev[i]:
                tau_prev[i] = t
                best[i] = t
                parents[0][i] = ("origin", w, dist)
                marked.add(i)
        # One more walking hop from the access stops: the first boardable stop
        # may sit just past the access radius, reached via a stop within it.
        for i in list(marked):
            if parents[0][i][0] != "origin":
                continue
            for j, w in self.foot[i]:
                t = tau_prev[i] + w
                if t < tau_prev[j]:
                    tau_prev[j] = t
                    best[j] = t
                    parents[0][j] = ("walk", i, w)
                    marked.add(j)

        dest_best = journeys[0]["arrival"] if journeys else _INF
        arrivals = []  # (round k, alight stop idx) per improving round

        for k in range(1, max_rounds + 1):
            tau_k = list(tau_prev)
            parent_k = {}

            # Routes (patterns) touching a marked stop, with the scan start.
            queue = {}
            for s in marked:
                for pi, pos in self.patterns_by_stop[s]:
                    if pi not in queue or pos < queue[pi]:
                        queue[pi] = pos

            improved = set()
            for pi, pos0 in queue.items():
                pat = self.patterns[pi]
                sidx = pat["stop_idxs"]
                trips = pat["trips"]
                trip = None
                trip_i = -1
                bpos = -1
                for pos in range(pos0, len(sidx)):
                    s = sidx[pos]
                    if trip is not None:
                        arr = trip["times"][pos][0]
                        if arr < best[s]:
                            tau_k[s] = arr
                            best[s] = arr
                            parent_k[s] = ("ride", pi, trip_i, bpos, pos)
                            improved.add(s)
                    # Could we board an earlier trip here, having arrived
                    # with one ride fewer?
                    t_here = tau_prev[s]
                    if t_here < _INF and (
                        trip is None or t_here <= trip["times"][pos][1]
                    ):
                        for ti, tr in enumerate(trips):
                            if tr["days"][day] and tr["times"][pos][1] >= t_here:
                                if (trip is None
                                        or tr["times"][pos][1]
                                        < trip["times"][pos][1]):
                                    trip, trip_i, bpos = tr, ti, pos
                                break

            # One walking hop from each stop a ride just improved.
            for s in list(improved):
                for j, w in self.foot[s]:
                    t = tau_k[s] + w
                    if t < best[j] and t < tau_k[j]:
                        tau_k[j] = t
                        best[j] = t
                        parent_k[j] = ("walk", s, w)
                        improved.add(j)

            if not improved:
                break
            parents.append(parent_k)
            marked = improved
            tau_prev = tau_k

            # Did this round reach the destination earlier?
            round_best, round_stop = _INF, None
            for i, dist in egress.items():
                if tau_k[i] < _INF:
                    t = tau_k[i] + _walk_secs(dist)
                    if t < round_best:
                        round_best, round_stop = t, i
            if round_stop is not None and round_best < dest_best:
                dest_best = round_best
                arrivals.append((k, round_stop))

        for k, alight in arrivals:
            j = self._reconstruct(parents, k, alight, egress[alight],
                                  origin, dest)
            if j:
                journeys.append(j)

        journeys.sort(key=lambda j: (j["arrival"], j["transfers"]))
        return {"journeys": journeys, "notes": notes}

    def _walk_only(self, origin, dest, dep_secs, w, dist_m):
        return {
            "departure": int(dep_secs),
            "arrival": int(dep_secs + w),
            "duration": int(w),
            "transfers": 0,
            "walk_only": True,
            "legs": [{
                "type": "walk",
                "from": {"lat": origin[1], "lon": origin[0]},
                "to": {"lat": dest[1], "lon": dest[0]},
                "depart": int(dep_secs),
                "arrive": int(dep_secs + w),
                "dist_m": int(dist_m),
            }],
        }

    def _reconstruct(self, parents, k, alight, egress_dist, origin, dest):
        """Walk parent pointers back from `alight` at round `k` into legs."""
        raw = []
        s, kk = alight, k
        while True:
            while s not in parents[kk]:
                kk -= 1
                if kk < 0:
                    return None
            rec = parents[kk][s]
            if rec[0] == "origin":
                raw.append(("access", rec[1], rec[2], s))
                break
            if rec[0] == "walk":
                raw.append(("walk", rec[1], s, rec[2]))
                s = rec[1]
            else:  # ("ride", pattern, trip, board pos, alight pos)
                raw.append(rec)
                s = self.patterns[rec[1]]["stop_idxs"][rec[3]]
                kk -= 1
        raw.reverse()

        first_ride = next((i for i, r in enumerate(raw) if r[0] == "ride"), None)
        if first_ride is None:
            return None  # walk-only chains are covered by the direct walk

        # Walks before the first ride are anchored backwards from its
        # departure: leave the origin just in time, not at the queried minute.
        nxt = raw[first_ride]
        dep0 = self.patterns[nxt[1]]["trips"][nxt[2]]["times"][nxt[3]][1]
        prefix = []
        anchor = dep0
        for rec in reversed(raw[:first_ride]):
            if rec[0] == "access":
                _, w, dist, stop = rec
                frm = {"lat": origin[1], "lon": origin[0]}
                to = self._stop_json(stop)
            else:  # ("walk", from stop, to stop, secs)
                _, f, to_s, w = rec
                frm = self._stop_json(f)
                to = self._stop_json(to_s)
                dist = self._stop_dist(f, to_s)
            prefix.append({
                "type": "walk",
                "from": frm,
                "to": to,
                "depart": int(anchor - w),
                "arrive": int(anchor),
                "dist_m": int(dist),
            })
            anchor -= w
        prefix.reverse()

        legs = prefix
        t = dep0        # running clock: arrival time of the previous leg
        rides = 0
        for rec in raw[first_ride:]:
            if rec[0] == "ride":
                _, pi, ti, bpos, apos = rec
                pat = self.patterns[pi]
                trip = pat["trips"][ti]
                dep = trip["times"][bpos][1]
                arr = trip["times"][apos][0]
                rides += 1
                legs.append({
                    "type": "ride",
                    "route_id": pat["route_id"],
                    "short_name": pat["short_name"],
                    "long_name": pat["long_name"],
                    "color": pat["color"],
                    "headsign": trip["headsign"],
                    "board": self._stop_json(pat["stop_idxs"][bpos], dep),
                    "alight": self._stop_json(pat["stop_idxs"][apos], arr),
                    "depart": int(dep),
                    "arrive": int(arr),
                    "stops": [
                        self._stop_json(pat["stop_idxs"][p],
                                        trip["times"][p][0])
                        for p in range(bpos, apos + 1)
                    ],
                    "geometry": self._ride_geometry(pat, bpos, apos),
                })
                t = arr
            else:  # mid-journey walk between stops
                _, frm, to, w = rec
                legs.append({
                    "type": "walk",
                    "from": self._stop_json(frm),
                    "to": self._stop_json(to),
                    "depart": int(t),
                    "arrive": int(t + w),
                    "dist_m": self._stop_dist(frm, to),
                })
                t = t + w
        w = _walk_secs(egress_dist)
        legs.append({
            "type": "walk",
            "from": dict(legs[-1]["to"]) if legs[-1]["type"] == "walk"
                else dict(legs[-1]["alight"]),
            "to": {"lat": dest[1], "lon": dest[0]},
            "depart": int(t),
            "arrive": int(t + w),
            "dist_m": int(egress_dist),
        })
        departure = legs[0]["depart"]
        arrival = legs[-1]["arrive"]
        return {
            "departure": int(departure),
            "arrival": int(arrival),
            "duration": int(arrival - departure),
            "transfers": max(0, rides - 1),
            "legs": legs,
        }
