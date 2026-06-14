# Mapping Brunei Bus System

> **Original README** by [Timothy Shim](https://github.com/thewheat) (2016) — preserved verbatim:
>
> - Current routes based on manually mapping paths based on locations indicated by signboards (the images in this repo)
> - Likely to have lot so errors but should give a rough outline of bus routes

---

# Additions

Everything below was added after the original above (by later maintainers / this
fork) and is **not** part of Timothy's original README.

An interactive web application for visualizing bus routes in Brunei.

## About

- Current routes based on manually mapping paths based on locations indicated by signboards (in `docs/2016/images`)
- Likely to have lot of errors but should give a rough outline of bus routes
- Data sourced from Land Transport Department's EOI for Public Bus Services

## Features

- Interactive map using OpenStreetMap
- 28+ bus routes with toggleable layers
- Route information display on click
- Mobile-responsive design
- Includes:
  - Main bus routes
  - KB Seria, Tutong, and Temburong routes
  - Feeder stops and interchanges
  - Mosque locations for reference

## 3D "Ride the Route" Mode

Pick a route and ride it in 3D as a bus drives the path, in either of two
rendering engines:

- **Three.js ride** (`/ride/three`) — chase cam following a bus over a ground
  textured with stitched OpenStreetMap tiles.
- **MapLibre ride** (`/ride/maplibre`) — a tilted real OSM map with the camera
  chasing a bus marker.

Both rides share:

- Play/pause and a speed slider (down to 0.1×, defaulting to the slowest speed)
- A scrubbable progress bar — click or drag to jump anywhere in the journey
- Toggles to show/hide stops and the minimap
- A live OSM minimap (bottom-right) that follows the bus, with zoom controls
  (z7–z19, default z15) and a reset-zoom button

Launch it from the main map via the "🚌 3D Ride" button.

## Data Organized by Year

The route data, docs, and notes are segregated by the year the dataset
originates from, so new datasets can live alongside the original 2016 set
without mixing. The app exposes a **year picker** in the navbar so users choose
which year to view; the `DATA_YEAR` constant in `app.py` (currently `"2016"`)
sets the default, and requests may override it via a `?year=` query param.

## KML vs GeoJSON

The 2016 data carries two **independent** geometry sets — they are not
conversions of each other:

- **KML** (`kml/`) — the detailed route geometry, including **named stops**,
  with descriptive filenames. This is what the map renders by default and what
  the 3D ride uses for stops.
- **GeoJSON** (`geojson/`) — **path-only** route lines (no stops), named by the
  actual route number. Shown as a separate dashed overlay in the sidebar and
  also 3D-ridable.

A geometry comparison confirms the two were drawn independently: matching the
same route across the sets, the paths differ by hundreds of metres to several
kilometres (none align closely). They cover the same network but are alternate
tracings, so treat them as independent sources rather than duplicates.

## Project Structure

```
brunei_bus_routes/
├── app.py                     # Flask development server
├── requirements.txt           # Python dependencies (Flask, defusedxml)
│
├── data/                       # Source data files, by year
│   └── 2016/
│       ├── geojson/           # GeoJSON route files
│       └── kml/               # KML route files
│
├── docs/                       # Documentation and reference, by year
│   └── 2016/
│       ├── images/            # Route images and signboard photos
│       │   ├── stops/         # Stop signboard photos
│       │   └── timings/       # Timing signboard photos
│       └── reference/         # notes.txt, routes.txt
│
├── misc/                       # Misc reference assets, by year
│   └── 2016/                  # ADBS reference gifs
│
├── static/                     # Web assets served by Flask
│   ├── css/                   # Stylesheets
│   ├── js/                    # JavaScript (map + ride modes)
│   └── data/2016/             # Route data the app serves (kml + routes.json)
│
└── templates/                  # HTML templates (index + ride pages)
```

## How to Run

```bash
# create a virtual environment and install dependencies
python -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip install -r requirements.txt

# run the app
.venv/bin/python app.py                      # Windows: .venv\Scripts\python app.py
```

Then open http://localhost:8000 in your browser. To stop the server, press
Ctrl+C in the terminal.

## Hosting on Replit

The app runs on Replit as-is, but route edits need a persistent home. Edits are
stored in a database whose backend is chosen at runtime (see `db.py`):

- **No `DATABASE_URL`** → a local SQLite file (`instance/edits.db`). Fine for
  local dev, but a Replit Autoscale Deployment has an **ephemeral filesystem**:
  the file is wiped on every redeploy and is not shared between instances, so
  saved edits would be lost.
- **`DATABASE_URL` set** → PostgreSQL, which lives outside that filesystem and
  persists across redeploys and instances.

To host with persistence:

1. Add the **PostgreSQL** tool to your Repl (Tools → PostgreSQL). Replit injects
   `DATABASE_URL` automatically; the app picks it up with no code changes.
2. Deploy. The included `.replit` runs the app under gunicorn for Autoscale.
3. (Optional) Carry over existing local edits — with `DATABASE_URL` pointing at
   the Postgres target, run:

   ```bash
   python scripts/migrate_sqlite_to_pg.py   # copies instance/edits.db into Postgres
   ```

The git-tracked route data and stop images travel with the repo, and the
client-side bits (recent trips, ride-music settings) live in browser
`localStorage` — neither is affected by the host.

### Editor login

The map, planner, and ride pages are public and read-only. **Editing** — route
geometry, schedules, notes, the `/gtfs` workbench, and all write endpoints —
requires logging in with a single shared password (`auth.py`).

Set two secrets (Repl → Tools → Secrets):

- `EDITOR_PASSWORD` — the editor password. **Fail-closed: if unset, editing is
  locked** (no one can log in) and a warning is logged at startup. Set it to
  enable the editor — locally and in production alike.
- `SECRET_KEY` — a long random string that signs the session cookie. Required so
  the login stays valid across gunicorn workers and autoscale instances; locally
  it falls back to a random per-process value (sessions reset on restart).

Log in via the **✎ Log in** button (or visit `/login`). The session cookie is
`HttpOnly`, `SameSite=Lax`, and `Secure` in production. Login attempts are rate
limited to slow password guessing.

### Rate limiting

The data-entry (write) endpoints are rate limited per client IP to stop
automated flooding of the edits DB. Defaults are **30 writes / 10s** and
**100 writes / 60s** — far above human editing (autosaves debounce at ~0.6–0.8s),
but enough to cut off a script within seconds. Over-limit requests get `429` with
a `Retry-After` header. Counters live in the app DB (`ratelimit.py`), so limits
hold across gunicorn workers and autoscale instances. Reads are not limited.

Tune without code changes via env vars: `RATE_LIMIT_WRITE="30/10,100/60"`
(hits/seconds, comma-separated) or `RATE_LIMIT_DISABLED=1` to turn it off. The app
trusts one proxy hop (`X-Forwarded-For`) so the real client IP is used behind
Replit's proxy.

## Usage

- Use the sidebar to toggle different bus routes on/off
- Click on routes or markers to view information
- Pan and zoom the map to explore different areas
- On mobile devices, use the "Show Routes" button to access the route toggle menu

## GTFS Export

The route data can be exported as a [GTFS](https://gtfs.org/) feed (the standard
transit data format consumed by trip planners, OpenTripPlanner, Google/Apple
Maps, and validators).

```bash
# build a feed for the 2016 dataset
.venv/bin/python scripts/build_gtfs.py --year 2016 --out gtfs.zip
```

Or download it from the running app at
[`/data/gtfs.zip`](http://localhost:8000/data/gtfs.zip) (add `?year=YYYY` to pick
a dataset). Both paths reflect any saved route edits.

**Note on schedules:** the source data has real route geometry (`shapes.txt`) and
named, ordered stops (`stops.txt`), but no machine-readable timetables — only
photographed signboards. The feed is therefore **frequency-based**: each route
gets one representative trip with stop times interpolated along its shape, plus a
`frequencies.txt` row with a nominal 30-minute headway over a 06:00–20:00 window.
These are placeholders to be replaced with real values transcribed from the JPD
timing signboards. A single placeholder agency (ADBS) is used until the real
operator-per-route mapping is known.

### GTFS workbench

The **🕐 GTFS** button in the navbar opens a dedicated page at
[`/gtfs`](http://localhost:8000/gtfs) where **one selected route drives
everything**: click a route in the list and it shows on the map, becomes the
editing target, and fills the GTFS pane. **✎ Edit route** on the map opens the
full geometry editor (line/stop tools, undo, version history) — official routes
are edited as an automatically created copy, reused on later edits. Feed-wide
agency and fare settings live under **⚙ Feed settings** in the top bar, and
**⬇ Download GTFS** grabs the zip. User-drawn routes are exported too, so the
full flow is draw → schedule → download. The GTFS pane covers:

- **Per-route schedules in day-type blocks** — each block has its own
  operating days, run time, optional **exact departure times** transcribed
  from the signboard, and **time-of-day frequency bands** (peak/off-peak:
  "every 10 min 06:00–08:30, every 30 min 08:30–16:00…" → one
  `frequencies.txt` row per band). A route can carry e.g. a weekday and a
  different weekend timetable (each block becomes its own `calendar.txt`
  service). Routes with departures export one real trip per departure (pure
  schedule-based GTFS, no synthetic frequency entry), with intermediate stop
  times spread over the run time (entered, or estimated from shape length at
  ~18 km/h)
- **Route metadata** — route number, long name, color, and the operator
  running the route (`routes.txt`, including per-route `agency_id`)
- **Directions & headsigns** — mark a route *out & back* to export both
  directions (`direction_id` 0/1 with reversed shape and stop order) and set
  the bus's destination signs (`trip_headsign`); return departures can be
  transcribed exactly per block, or are derived (outbound + run time) when
  left empty. Loops/one-ways stay single-direction
- **Description & hail-and-ride** — per-route `route_desc`, and a *hail &
  ride* flag for Brunei's flag-down culture (`continuous_pickup`/
  `continuous_drop_off`)
- **Transcription progress** — each route in the list carries a 4-segment
  meter (schedule · departures · operator · headsign) showing what's left
  to transcribe
- **Stops list** — every stop of the selected route in sequence order, with
  editable public stop codes (`stop_code`, à la Singapore's numbered stops),
  names and coordinates, reorder/remove, and click-to-locate on the map;
  edits save as new geometry versions (official routes become editable via
  the ✎ copy flow)
- **Feed settings** — the operator list (multiple companies supported; the
  first is the default for unassigned routes), holiday exceptions ("no
  service" or "Sunday timetable" per date → weekday-aware
  `calendar_dates.txt` rows), and flat fare (`agency.txt`,
  `fare_attributes.txt`)
- **Timing signboard reference** — the official JPD timing photo for the route
  (`docs/<year>/images/timings/`) is shown beside the form so departure times
  can be transcribed directly
- **✔ Validate** — builds the feed in memory and runs structural checks
  (required files/columns, duplicate ids, referential integrity, time/date
  formats, per-trip monotonicity, frequency-window overlap, stops far off
  their route's line, unused entities) with results in a modal; also
  available as `scripts/build_gtfs.py --validate`. For publish-grade
  conformance, additionally run [MobilityData's canonical
  validator](https://gtfs-validator.mobilitydata.org/)

Exports also include auto-generated walking **`transfers.txt`** (distinct
stops within 100 m), and `feed_version` is stamped with the export date.

A **data entry guide** for transcription personnel lives at
[`/gtfs/guide`](http://localhost:8000/gtfs/guide) (the **？ Guide** button in
the workbench): what goes where, the per-route checklist, signboard usage,
and a field-to-GTFS reference.

Edits auto-save to the local SQLite store (`instance/edits.db`) and are merged
into every subsequent export from both the endpoint and the CLI.

## Trip Planner

The trip planner (`/planner`, 🧭 Planner in the navbar) answers point-to-point
journey queries — where to board, which routes to ride, where to transfer —
using the [RAPTOR](https://www.microsoft.com/en-us/research/publication/round-based-public-transit-routing/)
algorithm over the same in-memory GTFS feed the export emits, so planned
journeys always match what a GTFS consumer of the feed would compute.

- **Two data sources**, switchable in the sidebar: the **2016 official** dataset
  or **My routes** (the routes you drew and scheduled in the GTFS workbench).
  The 2016 source carries a dismissable coverage caveat (its KML-derived stops
  are incomplete, so journeys may show extra transfers or detours); ✕ collapses
  it to a "show notice" link, and the choice persists in the browser.
- Set start (A) and destination (B) by clicking the map or typing a stop name;
  pick a departure time and day of travel.
- Every planned search lands in a **Recent trips** list (persisted in the
  browser, deduped, newest first) — click one to make it the active trip
  again, ✕ to remove it, or clear them all. One trip is active at a time;
  the ✕ next to Plan trip clears the current search.
- Results are the Pareto set over arrival time vs. transfers: each extra
  transfer is only offered when it strictly arrives earlier. Walking covers
  access/egress (up to ~1 km), transfers between nearby stops, and an
  end-to-end walk when the two points are close.
- Selecting a journey draws it on the map — colored ride legs along the real
  route shapes, dashed walk legs that follow real roads (via the public OSM
  foot router, falling back to straight lines offline) — and **🚌 3D preview**
  rides the whole journey end-to-end in either 3D engine. Walked stretches
  swap the bus for a pedestrian: an animated 3D person in Three.js, a 🚶
  marker in MapLibre.

Routes without transcribed departures plan against their synthetic headway
(default: every 30 min, 06:00–20:00), so waits and arrival times are nominal
until real timetables are transcribed in the workbench.

## Technologies Used

- [Flask](https://flask.palletsprojects.com/) — Python web server
- [OpenLayers](https://openlayers.org/) — main map visualization
- [Three.js](https://threejs.org/) and [MapLibre GL JS](https://maplibre.org/) — 3D ride modes
- [Turf.js](https://turfjs.org/) — route geometry math
- [OpenStreetMap](https://www.openstreetmap.org/) — map tiles (no API key required)

## Roadmap

Recommended features that would enhance the app, in rough order of impact and
feasibility:

1. ~~**Journey Planner**~~ — done: see [Trip Planner](#trip-planner). Remaining
   ideas: fare estimates and richer alternatives (e.g. depart-later options).
2. **Enhanced Bus Stop Information** — comprehensive stop database,
   arrival/departure schedules, stop amenities, and photos and accessibility
   details. (A frequency-based [GTFS export](#gtfs-export) already exists; real
   timetables transcribed from the timing signboards would complete this.)
3. **Real-time Features** — live bus tracking, service disruption alerts,
   real-time occupancy levels, and schedule updates.
4. **User Experience Improvements** — route favorites, offline map support,
   multi-language (Malay/English), and accessibility features.
5. **Community Features** — user reviews/ratings, issue reporting, service
   feedback, and crowdsourced updates.

With the journey planner in place, transcribing real timetables (item 2) is now
the highest-value work: planned waits and arrival times are only as good as the
schedules behind them.

## Credits

Original work by [Timothy Shim](https://github.com/thewheat)
