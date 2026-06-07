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
   details.
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
