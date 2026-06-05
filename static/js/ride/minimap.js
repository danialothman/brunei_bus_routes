// Shared minimap overlay for both ride modes: a small north-up OSM map of the
// route area with the route line and a live bus heading arrow on top. Uses
// web-mercator projection so the route overlays the tiles exactly. Pure
// canvas + SVG — no mapping library, identical in the Three.js and MapLibre rides.
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
    const margin = 8;
    this.heading = 0;
    this.lastLonLat = null;
    this.cosLat = Math.cos(
      (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180
    );

    // Pad the route bbox so we see some surroundings.
    const padLon = (bounds.maxLon - bounds.minLon) * 0.14 + 0.001;
    const padLat = (bounds.maxLat - bounds.minLat) * 0.14 + 0.001;
    const b = {
      minLon: bounds.minLon - padLon,
      maxLon: bounds.maxLon + padLon,
      minLat: bounds.minLat - padLat,
      maxLat: bounds.maxLat + padLat,
    };

    // Highest zoom where the area fits in a small tile grid (≤3 per side).
    const z = this._chooseZoom(b, 3);
    const x0 = this._lon2tx(b.minLon, z);
    const x1 = this._lon2tx(b.maxLon, z);
    const y0 = this._lat2ty(b.maxLat, z); // north
    const y1 = this._lat2ty(b.minLat, z); // south

    // Fit the tile-grid pixel rect into the box, preserving aspect.
    const pxMinX = x0 * 256;
    const pxMinY = y0 * 256;
    const gridW = (x1 - x0 + 1) * 256;
    const gridH = (y1 - y0 + 1) * 256;
    const scale = Math.min((W - 2 * margin) / gridW, (H - 2 * margin) / gridH);
    const offX = (W - gridW * scale) / 2;
    const offY = (H - gridH * scale) / 2;

    const pow = 2 ** z;
    this.project = (lon, lat) => {
      const wx = ((lon + 180) / 360) * pow * 256;
      const r = (lat * Math.PI) / 180;
      const wy =
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
        pow *
        256;
      return {
        x: offX + (wx - pxMinX) * scale,
        y: offY + (wy - pxMinY) * scale,
      };
    };

    container.innerHTML = "";

    // 1) Canvas tile background
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;";
    container.appendChild(canvas);
    this._drawTiles(canvas, z, x0, x1, y0, y1, scale, offX, offY, pxMinX, pxMinY);

    // 2) SVG overlay (route + bus), exactly aligned to the tiles
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";

    const points = drivePath
      .map(([lon, lat]) => {
        const p = this.project(lon, lat);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(" ");

    // White casing under the colored route for contrast over the map.
    const casing = document.createElementNS(NS, "polyline");
    casing.setAttribute("points", points);
    casing.setAttribute("fill", "none");
    casing.setAttribute("stroke", "#fff");
    casing.setAttribute("stroke-width", "4.5");
    casing.setAttribute("stroke-linejoin", "round");
    casing.setAttribute("stroke-linecap", "round");
    casing.setAttribute("opacity", "0.85");
    svg.appendChild(casing);

    const route = document.createElementNS(NS, "polyline");
    route.setAttribute("points", points);
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

    this.busGroup = document.createElementNS(NS, "g");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M 0 -7 L 5 6 L 0 3 L -5 6 Z");
    arrow.setAttribute("fill", "#111");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1");
    this.busGroup.appendChild(arrow);
    svg.appendChild(this.busGroup);

    container.appendChild(svg);

    // Tiny OSM attribution.
    const attr = document.createElement("div");
    attr.textContent = "© OSM";
    attr.style.cssText =
      "position:absolute;right:2px;bottom:1px;font-size:8px;color:#333;" +
      "background:rgba(255,255,255,0.6);padding:0 2px;border-radius:2px;";
    container.appendChild(attr);

    this.update(drivePath[0]);
  }

  _lon2tx(lon, z) {
    return Math.floor(((lon + 180) / 360) * 2 ** z);
  }

  _lat2ty(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
    );
  }

  _chooseZoom(b, maxPerSide) {
    for (let z = 18; z >= 8; z--) {
      const cols = this._lon2tx(b.maxLon, z) - this._lon2tx(b.minLon, z) + 1;
      const rows = this._lat2ty(b.minLat, z) - this._lat2ty(b.maxLat, z) + 1;
      if (cols <= maxPerSide && rows <= maxPerSide) return z;
    }
    return 11;
  }

  _drawTiles(canvas, z, x0, x1, y0, y1, scale, offX, offY, pxMinX, pxMinY) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#dfe3e8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const size = 256 * scale;
    const subs = ["a", "b", "c"];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const dx = offX + (x * 256 - pxMinX) * scale;
        const dy = offY + (y * 256 - pxMinY) * scale;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => ctx.drawImage(img, dx, dy, size, size);
        img.src = `https://${subs[(x + y) % 3]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
      }
    }
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
