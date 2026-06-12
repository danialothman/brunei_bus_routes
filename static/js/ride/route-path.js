// Shared geometry helpers for the 3D ride-along modes (Three.js + MapLibre).
// Pure data — no rendering-library dependency — so both engines treat the
// route identically. Attaches to the existing window.APP namespace.
window.APP = window.APP || {};

APP.RidePath = {
  // Meters per degree of latitude (good enough for city-scale local projection).
  METERS_PER_DEG: 111320,

  /**
   * Read the chosen route file from the page query string (?route=...).
   * @returns {string|null}
   */
  routeFromQuery() {
    return new URLSearchParams(window.location.search).get("route");
  },

  // Pseudo-route name + sessionStorage key for riding a journey planned on
  // /planner: the planner stores ride-shaped geometry, then navigates here.
  TRIP_PREVIEW: "trip-preview",

  /**
   * Fetch parsed route geometry from the backend (or, for the planner's
   * trip preview, from sessionStorage).
   * @param {string} routeFile - KML filename
   * @returns {Promise<{segments:number[][][], stops:object[], bounds:object, name:string}>}
   */
  async fetchGeometry(routeFile) {
    if (routeFile === this.TRIP_PREVIEW) {
      const raw = sessionStorage.getItem(this.TRIP_PREVIEW);
      if (!raw) {
        throw new Error("No planned trip to preview");
      }
      return JSON.parse(raw);
    }
    const year = new URLSearchParams(window.location.search).get("year");
    const yq = year ? `?year=${encodeURIComponent(year)}` : "";
    const res = await fetch(
      `/data/route-geometry/${encodeURIComponent(routeFile)}${yq}`
    );
    if (!res.ok) {
      throw new Error(`Geometry fetch failed (${res.status})`);
    }
    return res.json();
  },

  /**
   * The longest segment is the main drive path (numbered routes have one).
   * @param {number[][][]} segments
   * @returns {number[][]} array of [lon, lat]
   */
  pickDrivePath(segments) {
    if (!segments || !segments.length) {
      return [];
    }
    return segments.reduce((a, b) => (b.length > a.length ? b : a));
  },

  /**
   * Projection origin = center of the route bounds.
   * @param {object} bounds - {minLon, minLat, maxLon, maxLat}
   * @returns {{lon:number, lat:number}}
   */
  originFromBounds(bounds) {
    return {
      lon: (bounds.minLon + bounds.maxLon) / 2,
      lat: (bounds.minLat + bounds.maxLat) / 2,
    };
  },

  /**
   * Project [lon, lat] to local meters relative to an origin.
   * East = +x, North = -z (so it maps naturally onto a Three.js XZ ground).
   * @param {number[]} lonLat - [lon, lat]
   * @param {{lon:number, lat:number}} origin
   * @returns {{x:number, z:number}}
   */
  lonLatToMeters(lonLat, origin) {
    const mPerDegLon =
      this.METERS_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
    return {
      x: (lonLat[0] - origin.lon) * mPerDegLon,
      z: -(lonLat[1] - origin.lat) * this.METERS_PER_DEG,
    };
  },

  /**
   * Inverse of lonLatToMeters: local meters back to [lon, lat].
   * @param {{x:number, z:number}} m
   * @param {{lon:number, lat:number}} origin
   * @returns {number[]} [lon, lat]
   */
  metersToLonLat(m, origin) {
    const mPerDegLon =
      this.METERS_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
    return [origin.lon + m.x / mPerDegLon, origin.lat - m.z / this.METERS_PER_DEG];
  },

  /**
   * Project a whole path of [lon, lat] points to local meters.
   * @param {number[][]} points
   * @param {{lon:number, lat:number}} origin
   * @returns {{x:number, z:number}[]}
   */
  pathToMeters(points, origin) {
    return points.map((p) => this.lonLatToMeters(p, origin));
  },

  /**
   * Project each named stop onto the drive path and return its position as a
   * fraction (0..1) of the route's length, sorted along the route. Used to tell
   * which stop is behind vs. ahead of the bus regardless of engine/units.
   * Planar approximation (lon scaled by cos(lat)) — fine at city scale; we only
   * need relative ordering, not true geodesic distance.
   * @param {number[][]} drivePath - array of [lon, lat]
   * @param {object[]} stops - [{name, lon, lat}]
   * @returns {{name:string, t:number}[]}
   */
  stopProgressList(drivePath, stops) {
    if (!drivePath || drivePath.length < 2) return [];
    const kx = Math.cos((drivePath[0][1] * Math.PI) / 180); // lon→x scale
    const P = drivePath.map(([lon, lat]) => [lon * kx, lat]);
    const cum = [0];
    for (let i = 1; i < P.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    }
    const total = cum[cum.length - 1] || 1;
    const out = [];
    (stops || []).forEach((s) => {
      if (!s.name) return;
      const sx = s.lon * kx;
      const sy = s.lat;
      let bestD = Infinity;
      let bestArc = 0;
      for (let i = 0; i < P.length - 1; i++) {
        const ax = P[i][0];
        const ay = P[i][1];
        const dx = P[i + 1][0] - ax;
        const dy = P[i + 1][1] - ay;
        const segLen2 = dx * dx + dy * dy;
        let t = segLen2 ? ((sx - ax) * dx + (sy - ay) * dy) / segLen2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx;
        const py = ay + t * dy;
        const d = (sx - px) ** 2 + (sy - py) ** 2;
        if (d < bestD) {
          bestD = d;
          bestArc = cum[i] + Math.sqrt(segLen2) * t;
        }
      }
      out.push({ name: s.name, t: bestArc / total });
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  },

  /**
   * Given stops sorted by along-route fraction and the bus's current fraction,
   * return the last stop passed and the next stop ahead (either may be null).
   * @param {{name:string, t:number}[]} stopList
   * @param {number} u - current progress fraction (0..1)
   * @returns {{prev:object|null, next:object|null}}
   */
  prevNextStop(stopList, u) {
    let prev = null;
    let next = null;
    for (const s of stopList) {
      if (s.t <= u) prev = s;
      else {
        next = s;
        break;
      }
    }
    return { prev, next };
  },

  /**
   * Travel mode at progress fraction u, from a trip preview's phases
   * ([{mode: "walk"|"ride", t0, t1}] over 0..1). Plain routes have no
   * phases — everything is ridden.
   * @param {{mode:string, t0:number, t1:number}[]|undefined} phases
   * @param {number} u - progress fraction (0..1)
   * @returns {"walk"|"ride"}
   */
  modeAt(phases, u) {
    if (!Array.isArray(phases) || !phases.length) return "ride";
    for (const p of phases) {
      if (u <= p.t1) return p.mode;
    }
    return phases[phases.length - 1].mode;
  },

  /**
   * Pick a stable color for a route from the shared palette, keyed by its
   * leading number so it matches the 2D map's coloring.
   * @param {string} routeFile
   * @returns {string} hex color
   */
  colorFor(routeFile) {
    const palette = (APP.ROUTE_COLORS && APP.ROUTE_COLORS.length
      ? APP.ROUTE_COLORS
      : ["#e6194b"]);
    const match = (routeFile || "").match(/(\d+)/);
    const idx = match ? parseInt(match[1], 10) : 0;
    return palette[idx % palette.length];
  },
};
