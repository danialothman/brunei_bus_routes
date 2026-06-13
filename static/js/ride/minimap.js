// Shared minimap overlay for both ride modes: a small north-up OSM slippy map
// of the route area with the route line and a live bus heading arrow on top.
// It fetches real OSM tiles for the currently-visible window (centred on the
// bus once zoomed in), so zooming in re-fetches higher-zoom tiles and stays
// sharp at any level instead of upscaling a fixed bitmap. Pure canvas + SVG —
// no mapping library, identical in the Three.js and MapLibre rides.
window.APP = window.APP || {};

APP.Minimap = class {
  /**
   * @param {HTMLElement} container - element to render into
   * @param {number[][]} drivePath - [[lon,lat], ...]
   * @param {object} bounds - {minLon, minLat, maxLon, maxLat}
   * @param {string} color - route color
   * @param {Array} [stops] - stop positions ([{lon,lat}] or [[lon,lat]])
   * @param {string[]} [pathColors] - per-point colours (parallel to drivePath),
   *   so a planned trip's line is drawn in each leg's colour
   */
  constructor(container, drivePath, bounds, color, stops, pathColors) {
    this.container = container;
    this.drivePath = drivePath;
    this.color = color;
    this.runs = this._computeRuns(pathColors); // null for a single-colour line
    this.stops = (stops || []).map((s) => (Array.isArray(s) ? s : [s.lon, s.lat]));
    this.W = 180;
    this.H = 180;
    this.heading = 0;
    this.lastLonLat = null;
    this.tiles = new Map(); // "z/x/y" -> Image (tile cache across frames/zooms)
    this._rafPending = false;
    this._routeKey = null;

    this.cosLat = Math.cos(
      (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180
    );
    this.routeCenter = [
      (bounds.minLon + bounds.maxLon) / 2,
      (bounds.minLat + bounds.maxLat) / 2,
    ];

    // Fixed zoom range: z7 is the furthest the user can zoom out, z19 is OSM's
    // max detail, and we open at z15 (street-ish level following the bus).
    this.minZoom = 7;
    this.maxZoom = 19;
    this.defaultZoom = 15;
    this.zoom = this.defaultZoom;

    this._buildDom();
    this.update(drivePath[0]);
  }

  // --- Web Mercator world-pixel projection (256px tiles) ----------------------
  _worldX(lon, z) {
    return ((lon + 180) / 360) * 2 ** z * 256;
  }
  _worldY(lat, z) {
    const r = (lat * Math.PI) / 180;
    return (
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
      2 ** z *
      256
    );
  }

  // Contiguous same-colour spans of the path -> one polyline each. Returns null
  // for a single colour (plain route), so the simple one-line path is used.
  _computeRuns(pathColors) {
    if (!Array.isArray(pathColors) || pathColors.length !== this.drivePath.length) {
      return null;
    }
    const runs = [];
    let start = 0;
    for (let i = 1; i <= pathColors.length; i++) {
      if (i === pathColors.length || pathColors[i] !== pathColors[start]) {
        runs.push({ start, end: i - 1, color: pathColors[start] });
        start = i;
      }
    }
    // Extend each run onto the next run's first point so colours meet with no gap.
    for (let k = 0; k < runs.length - 1; k++) runs[k].end = runs[k + 1].start;
    return runs.length > 1 ? runs : null;
  }

  _buildDom() {
    const { container, W, H, color } = this;
    container.innerHTML = "";

    // Tile canvas (retina-aware so tiles render crisply).
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.ratio = ratio;
    const canvas = document.createElement("canvas");
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    container.appendChild(canvas);
    this.ctx = canvas.getContext("2d");

    // SVG overlay (route + start dot + bus arrow), drawn in box pixel coords.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";

    const mk = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    };

    this.casing = mk("polyline", {
      fill: "none",
      stroke: "#fff",
      "stroke-width": "4.5",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      opacity: "0.85",
    });
    svg.appendChild(this.casing);

    // Route line: one polyline per leg colour for a planned trip, else a single
    // line. _drawRoute fills in their points (sliced per run) each frame.
    const routeAttrs = (stroke) => ({
      fill: "none",
      stroke,
      "stroke-width": "2.5",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    if (this.runs) {
      this.routeEls = this.runs.map((run) =>
        svg.appendChild(mk("polyline", routeAttrs(run.color)))
      );
    } else {
      this.route = mk("polyline", routeAttrs(color));
      svg.appendChild(this.route);
    }

    // Stop dots (over the route line, under the start dot + bus arrow).
    this.stopsGroup = mk("g", {});
    this.stopEls = this.stops.map(() => {
      const c = mk("circle", {
        r: "2.4",
        fill: color,
        stroke: "#fff",
        "stroke-width": "1",
      });
      this.stopsGroup.appendChild(c);
      return c;
    });
    svg.appendChild(this.stopsGroup);

    this.startDot = mk("circle", {
      r: "3",
      fill: "#fff",
      stroke: color,
      "stroke-width": "1.5",
    });
    svg.appendChild(this.startDot);

    this.busGroup = mk("g", {});
    this.busGroup.appendChild(
      mk("path", {
        d: "M 0 -7 L 5 6 L 0 3 L -5 6 Z",
        fill: "#111",
        stroke: "#fff",
        "stroke-width": "1",
      })
    );
    svg.appendChild(this.busGroup);
    container.appendChild(svg);

    // Zoom controls (rendered by the widget so both rides get them for free).
    const zoomCtl = document.createElement("div");
    zoomCtl.className = "minimap-zoom";
    const mkBtn = (label, title, delta) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", () => this._zoomBy(delta));
      return btn;
    };
    zoomCtl.appendChild(mkBtn("+", "Zoom in", 1));
    // Reset button — only shown once the user has changed the zoom.
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "minimap-zoom-reset hidden";
    this.resetBtn.textContent = "⟲";
    this.resetBtn.title = "Reset zoom";
    this.resetBtn.addEventListener("click", () => this._resetZoom());
    zoomCtl.appendChild(this.resetBtn);
    zoomCtl.appendChild(mkBtn("−", "Zoom out", -1));
    container.appendChild(zoomCtl);

    // Tiny OSM attribution.
    const attr = document.createElement("div");
    attr.textContent = "© OSM";
    attr.style.cssText =
      "position:absolute;right:2px;bottom:1px;font-size:8px;color:#333;" +
      "background:rgba(255,255,255,0.6);padding:0 2px;border-radius:2px;";
    container.appendChild(attr);
  }

  _zoomBy(delta) {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta));
    if (z === this.zoom) return;
    this.zoom = z;
    this._routeKey = null; // force route re-projection at the new zoom
    this._updateResetBtn();
    this._render();
  }

  _resetZoom() {
    if (this.zoom === this.defaultZoom) return;
    this.zoom = this.defaultZoom;
    this._routeKey = null;
    this._updateResetBtn();
    this._render();
  }

  // The reset button only appears once the zoom differs from the default.
  _updateResetBtn() {
    if (!this.resetBtn) return;
    this.resetBtn.classList.toggle("hidden", this.zoom === this.defaultZoom);
  }

  /**
   * Move the bus marker. Heading is derived from movement unless provided.
   * @param {number[]} lonLat - [lon, lat]
   * @param {number} [headingDeg] - optional bearing override
   */
  update(lonLat, headingDeg) {
    if (!lonLat) return;
    if (headingDeg != null) {
      this.heading = headingDeg;
    } else if (this.lastLonLat) {
      const east = (lonLat[0] - this.lastLonLat[0]) * this.cosLat;
      const north = lonLat[1] - this.lastLonLat[1];
      if (Math.abs(east) > 1e-9 || Math.abs(north) > 1e-9) {
        this.heading = (Math.atan2(east, north) * 180) / Math.PI;
      }
    }
    this.lastLonLat = lonLat;
    this._render();
  }

  // Draw the current view: tiles, route, start dot, bus arrow.
  _render() {
    const Z = this.zoom;
    // Zoomed in → follow the bus; at overview zoom → show the whole route.
    const center =
      Z > this.minZoom && this.lastLonLat ? this.lastLonLat : this.routeCenter;
    this._originX = this._worldX(center[0], Z) - this.W / 2;
    this._originY = this._worldY(center[1], Z) - this.H / 2;

    this._drawTiles();
    this._drawRoute();
    this._drawBus();
  }

  _drawTiles() {
    const ctx = this.ctx;
    const Z = this.zoom;
    const oX = this._originX;
    const oY = this._originY;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.fillStyle = "#dfe3e8";
    ctx.fillRect(0, 0, this.W, this.H);

    const tilesPerSide = 2 ** Z;
    const x0 = Math.floor(oX / 256);
    const x1 = Math.floor((oX + this.W) / 256);
    const y0 = Math.floor(oY / 256);
    const y1 = Math.floor((oY + this.H) / 256);
    const subs = ["a", "b", "c"];

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= tilesPerSide) continue;
        const tx = ((x % tilesPerSide) + tilesPerSide) % tilesPerSide; // wrap lon
        const dx = x * 256 - oX;
        const dy = y * 256 - oY;
        const key = `${Z}/${tx}/${y}`;
        let img = this.tiles.get(key);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous";
          // Redraw once it arrives (next frame would also catch it, but this
          // keeps a paused/overview view from waiting on the ride loop).
          img.onload = () => this._scheduleDraw();
          img.src = `https://${subs[(tx + y) % 3]}.tile.openstreetmap.org/${Z}/${tx}/${y}.png`;
          this.tiles.set(key, img);
        }
        if (img.complete && img.naturalWidth) {
          ctx.drawImage(img, dx, dy, 256, 256);
        }
      }
    }
  }

  _scheduleDraw() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._drawTiles();
    });
  }

  _drawRoute() {
    const Z = this.zoom;
    const oX = this._originX;
    const oY = this._originY;
    // Within a zoom level the projection is just a translation, so skip the
    // re-projection work when neither zoom nor (rounded) origin changed.
    const key = `${Z}:${Math.round(oX)}:${Math.round(oY)}`;
    if (key === this._routeKey) return;
    this._routeKey = key;

    const proj = new Array(this.drivePath.length);
    let pts = "";
    for (let i = 0; i < this.drivePath.length; i++) {
      const [lon, lat] = this.drivePath[i];
      const x = this._worldX(lon, Z) - oX;
      const y = this._worldY(lat, Z) - oY;
      proj[i] = `${x.toFixed(1)},${y.toFixed(1)}`;
      pts += proj[i] + " ";
    }
    this.casing.setAttribute("points", pts);
    if (this.runs) {
      for (let k = 0; k < this.runs.length; k++) {
        const run = this.runs[k];
        this.routeEls[k].setAttribute("points", proj.slice(run.start, run.end + 1).join(" "));
      }
    } else {
      this.route.setAttribute("points", pts);
    }

    const s = this.drivePath[0];
    this.startDot.setAttribute("cx", (this._worldX(s[0], Z) - oX).toFixed(1));
    this.startDot.setAttribute("cy", (this._worldY(s[1], Z) - oY).toFixed(1));

    for (let i = 0; i < this.stops.length; i++) {
      const [lon, lat] = this.stops[i];
      this.stopEls[i].setAttribute("cx", (this._worldX(lon, Z) - oX).toFixed(1));
      this.stopEls[i].setAttribute("cy", (this._worldY(lat, Z) - oY).toFixed(1));
    }
  }

  _drawBus() {
    if (!this.lastLonLat) return;
    const x = this._worldX(this.lastLonLat[0], this.zoom) - this._originX;
    const y = this._worldY(this.lastLonLat[1], this.zoom) - this._originY;
    this.busGroup.setAttribute(
      "transform",
      `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${this.heading.toFixed(1)})`
    );
  }
};
