# Mapping Brunei Bus System

An interactive web application for visualizing bus routes in Brunei.

## About

- Current routes based on manually mapping paths based on locations indicated by signboards (in docs/images)
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

## Project Structure

```
brunei_bus_routes/
├── data/                    # Source data files
│   ├── geojson/            # GeoJSON route files
│   └── kml/                # KML route files
│
├── docs/                    # Documentation and reference
│   ├── images/             # Route images and signboard photos
│   └── reference/          # Additional documentation
│
├── webapp/                  # Web application
│   ├── css/                # Stylesheets
│   ├── js/                 # JavaScript files
│   └── index.html          # Main application page
│
└── run.py                  # Local development server
```

## How to Run

1. Make sure you have Python 3 installed on your system

2. Clone this repository:

```bash
git clone https://github.com/yourusername/brunei_bus_routes.git
cd brunei_bus_routes
```

3. Start the server:

```bash
python app.py

or

export FLASK_APP=app.py && export FLASK_ENV=development && export FLASK_DEBUG=1 && flask run --host=0.0.0.0 --port=8000
flask run
```

4. Open http://localhost:8000 in your web browser

5. To stop the server, press Ctrl+C in the terminal

## Usage

- Use the sidebar to toggle different bus routes on/off
- Click on routes or markers to view information
- Pan and zoom the map to explore different areas
- On mobile devices, use the "Show Routes" button to access the route toggle menu

## Technologies Used

- OpenLayers 3 for map visualization
- Bootstrap for responsive UI
- jQuery for interactivity
- Python's built-in HTTP server

## Credits

Original work by [Timothy Shim](https://github.com/thewheat)

---

# Fork Additions

This section documents changes made in this fork on top of the original work
above. The original README is preserved as-is for reference.

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
without mixing. The app serves a single year, selected by the `DATA_YEAR`
constant in `app.py` (currently `"2016"`).

## Project Structure (current)

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

Then open http://localhost:8000 in your browser.

## Technologies Used

- [Flask](https://flask.palletsprojects.com/) — Python web server
- [OpenLayers](https://openlayers.org/) — main map visualization
- [Three.js](https://threejs.org/) and [MapLibre GL JS](https://maplibre.org/) — 3D ride modes
- [Turf.js](https://turfjs.org/) — route geometry math
- [OpenStreetMap](https://www.openstreetmap.org/) — map tiles (no API key required)
