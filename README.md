# Mapping Brunei Bus System

An interactive web application for visualizing bus routes in Brunei.

## About

- Current routes based on manually mapping paths based on locations indicated by signboards (the images in this repo)
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

## How to Run

1. Make sure you have Python 3 installed on your system

2. Clone this repository:

```bash
git clone https://github.com/yourusername/brunei_bus_routes.git
cd brunei_bus_routes
```

3. Start the server:

```bash
cd webapp
python3 ../serve.py
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
