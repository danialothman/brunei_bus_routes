window.APP = window.APP || {};

// Point/reference layers (no single drive path) — not offered for 3D ride.
const NON_ROUTE = /^(Points - |Landmarks\b|Road\b|intradistrict\b|ANNEX\b)/i;

APP.RouteManager = class {
  /**
   * Manages every route layer across all years. Each route is identified by a
   * composite id "<year>::<file>" so the same filename can exist per year.
   * @param {ol.Map} map
   */
  constructor(map) {
    this.map = map;
    this.layers = new Map(); // id -> ol.layer.Vector (cached, may be hidden)
    this.colors = new Map(); // id -> color
    this.meta = new Map(); // id -> { year, file, kind }
    this.loadingFiles = new Set();
  }

  init() {
    this.setupControls();
    this.loadCatalog();
  }

  _id(year, file) {
    return `${year}::${file}`;
  }
  _q(year) {
    return `?year=${encodeURIComponent(year)}`;
  }

  // --- loading spinner -------------------------------------------------------
  showLoading(id) {
    this.loadingFiles.add(id);
    this.updateSpinner();
  }
  hideLoading(id, forced = false) {
    if (forced) this.loadingFiles.clear();
    else this.loadingFiles.delete(id);
    this.updateSpinner();
  }
  updateSpinner() {
    if (this.loadingFiles.size > 0) $("#loading").show();
    else $("#loading").hide();
  }

  isVisible(id) {
    const layer = this.layers.get(id);
    return !!layer && layer.getVisible();
  }

  maybeZoomTo(layer) {
    const otherVisible = Array.from(this.layers.values()).some(
      (l) => l !== layer && l.getVisible()
    );
    if (otherVisible) return;
    const extent = layer.getSource().getExtent();
    if (!extent || !isFinite(extent[0])) return;
    this.map.getView().fit(extent, {
      padding: [50, 50, 50, 50],
      maxZoom: 16,
      duration: 1000,
    });
  }

  // --- layer construction ----------------------------------------------------
  createVectorSource(id) {
    const m = this.meta.get(id);
    if (m.kind === "geojson") {
      return new ol.source.Vector({
        url: `/data/geojson/${m.file}${this._q(m.year)}`,
        format: new ol.format.GeoJSON({
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        }),
      });
    }
    return new ol.source.Vector({
      url: `/data/kml/${m.file}${this._q(m.year)}`,
      format: new ol.format.KML({
        extractStyles: false,
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
  }

  createVectorLayer(id) {
    const m = this.meta.get(id);
    const color = this.colors.get(id) || APP.MAP_CONFIG.ROUTE_STYLE.stroke.color;
    const source = this.createVectorSource(id);
    let layer;
    if (m.kind === "geojson") {
      layer = new ol.layer.Vector({
        source: source,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({ color, width: 3, lineDash: [6, 6] }),
        }),
      });
    } else {
      const { stroke, point } = APP.MAP_CONFIG.ROUTE_STYLE;
      layer = new ol.layer.Vector({
        source: source,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({ color, width: stroke.width }),
          image: new ol.style.Circle({
            radius: point.radius,
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke(point.stroke),
          }),
        }),
      });
    }
    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading ${id}`);
      this.hideLoading(id);
    });
    source.on("change", () => {
      if (source.getState() === "ready") {
        // Tag each feature with its route context so the stop info panel can
        // look up photos for the clicked stop (year + route file + coords).
        source.getFeatures().forEach((f) => {
          f.set("routeYear", m.year, true);
          f.set("routeFile", m.file, true);
        });
        if (source.getFeatures().length > 0 && layer.getVisible()) {
          this.maybeZoomTo(layer);
        }
        this.hideLoading(id);
      }
    });
    return layer;
  }

  enableRoute(id) {
    let layer = this.layers.get(id);
    if (layer) {
      layer.setVisible(true);
      this.maybeZoomTo(layer);
      return;
    }
    this.showLoading(id);
    layer = this.createVectorLayer(id);
    this.layers.set(id, layer);
    this.map.addLayer(layer);
  }

  disableRoute(id) {
    const layer = this.layers.get(id);
    if (layer) layer.setVisible(false);
    this.hideLoading(id);
  }

  toggleRoute(id) {
    if (this.isVisible(id)) this.disableRoute(id);
    else this.enableRoute(id);
  }

  showAll() {
    $("#routes input").each((_, el) => {
      if (!el.checked) {
        el.checked = true;
        this.enableRoute(el.value);
      }
    });
  }

  clearAll() {
    $("#routes input").each((_, el) => {
      el.checked = false;
    });
    this.layers.forEach((layer) => layer.setVisible(false));
    this.hideLoading(null, true);
  }

  setupControls() {
    $("#routes").on("click", "input", (e) => {
      try {
        this.toggleRoute(e.target.value);
      } catch (error) {
        APP.MapUtils.handleError(error, "Route toggle");
        this.hideLoading(null, true);
      }
    });
    $("#routes").on("click", ".route-del-btn", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = $(e.currentTarget);
      this.deleteUserRoute(el.attr("data-year"), el.attr("data-file"));
    });
    $("#showAll").on("click", () => this.showAll());
    $("#clearAll").on("click", () => this.clearAll());
  }

  /** Delete a user-created route (DB-only) after confirmation. */
  deleteUserRoute(year, file) {
    if (!confirm("Delete this route? This removes it and all its versions.")) {
      return;
    }
    fetch(`/data/edit/${encodeURIComponent(file)}?year=${encodeURIComponent(year)}`, {
      method: "DELETE",
    })
      .then((r) => r.json())
      .then(() => this.removeRouteRow(year, file, "kml"))
      .catch((e) => APP.MapUtils.handleError(e, "Deleting route"));
  }

  // --- sidebar rendering -----------------------------------------------------
  _row(id, color, displayName, meta, isUser) {
    const label = $("<label></label>").addClass("list-group-item route-item");
    if (isUser) label.addClass("user-route");
    const input = $('<input type="checkbox">').val(id);
    const swatch = $('<span class="route-swatch"></span>').css(
      "background-color",
      color
    );
    const name = $('<span class="route-name"></span>').text(displayName);
    const attrs = {
      "data-file": meta.file,
      "data-kind": meta.kind,
      "data-year": meta.year,
    };
    label.append(input).append(swatch).append(name);
    const isRouteLike = !NON_ROUTE.test(meta.file);
    if (isRouteLike) {
      label.append($('<a class="route-ride-btn" title="3D ride">🚌</a>').attr(attrs));
    }
    // Editing actions (edit/delete user routes, copy shipped routes) live in the
    // GTFS workbench, not the homepage list — the homepage stays view-only.
    return label;
  }

  loadCatalog() {
    fetch("/data/catalog")
      .then((r) => r.json())
      .then((cat) => {
        const out = $("#routes").empty();
        this.colors.clear();
        this.meta.clear();
        // Copy/create is only possible when the user-route dataset exists.
        this.canCreateUserRoutes =
          (cat.years || []).indexOf(APP.USER_ROUTE_YEAR) >= 0;
        const palette = APP.ROUTE_COLORS;
        let i = 0;
        const header = (text) => {
          const el = $('<div class="route-group"></div>').text(text);
          out.append(el);
          return el;
        };
        const addRow = (year, file, kind, isUser, names) => {
          const id = this._id(year, file);
          const color = palette[i++ % palette.length];
          this.colors.set(id, color);
          this.meta.set(id, { year, file, kind });
          const ext = kind === "geojson" ? ".geojson" : ".kml";
          out.append(
            this._row(id, color, names[file] || file.replace(ext, ""), { year, file, kind }, isUser)
          );
        };
        // User-created routes first (top of the list).
        (cat.years || []).forEach((year) => {
          const d = cat[year] || {};
          if (d.user && d.user.length) {
            header("My routes");
            d.user.forEach((f) => addRow(year, f, "kml", true, d.names || {}));
          }
        });
        // Then shipped routes + geojson paths, per year. Each shipped (official)
        // year shows its source credit right under its first group header, so
        // it's not implied for user routes and isn't buried below the list.
        (cat.years || []).forEach((year) => {
          const d = cat[year] || {};
          const names = d.names || {};
          const official = year !== APP.USER_ROUTE_YEAR;
          // Add an ⓘ toggle to each official group header; clicking it shows/hides
          // a source-credit callout under that header.
          const maybeCredit = (headerEl, what) => {
            if (!official) return;
            const note = $('<div class="route-credit" style="display:none"></div>').text(
              `${year} ${what}: data from Land Transport Department docs `
              + "provided for the EOI for the Provision of Public Bus Services."
            );
            const icon = $(
              '<button type="button" class="route-credit-info" aria-expanded="false"'
              + ' title="Data source"></button>'
            ).text("ⓘ");
            icon.on("click", () => {
              const show = !note.is(":visible");
              note.toggle(show);
              icon.attr("aria-expanded", String(show)).toggleClass("is-open", show);
            });
            headerEl.append(icon);
            headerEl.after(note);
          };
          if (d.routes && d.routes.length) {
            maybeCredit(header(`${year} · Routes & Stops`), "routes & stops");
            d.routes.forEach((f) => addRow(year, f, "kml", false, names));
          }
          if (d.geojson && d.geojson.length) {
            maybeCredit(header(`${year} · GeoJSON paths`), "paths");
            d.geojson.forEach((f) => addRow(year, f, "geojson", false, names));
          }
        });
        // New-route creation is only offered when the user-route dataset exists.
        $("#newRouteBtn").toggle(this.canCreateUserRoutes);
      })
      .catch((e) => APP.MapUtils.handleError(e, "Loading catalog"));
  }

  // --- editor coordination ---------------------------------------------------
  reloadRoute(year, file, kind = "kml") {
    const id = this._id(year, file);
    const layer = this.layers.get(id);
    if (layer) {
      this.map.removeLayer(layer);
      this.layers.delete(id);
    }
    const checked = $("#routes input")
      .filter((_, el) => el.value === id)
      .prop("checked");
    if (checked) this.enableRoute(id);
  }

  hideRouteForEdit(year, file, kind = "kml") {
    const layer = this.layers.get(this._id(year, file));
    if (layer) layer.setVisible(false);
  }

  showRouteAfterEdit(year, file, kind = "kml") {
    const id = this._id(year, file);
    const layer = this.layers.get(id);
    const checked = $("#routes input")
      .filter((_, el) => el.value === id)
      .prop("checked");
    if (layer && checked) layer.setVisible(true);
  }

  setRouteDisplayName(year, file, name, kind = "kml") {
    const id = this._id(year, file);
    const fallback = file.replace(/\.(kml|geojson)$/, "");
    $("#routes input")
      .filter((_, el) => el.value === id)
      .siblings(".route-name")
      .text(name || fallback);
  }

  addUserRouteRow(year, file, displayName) {
    const id = this._id(year, file);
    if ($("#routes input").filter((_, el) => el.value === id).length) {
      this.setRouteDisplayName(year, file, displayName);
      return;
    }
    const color = APP.ROUTE_COLORS[this.colors.size % APP.ROUTE_COLORS.length];
    this.colors.set(id, color);
    this.meta.set(id, { year, file, kind: "kml" });
    const row = this._row(id, color, displayName, { year, file, kind: "kml" }, true);
    row.find("input").prop("checked", true);
    // Place under the "My routes" header (creating it at the top if needed).
    const headerText = "My routes";
    let headerEl = $("#routes .route-group").filter(
      (_, el) => $(el).text() === headerText
    );
    if (!headerEl.length) {
      headerEl = $('<div class="route-group"></div>').text(headerText);
      $("#routes").prepend(headerEl);
    }
    headerEl.after(row);
  }

  removeRouteRow(year, file, kind = "kml") {
    const id = this._id(year, file);
    const layer = this.layers.get(id);
    if (layer) {
      this.map.removeLayer(layer);
      this.layers.delete(id);
    }
    this.colors.delete(id);
    this.meta.delete(id);
    $("#routes input")
      .filter((_, el) => el.value === id)
      .closest("label")
      .remove();
  }
};
