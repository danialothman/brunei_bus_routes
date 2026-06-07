window.APP = window.APP || {};

APP.RouteManager = class {
  /**
   * @param {ol.Map} map - OpenLayers map instance
   */
  constructor(map) {
    this.map = map;
    this.layers = new Map(); // kmlFile -> ol.layer.Vector (cached, may be hidden)
    this.colors = new Map(); // kmlFile -> assigned color
    this.loadingFiles = new Set(); // kmlFiles with a fetch in flight
    this.year = null; // selected dataset year (set from /data/years)
    this.geojsonLayers = new Map(); // geojsonFile -> ol.layer.Vector
    this.geojsonColors = new Map(); // geojsonFile -> assigned color
  }

  /**
   * Initialize route management
   */
  init() {
    this.setupRouteControls();
    this.setupYearControl(); // populates the picker, then loads the route list
  }

  /**
   * Query-string suffix for the active dataset year (empty if none selected).
   * @returns {string}
   */
  yearQuery() {
    return this.year ? `?year=${encodeURIComponent(this.year)}` : "";
  }

  /**
   * Create vector source for KML file
   * @param {string} kmlFile - KML file name
   * @returns {ol.source.Vector} Vector source
   */
  createVectorSource(kmlFile) {
    return new ol.source.Vector({
      url: `/data/kml/${kmlFile}${this.yearQuery()}`,
      format: new ol.format.KML({
        extractStyles: false,
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
  }

  /**
   * Create vector layer with per-route color styling
   * @param {ol.source.Vector} source - Vector source
   * @param {string} color - Route color
   * @returns {ol.layer.Vector} Vector layer
   */
  createVectorLayer(source, color) {
    const { stroke, point } = APP.MAP_CONFIG.ROUTE_STYLE;
    return new ol.layer.Vector({
      source: source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: color, width: stroke.width }),
        image: new ol.style.Circle({
          radius: point.radius,
          fill: new ol.style.Fill({ color: color }),
          stroke: new ol.style.Stroke(point.stroke),
        }),
      }),
    });
  }

  /**
   * Mark a route as loading and reflect it in the spinner
   * @param {string} kmlFile - Layer identifier
   */
  showLoading(kmlFile) {
    this.loadingFiles.add(kmlFile);
    this.updateSpinner();
  }

  /**
   * Clear a route's loading state (or all of them) and update the spinner
   * @param {string} kmlFile - Layer identifier (ignored when forced)
   * @param {boolean} forced - Force-clear all loading state
   */
  hideLoading(kmlFile, forced = false) {
    if (forced) {
      this.loadingFiles.clear();
    } else {
      this.loadingFiles.delete(kmlFile);
    }
    this.updateSpinner();
  }

  /**
   * Show the loading banner only while something is actually loading
   */
  updateSpinner() {
    if (this.loadingFiles.size > 0) {
      $("#loading").show();
    } else {
      $("#loading").hide();
    }
  }

  /**
   * Whether a route's layer is currently on the map and visible
   * @param {string} kmlFile - KML file name
   * @returns {boolean}
   */
  isVisible(kmlFile) {
    const layer = this.layers.get(kmlFile);
    return !!layer && layer.getVisible();
  }

  /**
   * Zoom to a layer's extent only when it is the sole visible route, so
   * adding a route to an existing selection doesn't yank the camera away.
   * @param {ol.layer.Vector} layer - Vector layer just made visible
   */
  maybeZoomTo(layer) {
    const otherVisible = Array.from(this.layers.values()).some(
      (l) => l !== layer && l.getVisible()
    );
    if (otherVisible) {
      return;
    }
    const extent = layer.getSource().getExtent();
    if (!extent || !isFinite(extent[0])) {
      return;
    }
    this.map.getView().fit(extent, {
      padding: [50, 50, 50, 50],
      maxZoom: 16,
      duration: 1000,
    });
  }

  /**
   * Create and setup route layer
   * @param {string} kmlFile - KML file name
   * @returns {ol.layer.Vector} Vector layer
   */
  createRouteLayer(kmlFile) {
    const color = this.colors.get(kmlFile) || APP.MAP_CONFIG.ROUTE_STYLE.stroke.color;
    const source = this.createVectorSource(kmlFile);
    const layer = this.createVectorLayer(source, color);

    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading KML: ${kmlFile}`);
      this.hideLoading(kmlFile);
    });

    source.on("change", () => {
      if (source.getState() === "ready") {
        const features = source.getFeatures();
        if (features.length > 0 && layer.getVisible()) {
          this.maybeZoomTo(layer);
        }
        this.hideLoading(kmlFile);
      }
    });

    return layer;
  }

  /**
   * Show a route — reusing its cached layer if it was loaded before, so
   * re-enabling never re-fetches the KML over the network.
   * @param {string} kmlFile - KML file name
   */
  enableRoute(kmlFile) {
    let layer = this.layers.get(kmlFile);
    if (layer) {
      layer.setVisible(true);
      this.maybeZoomTo(layer);
      return;
    }
    this.showLoading(kmlFile);
    layer = this.createRouteLayer(kmlFile);
    this.layers.set(kmlFile, layer);
    this.map.addLayer(layer);
  }

  /**
   * Hide a route without destroying its layer (cached for instant re-show)
   * @param {string} kmlFile - KML file name
   */
  disableRoute(kmlFile) {
    const layer = this.layers.get(kmlFile);
    if (layer) {
      layer.setVisible(false);
    }
    this.hideLoading(kmlFile);
  }

  /**
   * Toggle a single route on/off
   * @param {string} kmlFile - KML file name
   */
  toggleRoute(kmlFile) {
    if (this.isVisible(kmlFile)) {
      this.disableRoute(kmlFile);
    } else {
      this.enableRoute(kmlFile);
    }
  }

  /**
   * Show every route in the list
   */
  showAll() {
    $("#routes input").each((_, el) => {
      if (!el.checked) {
        el.checked = true;
        this.enableRoute(el.value);
      }
    });
  }

  /**
   * Hide every route
   */
  clearAll() {
    $("#routes input, #geojsonRoutes input").each((_, el) => {
      el.checked = false;
    });
    this.layers.forEach((layer) => layer.setVisible(false));
    this.geojsonLayers.forEach((layer) => layer.setVisible(false));
    this.hideLoading(null, true);
  }

  /**
   * Setup route controls and event handlers
   */
  setupRouteControls() {
    $("#routes").on("click", "input", (e) => {
      try {
        this.toggleRoute(e.target.value);
      } catch (error) {
        APP.MapUtils.handleError(error, "Route toggle");
        this.hideLoading(null, true);
      }
    });

    $("#geojsonRoutes").on("click", "input", (e) => {
      try {
        this.toggleGeojson(e.target.value);
      } catch (error) {
        APP.MapUtils.handleError(error, "GeoJSON toggle");
        this.hideLoading(null, true);
      }
    });

    $("#showAll").on("click", () => this.showAll());
    $("#clearAll").on("click", () => this.clearAll());
  }

  /**
   * Populate the year picker from /data/years, then load the default year's
   * routes. Falls back to the server default if the list can't be fetched.
   */
  setupYearControl() {
    const sel = $("#dataYear");
    sel.on("change", (e) => this.setYear(e.target.value));
    fetch("/data/years")
      .then((r) => r.json())
      .then(({ years, default: def }) => {
        sel.empty();
        years.forEach((y) =>
          sel.append($("<option></option>").val(y).text(y))
        );
        this.year = def || (years && years[0]) || null;
        sel.val(this.year);
        this.loadRouteList();
        this.loadGeojsonList();
      })
      .catch(() => {
        // No picker data — just load whatever the server defaults to.
        this.loadRouteList();
        this.loadGeojsonList();
      });
  }

  /**
   * Switch the active dataset year: drop all cached layers and rebuild the list.
   * @param {string} year
   */
  setYear(year) {
    if (year === this.year) {
      return;
    }
    this.year = year;
    // Layers/colors are year-specific — remove and clear so nothing leaks across.
    this.layers.forEach((layer) => this.map.removeLayer(layer));
    this.layers.clear();
    this.colors.clear();
    this.geojsonLayers.forEach((layer) => this.map.removeLayer(layer));
    this.geojsonLayers.clear();
    this.geojsonColors.clear();
    this.hideLoading(null, true);
    $("#routes").empty();
    $("#geojsonRoutes").empty();
    this.loadRouteList();
    this.loadGeojsonList();
  }

  /**
   * Load route list from JSON and build the colored legend/toggles
   */
  /** Build a KML route row (checkbox + swatch + name + edit pencil). */
  _buildKmlRow(file, color, displayName, isUser) {
    const label = $("<label></label>").addClass("list-group-item route-item");
    if (isUser) label.addClass("user-route");
    const input = $('<input type="checkbox">').val(file);
    const swatch = $('<span class="route-swatch"></span>').css(
      "background-color",
      color
    );
    const name = $('<span class="route-name"></span>').text(displayName);
    const edit = $('<a class="route-edit-btn" title="Edit route">✏</a>')
      .attr({ "data-file": file, "data-kind": "kml" });
    return label.append(input).append(swatch).append(name).append(edit);
  }

  loadRouteList() {
    const yq = this.yearQuery();
    Promise.all([
      fetch(`/data/routes.json${yq}`).then((r) => r.json()),
      fetch(`/data/user-routes${yq}`).then((r) => r.json()).catch(() => []),
      fetch(`/data/edit-names${yq}`).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([routes, userRoutes, names]) => {
        const output = $("#routes").empty();
        const palette = APP.ROUTE_COLORS;
        let i = 0;
        const add = (file, isUser) => {
          const color = palette[i++ % palette.length];
          this.colors.set(file, color);
          output.append(
            this._buildKmlRow(file, color, names[file] || file.replace(".kml", ""), isUser)
          );
        };
        (routes || []).forEach((f) => add(f, false));
        (userRoutes || []).forEach((f) => add(f, true));
        // New-route creation is only offered for the user-route year.
        $("#newRouteBtn").toggle(this.year === "2026");
      })
      .catch((error) => APP.MapUtils.handleError(error, "Loading routes"));
  }

  /** Append a row for a newly created user route and check it on. */
  addUserRouteRow(file, displayName) {
    if ($("#routes input").filter((_, el) => el.value === file).length) {
      this.setRouteDisplayName(file, displayName, "kml");
      return;
    }
    const palette = APP.ROUTE_COLORS;
    const color = palette[this.colors.size % palette.length];
    this.colors.set(file, color);
    const row = this._buildKmlRow(file, color, displayName, true);
    row.find("input").prop("checked", true);
    $("#routes").append(row);
  }

  /** Remove a user route's row, layer, and color after it is deleted. */
  removeRouteRow(file, kind = "kml") {
    const cache = this._layerFor(file, kind);
    const layer = cache.get(file);
    if (layer) {
      this.map.removeLayer(layer);
      cache.delete(file);
    }
    this.colors.delete(file);
    const listSel = kind === "geojson" ? "#geojsonRoutes" : "#routes";
    $(`${listSel} input`)
      .filter((_, el) => el.value === file)
      .closest("label")
      .remove();
  }

  /**
   * Load the GeoJSON path overlay list for the active year (hidden if none).
   */
  loadGeojsonList() {
    const section = $("#geojsonSection");
    Promise.all([
      fetch(`/data/geojson-list${this.yearQuery()}`).then((r) => r.json()),
      fetch(`/data/edit-names${this.yearQuery()}`).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([files, names]) => {
        const output = $("#geojsonRoutes").empty();
        if (!files || !files.length) {
          section.hide();
          return;
        }
        files.forEach((file, index) => {
          const color = APP.ROUTE_COLORS[index % APP.ROUTE_COLORS.length];
          this.geojsonColors.set(file, color);

          const label = $("<label></label>").addClass("list-group-item route-item");
          const input = $('<input type="checkbox">').val(file);
          const swatch = $('<span class="route-swatch"></span>').css(
            "background-color",
            color
          );
          const name = $('<span class="route-name"></span>').text(
            names[file] || file.replace(".geojson", "")
          );
          const edit = $('<a class="route-edit-btn" title="Edit path">✏</a>')
            .attr({ "data-file": file, "data-kind": "geojson" });
          label.append(input).append(swatch).append(name).append(edit);
          output.append(label);
        });
        section.show();
      })
      .catch(() => section.hide());
  }

  /**
   * Build a dashed GeoJSON path layer (distinct from the solid KML routes).
   * @param {string} file - GeoJSON file name
   * @returns {ol.layer.Vector}
   */
  createGeojsonLayer(file) {
    const color = this.geojsonColors.get(file) || "#111";
    const source = new ol.source.Vector({
      url: `/data/geojson/${file}${this.yearQuery()}`,
      format: new ol.format.GeoJSON({
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
    const layer = new ol.layer.Vector({
      source: source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: color, width: 3, lineDash: [6, 6] }),
      }),
    });
    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading GeoJSON: ${file}`);
      this.hideLoading(file);
    });
    source.on("change", () => {
      if (source.getState() === "ready") {
        if (source.getFeatures().length > 0 && layer.getVisible()) {
          this.maybeZoomTo(layer);
        }
        this.hideLoading(file);
      }
    });
    return layer;
  }

  /**
   * Toggle a GeoJSON path overlay on/off (caches the layer for instant re-show).
   * @param {string} file - GeoJSON file name
   */
  toggleGeojson(file) {
    let layer = this.geojsonLayers.get(file);
    if (layer) {
      const visible = !layer.getVisible();
      layer.setVisible(visible);
      if (visible) {
        this.maybeZoomTo(layer);
      } else {
        this.hideLoading(file);
      }
      return;
    }
    this.showLoading(file);
    layer = this.createGeojsonLayer(file);
    this.geojsonLayers.set(file, layer);
    this.map.addLayer(layer);
  }

  // --- Editor coordination ---------------------------------------------------

  /**
   * Layer cache + checkbox for a file (kind = "kml" | "geojson").
   */
  _layerFor(file, kind) {
    return kind === "geojson" ? this.geojsonLayers : this.layers;
  }

  /**
   * Drop a route's cached layer and re-show it if its checkbox is on, forcing a
   * fresh fetch (so saved edits / reverts appear on the map). Cache-busted.
   * @param {string} file
   * @param {string} kind - "kml" | "geojson"
   */
  reloadRoute(file, kind = "kml") {
    const cache = this._layerFor(file, kind);
    const layer = cache.get(file);
    if (layer) {
      this.map.removeLayer(layer);
      cache.delete(file);
    }
    const checked = $(`#${kind === "geojson" ? "geojsonRoutes" : "routes"} input`)
      .filter((_, el) => el.value === file)
      .prop("checked");
    if (checked) {
      if (kind === "geojson") {
        this.toggleGeojson(file);
      } else {
        this.enableRoute(file);
      }
    }
  }

  /**
   * Update a route row's displayed name in the sidebar (after a rename).
   */
  setRouteDisplayName(file, name, kind = "kml") {
    const listSel = kind === "geojson" ? "#geojsonRoutes" : "#routes";
    const fallback = file.replace(/\.(kml|geojson)$/, "");
    $(`${listSel} input`)
      .filter((_, el) => el.value === file)
      .siblings(".route-name")
      .text(name || fallback);
  }

  /**
   * Hide a route's read-only layer while it is being edited (avoids duplicates).
   */
  hideRouteForEdit(file, kind = "kml") {
    const layer = this._layerFor(file, kind).get(file);
    if (layer) {
      layer.setVisible(false);
    }
  }

  /**
   * Restore a route's read-only layer after editing, if its checkbox is on.
   */
  showRouteAfterEdit(file, kind = "kml") {
    const layer = this._layerFor(file, kind).get(file);
    const checked = $(`#${kind === "geojson" ? "geojsonRoutes" : "routes"} input`)
      .filter((_, el) => el.value === file)
      .prop("checked");
    if (layer && checked) {
      layer.setVisible(true);
    }
  }
};
