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

async function buildGround(bounds, origin) {
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
  ctx.fillStyle = "#e2e5e9";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const subs = ["a", "b", "c"];
  const loads = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const dx = (x - x0) * 256;
      const dy = (y - y0) * 256;
      const url = `https://${subs[(x + y) % 3]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
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
function buildRoad(pts, color) {
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
  // bright centerline in the route color
  const linePts = pts.map((p) => new THREE.Vector3(p.x, 0.4, p.z));
  group.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color })
    )
  );
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

  // Minimap overlay (shared widget) — built early so it shows while tiles load.
  const minimap = new APP.Minimap(
    document.getElementById("minimap"),
    drivePath,
    geo.bounds,
    color
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
  const ground = await buildGround(geo.bounds, origin);
  scene.add(ground);
  scene.add(buildRoad(pts, color));
  const bus = buildBus(color);
  scene.add(bus);
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

  // Ride state
  const TARGET_DURATION = 80; // seconds at 1x for a full route
  const baseSpeed = totalLength / TARGET_DURATION; // m/s
  let traveled = 0;
  let playing = true;
  let speedMul = 1;
  let lastStop = null;

  function placeAt(u) {
    const clamped = Math.min(Math.max(u, 0), 1);
    const p = curve.getPointAt(clamped);
    const tan = curve.getTangentAt(clamped).normalize();
    bus.position.set(p.x, 0, p.z);
    bus.rotation.y = Math.atan2(tan.x, tan.z);
    const desired = new THREE.Vector3(
      p.x - tan.x * 17,
      9,
      p.z - tan.z * 17
    );
    camera.position.lerp(desired, 0.1);
    camera.lookAt(p.x + tan.x * 8, 2.5, p.z + tan.z * 8);
    return p;
  }

  function updateStopBanner(busPos) {
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

  // Position camera instantly before first frame so we don't fly in from origin
  camera.position.set(pts[0].x, 9, pts[0].z + 20);
  placeAt(0);
  camera.position.set(
    pts[0].x - curve.getTangentAt(0).x * 17,
    9,
    pts[0].z - curve.getTangentAt(0).z * 17
  );

  els.status.classList.add("hidden");

  // Controls
  els.playpause.addEventListener("click", () => {
    if (traveled >= totalLength) {
      traveled = 0; // replay
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
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (playing && traveled < totalLength) {
      traveled = Math.min(traveled + baseSpeed * speedMul * dt, totalLength);
      if (traveled >= totalLength) {
        playing = false;
        els.playpause.textContent = "↻";
      }
    }
    const u = totalLength > 0 ? traveled / totalLength : 0;
    const busPos = placeAt(u);
    updateStopBanner(busPos);
    minimap.update(RP.metersToLonLat({ x: busPos.x, z: busPos.z }, origin));
    els.progress.style.width = `${(u * 100).toFixed(1)}%`;
    renderer.render(scene, camera);
  }
  animate();
}

main();
