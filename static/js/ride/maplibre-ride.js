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
    progressWrap: document.getElementById("progress-wrap"),
    toggleStops: document.getElementById("toggle-stops"),
    toggleMinimap: document.getElementById("toggle-minimap"),
    minimap: document.getElementById("minimap"),
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
    // Real km/h simulation speed; 'total' is in km, so km/h / 3600 = km/s.
    let speedKmh = parseFloat(els.speed.value) || 40;
    els.speedVal.textContent = `${speedKmh} km/h`;
    let traveled = 0;
    let playing = true;
    let lastStop = null;
    let lastTs = null;
    let scrubbing = false;
    let stopsVisible = true;

    // Stop markers as a GeoJSON point layer (matches the Three.js yellow pucks).
    const stopsFC = {
      type: "FeatureCollection",
      features: geo.stops.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { name: s.name || "" },
      })),
    };

    function sampleHeading(dist) {
      const back = turf.along(line, Math.max(dist - 0.012, 0));
      const fwd = turf.along(line, Math.min(dist + 0.012, total));
      return turf.bearing(back, fwd);
    }

    function updateStopBanner(busCoord) {
      if (!stopsVisible) return;
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
      map.addSource("stops", { type: "geojson", data: stopsFC });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        layout: { visibility: stopsVisible ? "visible" : "none" },
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffd166",
          "circle-stroke-color": "#7a5b00",
          "circle-stroke-width": 1.5,
        },
      });
    }

    function frame(ts) {
      requestAnimationFrame(frame);
      const dt = lastTs == null ? 0 : Math.min((ts - lastTs) / 1000, 0.1);
      lastTs = ts;

      if (playing && !scrubbing && traveled < total) {
        traveled = Math.min(traveled + (speedKmh / 3600) * dt, total);
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
      speedKmh = parseFloat(els.speed.value);
      els.speedVal.textContent = `${speedKmh} km/h`;
    });
    els.toggleStops.addEventListener("click", () => {
      stopsVisible = !stopsVisible;
      if (map.getLayer("stops")) {
        map.setLayoutProperty(
          "stops",
          "visibility",
          stopsVisible ? "visible" : "none"
        );
      }
      els.toggleStops.classList.toggle("active", stopsVisible);
      els.toggleStops.setAttribute("aria-pressed", String(stopsVisible));
      if (!stopsVisible) {
        lastStop = null;
        els.banner.classList.remove("show");
      }
    });
    els.toggleMinimap.addEventListener("click", () => {
      const visible = els.minimap.classList.toggle("hidden") === false;
      els.toggleMinimap.classList.toggle("active", visible);
      els.toggleMinimap.setAttribute("aria-pressed", String(visible));
    });

    // Scrub: click or drag along the progress bar to jump anywhere in the ride.
    // The frame loop reads `traveled` every tick, so the bus/camera/minimap
    // follow the new position on the next frame.
    function scrubTo(clientX) {
      const rect = els.progressWrap.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      traveled = f * total;
      els.progress.style.width = `${(f * 100).toFixed(1)}%`;
      if (traveled < total) {
        els.playpause.textContent = playing ? "⏸" : "▶";
      }
    }
    els.progressWrap.addEventListener("pointerdown", (e) => {
      scrubbing = true;
      els.progressWrap.setPointerCapture(e.pointerId);
      scrubTo(e.clientX);
    });
    els.progressWrap.addEventListener("pointermove", (e) => {
      if (scrubbing) scrubTo(e.clientX);
    });
    const endScrub = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      try {
        els.progressWrap.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* pointer already released */
      }
    };
    els.progressWrap.addEventListener("pointerup", endScrub);
    els.progressWrap.addEventListener("pointercancel", endScrub);
  }

  main();
})();
