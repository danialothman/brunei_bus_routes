// Three.js "ride the route" — chase cam following a procedural bus along the
// real route geometry, over a flat ground textured with stitched OSM tiles.
import * as THREE from "three";

const RP = APP.RidePath;

const els = {
  canvas: document.getElementById("scene"),
  title: document.getElementById("route-title"),
  status: document.getElementById("ride-status"),
  statusSub: document.getElementById("ride-status-sub"),
  banner: document.getElementById("stop-banner"),
  progressPanel: document.getElementById("stop-progress"),
  spPrev: document.getElementById("sp-prev"),
  spNext: document.getElementById("sp-next"),
  playpause: document.getElementById("playpause"),
  prevStop: document.getElementById("prev-stop"),
  nextStop: document.getElementById("next-stop"),
  speed: document.getElementById("speed"),
  speedVal: document.getElementById("speed-val"),
  progress: document.getElementById("progress-bar"),
  progressWrap: document.getElementById("progress-wrap"),
  toggleStops: document.getElementById("toggle-stops"),
  toggleMinimap: document.getElementById("toggle-minimap"),
  minimap: document.getElementById("minimap"),
  legs: document.getElementById("ride-legs"),
  mapStyle: document.getElementById("mapStyle"),
};

function showError(msg) {
  els.status.classList.remove("hidden");
  els.status.innerHTML =
    `<div>${msg}</div><div class="sub"><a href="/">← Back to the map</a></div>`;
}

// --- Web Mercator tile math (for the OSM ground texture) ---------------------
function lon2tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
  );
}
function tileX2lon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}
function tileY2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}
function chooseZoom(b, maxPerSide) {
  for (let z = 17; z >= 10; z--) {
    const cols = lon2tileX(b.maxLon, z) - lon2tileX(b.minLon, z) + 1;
    const rows = lat2tileY(b.minLat, z) - lat2tileY(b.maxLat, z) + 1;
    if (cols <= maxPerSide && rows <= maxPerSide) return z;
  }
  return 12;
}

async function buildGround(bounds, origin, style) {
  // Pad the route bbox so we see a bit of surroundings.
  const padLon = (bounds.maxLon - bounds.minLon) * 0.15 + 0.002;
  const padLat = (bounds.maxLat - bounds.minLat) * 0.15 + 0.002;
  const b = {
    minLon: bounds.minLon - padLon,
    maxLon: bounds.maxLon + padLon,
    minLat: bounds.minLat - padLat,
    maxLat: bounds.maxLat + padLat,
  };
  const z = chooseZoom(b, 6);
  const x0 = lon2tileX(b.minLon, z);
  const x1 = lon2tileX(b.maxLon, z);
  const y0 = lat2tileY(b.maxLat, z); // north
  const y1 = lat2tileY(b.minLat, z); // south
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;

  const canvas = document.createElement("canvas");
  canvas.width = cols * 256;
  canvas.height = rows * 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = (APP.RIDE_TILES[style] || {}).fallback || "#e2e5e9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const loads = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const dx = (x - x0) * 256;
      const dy = (y - y0) * 256;
      const url = APP.rideTileUrl(style, z, x, y);
      loads.push(
        new Promise((resolve) => {
          const img = new Image();
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          img.crossOrigin = "anonymous";
          img.onload = () => {
            try {
              ctx.drawImage(img, dx, dy);
            } catch (e) {
              /* ignore draw errors */
            }
            finish();
          };
          img.onerror = finish;
          // Don't let a slow/unreachable tile hang the whole ride.
          setTimeout(finish, 4000);
          img.src = url;
        })
      );
    }
  }
  await Promise.all(loads);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  // World extent matches the tile-grid geographic boundaries.
  const nw = RP.lonLatToMeters([tileX2lon(x0, z), tileY2lat(y0, z)], origin);
  const se = RP.lonLatToMeters(
    [tileX2lon(x1 + 1, z), tileY2lat(y1 + 1, z)],
    origin
  );
  const width = se.x - nw.x;
  const depth = se.z - nw.z;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({ map: texture })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
  return mesh;
}

// --- Road ribbon + route line ------------------------------------------------
function buildRoad(pts, color, pathColors) {
  const half = 4.5;
  const edges = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    edges.push([
      [pts[i].x - dz * half, pts[i].z + dx * half],
      [pts[i].x + dz * half, pts[i].z - dx * half],
    ]);
  }
  const verts = [];
  const y = 0.25;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = edges[i];
    const [c, d] = edges[i + 1];
    verts.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
    verts.push(b[0], y, b[1], d[0], y, d[1], c[0], y, c[1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0x2b2b2b,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
      })
    )
  );
  // Bright centerline — per-leg colours when a planned trip provides them
  // (rides in route colour, walks grey), otherwise the single route colour.
  const linePts = pts.map((p) => new THREE.Vector3(p.x, 0.4, p.z));
  const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
  let lineMat;
  if (Array.isArray(pathColors) && pathColors.length === pts.length) {
    const cols = [];
    const tmp = new THREE.Color();
    for (const hex of pathColors) {
      tmp.set(hex || color);
      cols.push(tmp.r, tmp.g, tmp.b);
    }
    lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    lineMat = new THREE.LineBasicMaterial({ vertexColors: true });
  } else {
    lineMat = new THREE.LineBasicMaterial({ color });
  }
  group.add(new THREE.Line(lineGeo, lineMat));
  return group;
}

