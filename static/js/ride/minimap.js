// Shared minimap overlay for both ride modes: a small north-up SVG map of the
// full route with a heading arrow marking the bus. No mapping library — pure
// SVG so it works identically in the Three.js and MapLibre rides.
window.APP = window.APP || {};

APP.Minimap = class {
  /**
   * @param {HTMLElement} container - element to render into
   * @param {number[][]} drivePath - [[lon,lat], ...]
   * @param {object} bounds - {minLon, minLat, maxLon, maxLat}
   * @param {string} color - route color
   */
  constructor(container, drivePath, bounds, color) {
    const W = 180;
    const H = 180;
    const pad = 12;
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;
    const cosLat = Math.cos((centerLat * Math.PI) / 180);
    const lonRange = bounds.maxLon - bounds.minLon || 1e-6;
    const latRange = bounds.maxLat - bounds.minLat || 1e-6;
    const scale = Math.min(
      (W - 2 * pad) / (lonRange * cosLat),
      (H - 2 * pad) / latRange
    );
    const offX = (W - lonRange * cosLat * scale) / 2;
    const offY = (H - latRange * scale) / 2;

    this.cosLat = cosLat;
    this.heading = 0;
    this.lastLonLat = null;
    this.project = (lon, lat) => ({
      x: offX + (lon - bounds.minLon) * cosLat * scale,
      y: offY + (bounds.maxLat - lat) * scale, // north up
    });

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    const route = document.createElementNS(NS, "polyline");
    route.setAttribute(
      "points",
      drivePath
        .map(([lon, lat]) => {
          const p = this.project(lon, lat);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(" ")
    );
    route.setAttribute("fill", "none");
    route.setAttribute("stroke", color);
    route.setAttribute("stroke-width", "2.5");
    route.setAttribute("stroke-linejoin", "round");
    route.setAttribute("stroke-linecap", "round");
    svg.appendChild(route);

    const startP = this.project(drivePath[0][0], drivePath[0][1]);
    const startDot = document.createElementNS(NS, "circle");
    startDot.setAttribute("cx", startP.x);
    startDot.setAttribute("cy", startP.y);
    startDot.setAttribute("r", "3");
    startDot.setAttribute("fill", "#fff");
    startDot.setAttribute("stroke", color);
    startDot.setAttribute("stroke-width", "1.5");
    svg.appendChild(startDot);

    // Bus heading arrow (points "up" = north at rotation 0).
    this.busGroup = document.createElementNS(NS, "g");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M 0 -7 L 5 6 L 0 3 L -5 6 Z");
    arrow.setAttribute("fill", "#111");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1");
    this.busGroup.appendChild(arrow);
    svg.appendChild(this.busGroup);

    container.innerHTML = "";
    container.appendChild(svg);

    this.update(drivePath[0]);
  }

  /**
   * Move the bus marker. Heading is derived from movement unless provided.
   * @param {number[]} lonLat - [lon, lat]
   * @param {number} [headingDeg] - optional bearing override
   */
  update(lonLat, headingDeg) {
    if (!lonLat) return;
    const p = this.project(lonLat[0], lonLat[1]);

    if (headingDeg != null) {
      this.heading = headingDeg;
    } else if (this.lastLonLat) {
      const east = (lonLat[0] - this.lastLonLat[0]) * this.cosLat;
      const north = lonLat[1] - this.lastLonLat[1];
      if (Math.abs(east) > 1e-9 || Math.abs(north) > 1e-9) {
        this.heading = (Math.atan2(east, north) * 180) / Math.PI;
      }
    }

    this.busGroup.setAttribute(
      "transform",
      `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${this.heading.toFixed(1)})`
    );
    this.lastLonLat = lonLat;
  }
};
