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

  /**
   * Fetch parsed route geometry from the backend.
   * @param {string} routeFile - KML filename
   * @returns {Promise<{segments:number[][][], stops:object[], bounds:object, name:string}>}
   */
  async fetchGeometry(routeFile) {
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