function buildBus(color) {
  const bus = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 3, 10),
    new THREE.MeshLambertMaterial({ color })
  );
  body.position.y = 2;
  bus.add(body);
  const windows = new THREE.Mesh(
    new THREE.BoxGeometry(2.64, 1.1, 8),
    new THREE.MeshLambertMaterial({ color: 0x1c2733 })
  );
  windows.position.y = 2.75;
  bus.add(windows);
  const wheelGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.6, 16);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x0a0a0a });
  [
    [-1.35, -3.2],
    [1.35, -3.2],
    [-1.35, 3.2],
    [1.35, 3.2],
  ].forEach(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.7, z);
    bus.add(w);
  });
  return bus;
}

// Low-poly pedestrian for the walked stretches of a planned-trip preview.
// Slightly larger than life so it reads from the chase camera; limbs pivot
// at hip/shoulder so the walk cycle can swing them.
function buildPerson() {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0xf1c27d });
  const shirt = new THREE.MeshLambertMaterial({ color: 0x2e86c1 });
  const pants = new THREE.MeshLambertMaterial({ color: 0x34495e });
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.42, 1.4, 10),
    shirt
  );
  torso.position.y = 2.1;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), skin);
  head.position.y = 3.15;
  g.add(head);
  const legGeo = new THREE.CylinderGeometry(0.15, 0.13, 1.4, 8);
  legGeo.translate(0, -0.7, 0); // pivot at the hip
  const armGeo = new THREE.CylinderGeometry(0.11, 0.1, 1.1, 8);
  armGeo.translate(0, -0.55, 0); // pivot at the shoulder
  const legL = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.22, 1.4, 0);
  const legR = new THREE.Mesh(legGeo, pants);
  legR.position.set(0.22, 1.4, 0);
  const armL = new THREE.Mesh(armGeo, skin);
  armL.position.set(-0.62, 2.7, 0);
  const armR = new THREE.Mesh(armGeo, skin);
  armR.position.set(0.62, 2.7, 0);
  g.add(legL, legR, armL, armR);
  g.userData.limbs = { legL, legR, armL, armR };
  return g;
}

function buildStops(stops, origin) {
  const group = new THREE.Group();
  const positions = [];
  const markerGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.4, 12);
  const markerMat = new THREE.MeshLambertMaterial({ color: 0xffd166 });
  stops.forEach((s) => {
    const m = RP.lonLatToMeters([s.lon, s.lat], origin);
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(m.x, 0.5, m.z);
    group.add(marker);
    positions.push({ name: s.name, pos: new THREE.Vector3(m.x, 0, m.z) });
  });
  return { group, positions };
}

