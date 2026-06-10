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

- **Per-route schedule** — headway, first/last bus, operating days (becomes
  `frequencies.txt` and per-pattern `calendar.txt` services), or **exact
  departure times** transcribed from the signboard — routes with departures
  export one real trip per departure (pure schedule-based GTFS, no synthetic
  frequency entry), with intermediate stop times spread over the route's run
  time (entered, or estimated from shape length at ~18 km/h)
- **Route metadata** — route number, long name, color, and the operator
  running the route (`routes.txt`, including per-route `agency_id`)
- **Directions & headsigns** — mark a route *out & back* to export both
  directions (`direction_id` 0/1 with reversed shape and stop order, return
  departures offset by the run time) and set the bus's destination signs
  (`trip_headsign`); loops/one-ways stay single-direction
- **Stops list** — every stop of the selected route in sequence order, with
  editable names and coordinates, reorder/remove, and click-to-locate on the
  map; edits save as new geometry versions (official routes become editable
  via the ✎ copy flow)
- **Feed settings** — the operator list (multiple companies supported; the
  first is the default for unassigned routes) and flat fare (`agency.txt`,
  `fare_attributes.txt`)
- **Timing signboard reference** — the official JPD timing photo for the route
  (`docs/<year>/images/timings/`) is shown beside the form so departure times
  can be transcribed directly

Edits auto-save to the local SQLite store (`instance/edits.db`) and are merged
into every subsequent export from both the endpoint and the CLI.

## Technologies Used

- [Flask](https://flask.palletsprojects.com/) — Python web server
- [OpenLayers](https://openlayers.org/) — main map visualization
- [Three.js](https://threejs.org/) and [MapLibre GL JS](https://maplibre.org/) — 3D ride modes
- [Turf.js](https://turfjs.org/) — route geometry math
- [OpenStreetMap](https://www.openstreetmap.org/) — map tiles (no API key required)

## Roadmap

Recommended features that would enhance the app, in rough order of impact and
feasibility:

1. **Journey Planner** (highest impact) — route planning between any two points,
   multiple route options with transfer points, walking directions to/from
   stops, and journey time and fare estimates.
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

The journey planner would be the most valuable addition: it would transform the
app from an informational tool into a practical trip-planning solution,
significantly improving its utility for daily commuters and tourists alike.

## Credits

Original work by [Timothy Shim](https://github.com/thewheat)
