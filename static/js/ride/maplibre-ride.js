// MapLibre "ride the route" — a real OSM map laid on the ground, tilted, with
// the camera chasing a bus marker along the route. Companion to three-ride.js
// for an apples-to-apples comparison of the two engines.
(function () {
  const RP = APP.RidePath;

  const els = {
    title: document.getElementById("route-title"),
    status: document.getElementById("ride-status"),
    statusSub: document.getElementById("ride-status-sub"),
    banner: document.getElementById("stop-banner"),
    playpause: document.getElementById("playpause"),
    speed: document.getElementById("speed"),
    speedVal: document.getElementById("speed-val"),
    progress: document.getElementById("progress-bar"),
  };

  function showError(msg) {
    els.status.classList.remove("hidden");
    els.status.innerHTML =
      `<div>${msg}</div><div class="sub"><a href="/">← Back to the map</a></div>`;
  }

  // Keyless raster style: OpenStreetMap tiles ARE the ground.
  const OSM_STYLE = {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };

  async function main() {
    const routeFile = RP.routeFromQuery();
    if (!routeFile) {
      showError("No route selected.");
      return;
    }

    let geo;
    try {
      geo = await RP.fetchGeometry(routeFile);
    } catch (e) {
      showError("Could not load this route.");
      return;
    }
    const drivePath = RP.pickDrivePath(geo.segments);
    if (drivePath.length < 2) {
      showError("This route has no drivable path yet.");
      return;
    }

    const routeName = geo.name || routeFile.replace(".kml", "");
    els.title.textContent = routeName;
    document.title = `3D Ride · ${routeName}`;
    const color = RP.colorFor(routeFile);

    const line = turf.lineString(drivePath);
    const total = turf.length(line); // km
    const start = drivePath[0];

    const bounds =
      geo.bounds ||
      drivePath.reduce(
        (b, [lon, lat]) => ({
          minLon: Math.min(b.minLon, lon),
          maxLon: Math.max(b.maxLon, lon),
          minLat: Math.min(b.minLat, lat),
          maxLat: Math.max(b.maxLat, lat),
        }),
        { minLon: 180, maxLon: -180, minLat: 90, maxLat: -90 }
      );
    const minimap = new APP.Minimap(
      document.getElementById("minimap"),
      drivePath,
      bounds,
      color
    );

    const map = new maplibregl.Map({
      container: "map",
      style: OSM_STYLE,
      center: start,
      zoom: 17,
      pitch: 68,
      bearing: 0,
      interactive: false, // on-rails: the user doesn't control the view
      attributionControl: { compact: true },
    });

    // Bus marker (top-down; map rotates so travel direction points up)
    const busEl = document.createElement("div");
    busEl.className = "bus-marker";
    busEl.style.background = color;
    const busMarker = new maplibregl.Marker({ element: busEl }).setLngLat(start);

    // Ride state
    const TARGET_DURATION = 80; // seconds at 1x
    const baseSpeed = total / TARGET_DURATION; // km/s
    let traveled = 0;
    let playing = true;
    let speedMul = 1;
    let lastStop = null;
    let lastTs = null;

    function sampleHeading(dist) {
      const back = turf.along(line, Math.max(dist - 0.012, 0));
      const fwd = turf.along(line, Math.min(dist + 0.012, total));
      return turf.bearing(back, fwd);
    }

    function updateStopBanner(busCoord) {
      let nearest = null;
      let best = 0.07; // km (~70 m)
      for (const s of geo.stops) {
        if (!s.name) continue;
        const d = turf.distance(busCoord, [s.lon, s.lat]);
        if (d < best) {
          best = d;
          nearest = s;
        }
      }
      if (nearest && nearest !== lastStop) {
        lastStop = nearest;
        els.banner.textContent = `🚏 ${nearest.name}`;
        els.banner.classList.add("show");
      } else if (!nearest) {
        lastStop = null;
        els.banner.classList.remove("show");
      }
    }

    function addRouteLayers() {
      if (map.getSource("route")) return;
      map.addSource("route", { type: "geojson", data: line });
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.7 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: { "line-color": color, "line-width": 5 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    function frame(ts) {
      requestAnimationFrame(frame);
      const dt = lastTs == null ? 0 : Math.min((ts - lastTs) / 1000, 0.1);
      lastTs = ts;

      if (playing && traveled < total) {
        traveled = Math.min(traveled + baseSpeed * speedMul * dt, total);
        if (traveled >= total) {
          playing = false;
          els.playpause.textContent = "↻";
        }
      }

      const busPt = turf.along(line, Math.min(traveled, total));
      const camPt = turf.along(line, Math.min(traveled + 0.04, total));
      const heading = sampleHeading(traveled);
      const busCoord = busPt.geometry.coordinates;

      busMarker.setLngLat(busCoord);
      map.jumpTo({
        center: camPt.geometry.coordinates,
        bearing: heading,
        pitch: 68,
        zoom: 17,
      });

      updateStopBanner(busCoord);
      minimap.update(busCoord);
      els.progress.style.width = `${((traveled / total) * 100).toFixed(1)}%`;
    }

    // Start the ride on style-load, or after a short fallback so slow tiles
    // never leave the user stuck on "Preparing…".
    let started = false;
    function startRide() {
      if (started) return;
      started = true;
      busMarker.addTo(map);
      els.status.classList.add("hidden");
      requestAnimationFrame(frame);
    }
    map.on("load", () => {
      addRouteLayers();
      startRide();
    });
    setTimeout(startRide, 6000);

    map.on("error", (e) => {
      // tile errors are non-fatal; only surface a hard style failure
      if (e && e.error && /style/i.test(e.error.message || "")) {
        showError("Map failed to load.");
      }
    });

    // Controls
    els.playpause.addEventListener("click", () => {
      if (traveled >= total) {
        traveled = 0;
        playing = true;
      } else {
        playing = !playing;
      }
      els.playpause.textContent = playing ? "⏸" : "▶";
    });
    els.speed.addEventListener("input", () => {
      speedMul = parseFloat(els.speed.value);
      els.speedVal.textContent = `${speedMul}×`;
    });
  }

  main();
})();
