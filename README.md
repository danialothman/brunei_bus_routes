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

## Roadmap Features

Based on analysis of the current codebase, here are recommended features that would enhance the Brunei Bus Routes application, listed in order of impact and feasibility:

1. Journey Planner (Highest Impact)
   Route planning between any two points
   Multiple route options with transfer points
   Walking directions to/from stops
   Journey time and fare estimates

2. Enhanced Bus Stop Information
   Comprehensive stop database
   Arrival/departure schedules
   Stop amenities information
   Stop photos and accessibility details

3. Real-time Features
   Live bus tracking
   Service disruption alerts
   Real-time occupancy levels
   Schedule updates

4. User Experience Improvements
   Route favorites
   Offline map support
   Multi-language (Malay/English)
   Accessibility features

5. Community Features
   User reviews/ratings
   Issue reporting
   Service feedback
   Crowdsourced updates

The journey planner would be the most valuable addition as it would transform the app from an informational tool into a practical trip planning solution, significantly improving its utility for daily commuters and tourists alike.