// --- Main --------------------------------------------------------------------
async function main() {
  const routeFile = RP.routeFromQuery();
  if (!routeFile) {
    showError("No route selected.");
    return;
  }

  // Exit target: a planned-trip preview returns to the planner, a GTFS-launched
  // ride to the workbench; otherwise the route map (template default).
  if (routeFile === RP.TRIP_PREVIEW) {
    document.getElementById("exit").href = "/planner";
  } else if (new URLSearchParams(location.search).get("from") === "gtfs") {
    document.getElementById("exit").href = "/gtfs";
  }

  let geo;
  try {
    geo = await RP.fetchGeometry(routeFile);
  } catch (e) {
    showError("Could not load this route.");
    return;
  }
  const drivePath = RP.pickDrivePath(geo.segments);
  if (drivePath.length < 2 || !geo.bounds) {
    showError("This route has no drivable path yet.");
    return;
  }

  const routeName = geo.name || routeFile.replace(".kml", "");
  els.title.textContent = routeName;
  document.title = `3D Ride · ${routeName}`;
  const color = RP.colorFor(routeFile);
  const origin = RP.originFromBounds(geo.bounds);
  const pts = RP.pathToMeters(drivePath, origin);
  // Stops projected onto the route (fraction 0..1) for the prev/next HUD.
  const stopList = RP.stopProgressList(drivePath, geo.stops);
  // Trip-legs panel (planned previews only; hides itself for plain routes).
  APP.RideLegs.build(els.legs, geo.legs);

  // Minimap overlay (shared widget) — built early so it shows while tiles load.
  const minimap = new APP.Minimap(
    document.getElementById("minimap"),
    drivePath,
    geo.bounds,
    color,
    geo.stops,
    geo.pathColors
  );

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 400, 1600);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(200, 400, 100);
  scene.add(sun);

  const renderer = new THREE.WebGLRenderer({
    canvas: els.canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.5,
    4000
  );

  els.statusSub.textContent = "Loading map tiles…";
  let mapStyle = "osm";
  let ground = await buildGround(geo.bounds, origin, mapStyle);
  scene.add(ground);
  scene.add(buildRoad(pts, color, geo.pathColors));
  const bus = buildBus(color);
  scene.add(bus);
  // Planned-trip previews carry walk/ride phases: walked stretches swap the
  // bus for a pedestrian.
  const person = (geo.phases || []).some((p) => p.mode === "walk")
    ? buildPerson()
    : null;
  if (person) {
    person.visible = false;
    scene.add(person);
  }
  const { group: stopGroup, positions: stopPositions } = buildStops(
    geo.stops,
    origin
  );
  scene.add(stopGroup);

  // Smooth, arc-length-parameterized path
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p.x, 0, p.z))
  );
  curve.curveType = "catmullrom";
  curve.arcLengthDivisions = Math.max(400, pts.length * 2);
  const totalLength = curve.getLength();

  // Heading over a short window rather than the instantaneous tangent. The raw
  // tangent flips 180° at sub-metre back-and-forth artifacts in the geometry
  // (the line still looks straight), which would snap the model around and back.
  // A centred look-ahead/behind direction stays stable through those.
  const HEADING_WINDOW = 4; // metres
  function headingDir(u) {
    const du = HEADING_WINDOW / totalLength;
    const a = curve.getPointAt(Math.min(1, u + du));
    const b = curve.getPointAt(Math.max(0, u - du));
    const dir = new THREE.Vector3().subVectors(a, b);
    if (dir.lengthSq() < 1e-6) return curve.getTangentAt(u).normalize();
    return dir.normalize();
  }

  // Ride state. Speed is a real km/h value (from the slider) so every route
  // moves at the same actual speed regardless of length — a true simulation.
  const kmhToMs = (k) => (k * 1000) / 3600;
  let speedKmh = parseFloat(els.speed.value) || 40;
  els.speedVal.textContent = `${speedKmh} km/h`;
  let traveled = 0;
  let playing = true;
  let lastStop = null;
  let stopsVisible = true;
  let scrubbing = false;

  // Chase camera: higher up and further back for a roomier 3rd-person view.
  const CAM_BACK = 34; // metres behind the bus
  const CAM_HEIGHT = 21; // metres above the ground

  function placeAt(u) {
    const clamped = Math.min(Math.max(u, 0), 1);
    const p = curve.getPointAt(clamped);
    const tan = headingDir(clamped);
    bus.position.set(p.x, 0, p.z);
    bus.rotation.y = Math.atan2(tan.x, tan.z);
    if (person) {
      const walking = RP.modeAt(geo.phases, clamped) === "walk";
      person.visible = walking;
      bus.visible = !walking;
      person.position.copy(bus.position);
      person.rotation.y = bus.rotation.y;
      // Walk cycle keyed to distance, so the stride tracks ground speed.
      const swing = walking
        ? Math.sin(clamped * totalLength * 2.0) * 0.55
        : 0;
      const { legL, legR, armL, armR } = person.userData.limbs;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.7;
      armR.rotation.x = swing * 0.7;
    }
    const desired = new THREE.Vector3(
      p.x - tan.x * CAM_BACK,
      CAM_HEIGHT,
      p.z - tan.z * CAM_BACK
    );
    camera.position.lerp(desired, 0.1);
    camera.lookAt(p.x + tan.x * 8, 3, p.z + tan.z * 8);
    return p;
  }

  function updateStopBanner(busPos) {
    if (!stopsVisible) return;
    let nearest = null;
    let best = 70; // metres
    for (const s of stopPositions) {
      if (!s.name) continue;
      const d = busPos.distanceTo(s.pos);
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

  // Persistent previous/next stop HUD, driven by progress fraction u.
  function updateStopProgress(u) {
    APP.RideLegs.update(u); // highlight the leg being travelled (independent of stops toggle)
    if (!stopList.length || !stopsVisible) {
      els.progressPanel.classList.add("hidden");
      return;
    }
    els.progressPanel.classList.remove("hidden");
    const { prev, next } = RP.prevNextStop(stopList, u);
    els.spPrev.textContent = prev ? prev.name : "—";
    els.spNext.textContent = next ? next.name : "—";
  }

  // Position camera instantly before first frame so we don't fly in from origin
  camera.position.set(pts[0].x, CAM_HEIGHT, pts[0].z + CAM_BACK);
  placeAt(0);
  const d0 = headingDir(0);
  camera.position.set(
    pts[0].x - d0.x * CAM_BACK,
    CAM_HEIGHT,
    pts[0].z - d0.z * CAM_BACK
  );

  els.status.classList.add("hidden");

  // Controls
  els.playpause.addEventListener("click", () => {
    if (traveled >= totalLength) {
      traveled = 0; // replay
      playing = true;
      APP.Arrival.hide();
    } else {
      playing = !playing;
    }
    els.playpause.textContent = playing ? "⏸" : "▶";
  });
  APP.Arrival.init({
    summary: routeName,
    onReplay: () => {
      traveled = 0;
      playing = true;
      els.playpause.textContent = "⏸";
    },
  });
  els.speed.addEventListener("input", () => {
    speedKmh = parseFloat(els.speed.value);
    els.speedVal.textContent = `${speedKmh} km/h`;
  });
  els.toggleStops.addEventListener("click", () => {
    stopsVisible = !stopsVisible;
    stopGroup.visible = stopsVisible;
    els.toggleStops.classList.toggle("active", stopsVisible);
    els.toggleStops.setAttribute("aria-pressed", String(stopsVisible));
    if (!stopsVisible) {
      lastStop = null;
      els.banner.classList.remove("show");
      els.progressPanel.classList.add("hidden");
    }
  });
  els.toggleMinimap.addEventListener("click", () => {
    const visible = els.minimap.classList.toggle("hidden") === false;
    els.toggleMinimap.classList.toggle("active", visible);
    els.toggleMinimap.setAttribute("aria-pressed", String(visible));
  });
  if (els.mapStyle) {
    // Change the base map type: re-texture the ground, retint sky/fog, sync minimap.
    els.mapStyle.addEventListener("change", async () => {
      mapStyle = els.mapStyle.value;
      const sky = mapStyle === "dark" ? 0x15151a : 0x87ceeb;
      scene.background = new THREE.Color(sky);
      scene.fog = new THREE.Fog(sky, 400, 1600);
      minimap.setStyle(mapStyle);
      const prev = ground;
      ground = await buildGround(geo.bounds, origin, mapStyle);
      scene.add(ground);
      scene.remove(prev);
      prev.geometry.dispose();
      if (prev.material.map) prev.material.map.dispose();
      prev.material.dispose();
    });
  }

  // Jump the ride to a fraction f (0..1) of the route and refresh every readout.
  function seekTo(f) {
    f = Math.min(1, Math.max(0, f));
    traveled = f * totalLength;
    els.progress.style.width = `${(f * 100).toFixed(1)}%`;
    // Leaving the end clears the "replay" state so the icon reflects play/pause.
    if (traveled < totalLength) {
      els.playpause.textContent = playing ? "⏸" : "▶";
      APP.Arrival.hide();
    }
    const busPos = placeAt(f);
    updateStopBanner(busPos);
    updateStopProgress(f);
    minimap.update(RP.metersToLonLat({ x: busPos.x, z: busPos.z }, origin));
  }

  // Scrub: click or drag along the progress bar to jump anywhere in the ride.
  function scrubTo(clientX) {
    const rect = els.progressWrap.getBoundingClientRect();
    seekTo((clientX - rect.left) / rect.width);
  }

  // Skip to the previous / next stop along the route (dir -1 / +1).
  function jumpStop(dir) {
    if (!stopList.length) return;
    const u = totalLength > 0 ? traveled / totalLength : 0;
    const eps = 0.004;
    let target;
    if (dir > 0) {
      const nx = stopList.find((s) => s.t > u + eps);
      target = nx ? nx.t : 1;
    } else {
      let pv = null;
      for (const s of stopList) {
        if (s.t < u - eps) pv = s;
        else break;
      }
      target = pv ? pv.t : 0;
    }
    seekTo(target);
  }
  els.prevStop.addEventListener("click", () => jumpStop(-1));
  els.nextStop.addEventListener("click", () => jumpStop(1));
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

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (playing && !scrubbing && traveled < totalLength) {
      traveled = Math.min(traveled + kmhToMs(speedKmh) * dt, totalLength);
      if (traveled >= totalLength) {
        playing = false;
        els.playpause.textContent = "↻";
        APP.Arrival.show();
      }
    }
    const u = totalLength > 0 ? traveled / totalLength : 0;
    const busPos = placeAt(u);
    updateStopBanner(busPos);
    updateStopProgress(u);
    minimap.update(RP.metersToLonLat({ x: busPos.x, z: busPos.z }, origin));
    els.progress.style.width = `${(u * 100).toFixed(1)}%`;
    renderer.render(scene, camera);
  }
  animate();
}

main();
